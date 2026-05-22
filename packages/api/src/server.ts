// dispatch — Fastify server entry point
//
// Serves:
//   /api/*  — the dispatch HTTP API (thin layer over packages/core)
//   /*      — the built packages/web/dist SPA (static files, Slice 3+)
//
// Slice 2 wires: error-handler, clerk-auth plugin, GET /api/me.
// Slice 3 wires: db plugin, tickets/accounts/contacts read routes.
// Slice 4 wires: raw-body plugin, ingestion/undo/notifications/activity routes.
// Slice 5 wires: messages route, accounts highlights endpoint, outbox worker.
// Slice 7 wires: internal-thread, reassignment, reinforcement routes.

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import errorHandlerPlugin from "./plugins/error-handler.js";
import helmetPlugin from "./plugins/helmet.js";
import cspPlugin from "./plugins/csp.js";
import rawBodyPlugin from "./plugins/raw-body.js";
import clerkAuthPlugin from "./plugins/clerk-auth.js";
import dbPlugin from "./plugins/db.js";
import meRoutes from "./routes/me.js";
import ticketRoutes from "./routes/tickets.js";
import accountRoutes from "./routes/accounts.js";
import contactRoutes from "./routes/contacts.js";
import ingestionRoutes from "./routes/ingestion.js";
import undoRoutes from "./routes/undo.js";
import notificationRoutes from "./routes/notifications.js";
import activityRoutes from "./routes/activity.js";
import messageRoutes from "./routes/messages.js";
import internalThreadRoutes from "./routes/internal-thread.js";
import reassignmentRoutes from "./routes/reassignment.js";
import reinforcementRoutes from "./routes/reinforcements.js";
import mcpRoutes from "./routes/mcp.js";
import companionRoutes from "./routes/companion.js";
import launcherAuditRoutes from "./routes/audit/launcher.js";
import { startOutboxWorker } from "./jobs/outbox-worker.js";
import { startSlaTimer } from "./jobs/sla-timer.js";
import type { Db } from "@dispatch/db";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

interface BuildServerOptions {
  /** Inject a pre-built db for tests. If omitted, reads DATABASE_URL. */
  db?: Db;
}

