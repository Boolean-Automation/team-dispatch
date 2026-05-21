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

function loadRegistry(): ParsedRegistry {
  const registryPath =
    process.env.REGISTRY_PATH ??
    path.resolve(
      process.cwd(),
      "../../boolean-knowledge/clients/_registry.yaml"
    );

  if (!fs.existsSync(registryPath)) {
    // Return empty registry if file doesn't exist (dev / test without registry)
    return { clients: [], internalChannelIds: [] };
  }
  return parseRegistry(registryPath);
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
