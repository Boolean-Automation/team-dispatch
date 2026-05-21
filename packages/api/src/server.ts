// dispatch — Fastify server entry point
//
// Serves:
//   /api/*  — the dispatch HTTP API (thin layer over packages/core)
//   /*      — the built packages/web/dist SPA (static files, Slice 3+)
//
// Slice 2 wires: error-handler, clerk-auth plugin, GET /api/me.
// Slices 3–8 register additional route modules here.

import Fastify from "fastify";
import errorHandlerPlugin from "./plugins/error-handler.js";
import clerkAuthPlugin from "./plugins/clerk-auth.js";
import meRoutes from "./routes/me.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === "test" ? "silent" : "info",
    },
  });

  // ── Plugins ──────────────────────────────────────────────────────────────────
  await fastify.register(errorHandlerPlugin);
  await fastify.register(clerkAuthPlugin);

  // ── Routes ────────────────────────────────────────────────────────────────────
  await fastify.register(meRoutes);

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
}
