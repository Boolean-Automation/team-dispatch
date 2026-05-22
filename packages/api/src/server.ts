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

  // ── Health check ─────────────────────────────────────────────────────────────
  fastify.get("/health", async () => ({ ok: true }));

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
