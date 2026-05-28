// dispatch — ingestion routes
//
// POST /api/ingest/slack — Slack Events-API webhook (auth class b: requireSlackSignature)
// POST /api/ingest/stub  — stub/manual event feeder (auth class c: requireClerkAdmin)
//
// plan §Slice 4

import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import fs from "node:fs";
import path from "node:path";
import {
  requireSlackSignature,
  requireClerkAdmin,
} from "../plugins/clerk-auth.js";
import {
  normalizeSlackPayload,
  normalizeStubEvent,
  ingestMessage,
  parseRegistry,
} from "@dispatch/core";
import type { StubEventInput, ParsedRegistry } from "@dispatch/core";

// ── Registry loader ───────────────────────────────────────────────────────────
//
// Stage 1 stopgap: loads the bundled _registry.yaml from REGISTRY_PATH.
// If REGISTRY_PATH is missing:
//   - DISPATCH_REGISTRY_HARD_FAIL=0 (default): silent fallback, empty registry.
//   - DISPATCH_REGISTRY_HARD_FAIL=1: throws, preventing silent mis-routing.
//     Set to 0 for the first 24h post-deploy; flip to 1 after confirming
//     Railway log shows "[dispatch] registry loaded" with clientCount > 0.
//
// Observability: logs "[dispatch] registry loaded" with registryClientCount +
// registryPath on every successful load (packet §Observability).

function loadRegistry(): ParsedRegistry {
  const registryPath =
    process.env.REGISTRY_PATH ??
    path.resolve(
      process.cwd(),
      "../../boolean-knowledge/clients/_registry.yaml"
    );

  if (!fs.existsSync(registryPath)) {
    const hardFail = process.env.DISPATCH_REGISTRY_HARD_FAIL === "1";
    if (hardFail) {
      throw new Error(
        `[dispatch] REGISTRY_PATH not found: ${registryPath} — ` +
          "ingestion aborted (DISPATCH_REGISTRY_HARD_FAIL=1). " +
          "Flip to 0 to resume silent fallback."
      );
    }
    // Silent fallback — every channel will classify as unknown.
    console.warn(
      `[dispatch] registry not found at ${registryPath} — ` +
        "all channels will classify as unknown. " +
        "Set REGISTRY_PATH or DISPATCH_REGISTRY_HARD_FAIL=1 to surface this error."
    );
    return { clients: [], internalChannelIds: [] };
  }

  const registry = parseRegistry(registryPath);

  // Observability: confirm the registry loaded with client count (packet §Observability)
  console.info(JSON.stringify({
    msg: "[dispatch] registry loaded",
    registryClientCount: registry.clients.length,
    registryPath,
  }));

  return registry;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function ingestionRoutes(
  fastify: FastifyInstance
): Promise<void> {
  // POST /api/ingest/slack
  fastify.post(
    "/api/ingest/slack",
    { preHandler: requireSlackSignature },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = request.body as Record<string, unknown>;

      // Normalize the payload
      const normalized = normalizeSlackPayload(payload);

      if (normalized.kind === "url_verification") {
        // Respond to Slack's url_verification handshake
        return reply.send({ challenge: normalized.challenge });
      }

      if (normalized.kind === "ignored") {
        return reply.send({ ok: true, ignored: normalized.reason });
      }

      // Ingest the event
      const registry = loadRegistry();
      const ingestResult = await ingestMessage({
        db: fastify.db,
        event: normalized.event,
        registry,
      });

      return reply.send({ ok: true, result: ingestResult });
    }
  );

  // POST /api/ingest/stub
  fastify.post(
    "/api/ingest/stub",
    { preHandler: requireClerkAdmin },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as Partial<StubEventInput>;

      if (!body.channelId) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "channelId is required",
          statusCode: 400,
        });
      }

      const event = normalizeStubEvent(body as StubEventInput);

      const registry = loadRegistry();
      const ingestResult = await ingestMessage({
        db: fastify.db,
        event,
        registry,
      });

      return reply.send({ ok: true, result: ingestResult });
    }
  );
}