export async function buildServer(opts: BuildServerOptions = {}) {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === "test" ? "silent" : "info",
    },
  });

  // ── Plugins ──────────────────────────────────────────────────────────────────
  await fastify.register(errorHandlerPlugin);
  // Slice 0: SPA-wide security headers must land BEFORE any route or static
  // handler. helmet first (Strict-Transport-Security, X-Content-Type-Options,
  // Cross-Origin-Opener-Policy, …); csp second (Content-Security-Policy +
  // nonce minting + onSend HTML rewrite). The csp plugin sets the header on
  // EVERY response — including this server's API JSON responses — which is
  // intentional defense-in-depth.
  await fastify.register(helmetPlugin);
  await fastify.register(cspPlugin);
  // raw-body must be registered BEFORE clerk-auth and routes that need rawBody
  await fastify.register(rawBodyPlugin);
  await fastify.register(clerkAuthPlugin);
  await fastify.register(dbPlugin, { db: opts.db });

  // ── Routes ────────────────────────────────────────────────────────────────────
  await fastify.register(meRoutes);
  await fastify.register(ticketRoutes);
  await fastify.register(accountRoutes);
  await fastify.register(contactRoutes);
  // Slice 4 routes
  await fastify.register(ingestionRoutes);
  await fastify.register(undoRoutes);
  await fastify.register(notificationRoutes);
  await fastify.register(activityRoutes);
  // Slice 5 routes
  await fastify.register(messageRoutes);
  // Slice 7 routes
  await fastify.register(internalThreadRoutes);
  await fastify.register(reassignmentRoutes);
  await fastify.register(reinforcementRoutes);
  // Slice 8 — MCP-facing read routes (machine-credential auth, class d)
  await fastify.register(mcpRoutes);
  // Spike #1 — Companion connection-session mint route (Clerk session auth)
  await fastify.register(companionRoutes);
  // Phase 2 / Slice 4 — terminal launcher fire audit (Codex F5)
  await fastify.register(launcherAuditRoutes);

  // ── Health check ─────────────────────────────────────────────────────────────
  fastify.get("/health", async () => ({ ok: true }));

  // ── SPA static serve + fallback ──────────────────────────────────────────────
  //
  // Codex post-qa P1 fix: prior to this wiring, the api process registered
  // helmet + csp + JSON routes + /health, but did NOT serve the built React
  // SPA at packages/web/dist. As a result, GET / returned a JSON 404 (with
  // CSP applied to the error body, but no SPA HTML for nonces to land on).
  //
  // Two-handler design — chosen because the CSP plugin's onSend HTML rewrite
  // only consumes string + Buffer payloads (csp.ts:200-208). @fastify/static
  // serves files as a `PassThrough` stream by default, which the rewrite
  // would skip — leaving the served SPA shell without the per-request
  // nonce in <meta name="csp-nonce"> or on any <script>/<link
  // rel="stylesheet"> tag. Splitting the responsibility:
  //
  //   - @fastify/static handles /assets/* (CSS/JS bundles) — these are NOT
  //     HTML, so the CSP nonce rewrite doesn't apply anyway; streaming is
  //     fine and faster.
  //   - The /index.html + SPA-route fallback is served by a small handler
  //     that fs.readFileSync's the file into a Buffer, so the CSP onSend
  //     hook receives a Buffer payload, calls injectNonces(), and the
  //     response carries the nonce on every tag.
  //
  // After this block:
  //   - GET /assets/*       — fastify-static (streamed, CSS/JS).
  //   - GET /               — Buffer-based index.html with CSP nonces.
  //   - GET /t/<id>, /settings, /analytics, etc. — fallback to index.html
  //     so React Router can take over client-side.
  //   - GET /api/* unknown  — JSON 404 (the SPA shouldn't shadow API misses).
  //   - GET /health, /metrics on miss — JSON 404.
  //
  // Path resolution: __dirname for this module resolves to packages/api/src
  // (tsx in dev / vitest) or packages/api/dist (built). `../../web/dist` is
  // the same relative jump in either case, so the static root works in dev,
  // tests, and the Dockerfile runtime stage.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const webDistRoot = path.resolve(__dirname, "..", "..", "web", "dist");
  const indexHtmlPath = path.join(webDistRoot, "index.html");

  // Serve /assets/* via fastify-static. We intentionally narrow the prefix
  // (NOT root "/") so the static handler doesn't serve index.html or shadow
  // other routes — only versioned, content-hashed asset bundles. Vite emits
  // every script/CSS bundle under /assets/.
  if (fs.existsSync(path.join(webDistRoot, "assets"))) {
    await fastify.register(fastifyStatic, {
      root: path.join(webDistRoot, "assets"),
      prefix: "/assets/",
      wildcard: true,
      decorateReply: false,
    });
  }

  // Other top-level static directories Vite may emit (fonts, images,
  // favicons). Register additively with non-conflicting prefixes so the
  // SPA fallback below still wins on /, /t/<id>, etc.
  if (fs.existsSync(path.join(webDistRoot, "fonts"))) {
    await fastify.register(fastifyStatic, {
      root: path.join(webDistRoot, "fonts"),
      prefix: "/fonts/",
      wildcard: true,
      decorateReply: false,
    });
  }

  // SPA HTML handler — read as a Buffer so the CSP onSend hook can rewrite
  // it with per-request nonces. Falls back gracefully when the dist artifact
  // is missing (e.g. dev mode where Vite serves the SPA on a separate port).
  const serveSpaHtml = (
    _req: { url: string },
    reply: {
      code: (n: number) => { send: (b: unknown) => unknown };
      type: (s: string) => { send: (b: Buffer) => unknown };
    }
  ) => {
    let indexBuf: Buffer;
    try {
      indexBuf = fs.readFileSync(indexHtmlPath);
    } catch {
      return reply.code(503).send({ error: "spa-not-built" });
    }
    return reply.type("text/html; charset=UTF-8").send(indexBuf);
  };

  // Direct /index.html + / mappings — explicit routes so a client GET on
  // either path takes the buffered handler.
  fastify.get("/", serveSpaHtml);
  fastify.get("/index.html", serveSpaHtml);

  // SPA-route fallback — any non-/api/, non-/health, non-/metrics GET that
  // doesn't match a known route serves the SPA shell so React Router can
  // resolve the URL client-side.
  fastify.setNotFoundHandler((req, reply) => {
    // HEAD requests on SPA routes get the same shell handler — the
    // response body is dropped by the server but the headers (CSP +
    // text/html + content-length) still need to reflect the GET payload.
    const isReadable = req.method === "GET" || req.method === "HEAD";
    if (
      !isReadable ||
      req.url.startsWith("/api/") ||
      req.url === "/health" ||
      req.url === "/metrics" ||
      req.url.startsWith("/assets/") ||
      req.url.startsWith("/fonts/")
    ) {
      return reply.code(404).send({ error: "not found" });
    }
    return serveSpaHtml(req, reply as unknown as Parameters<typeof serveSpaHtml>[1]);
  });

  return fastify;
}

// Only start listening when this file is the main entry point (not in tests)
const isMain =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname ===
    new URL(process.argv[1], import.meta.url).pathname;

if (isMain) {
  const server = await buildServer();
  await server.listen({ port: PORT, host: HOST });
  server.log.info(`dispatch api listening on ${HOST}:${PORT}`);

  // Start the outbox worker after the server is listening.
  // Only in the main process — not in tests (tests don't call buildServer from isMain).
  startOutboxWorker(server.db);

  // Start the SLA timer cron job (Slice 6).
  // Runs every 5 minutes; only advances tickets during business hours (6am–5pm PT).
  startSlaTimer(server.db);
}
