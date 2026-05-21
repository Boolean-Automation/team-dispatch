// dispatch — POST /api/companion/sessions route
//
// The API-first touchpoint for the Companion bridge (Spike #1, OQ-S3).
// The dispatch backend mints the scoped, short-lived, single-use HS256
// connection token the Companion (packages/companion) verifies.
//
// Auth class: (a) requireClerkSession — Clerk session JWT.
//
// Why a non-cacheable POST, not a broad GET (Codex P1-2 / spec §3.1.2):
// a bearer credential that opens a PTY on the SE's machine is an RCE-grade
// capability. It is too dangerous for a cacheable, broad GET. The route:
//   - is a POST that mints a FRESH session credential per call;
//   - returns `Cache-Control: no-store`;
//   - binds the token to FIVE claims — Clerk user id, ticket id, the
//     intended Origin/audience, a unique session id, and a short TTL (~60s);
//   - AUTHORIZES that the calling user may access the requested ticket
//     before minting (a user with no access to the ticket is rejected);
//   - is RATE-LIMITED per user;
//   - emits an AUDIT log line per mint;
//   - NEVER logs the minted token.
//
// The Companion's auth.ts verifies the same token under the shared
// COMPANION_TOKEN_SECRET. The two processes share that secret in the pilot.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { requireClerkSession } from "../plugins/clerk-auth.js";
import { getTicket, getTicketByDisplayId } from "@dispatch/core";

// ── Config ───────────────────────────────────────────────────────────────────

/** Connection-token TTL — short, bounded to roughly one session handshake. */
const TOKEN_TTL_SECONDS = 60;

/** Fixed loopback port the Companion listens on (OQ-S4). */
const COMPANION_PORT = Number(process.env.COMPANION_PORT ?? 7720);

/** Per-user mint rate limit: max mints inside the window. */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ── Request shape ────────────────────────────────────────────────────────────

interface MintBody {
  /** The ticket the Companion session is being opened for. UUID or DSP- id. */
  ticketId?: string;
  /** The dispatch web app Origin the token is minted for (audience binding). */
  origin?: string;
}

// ── In-process rate limiter (spike-appropriate; per-user sliding window) ─────

const mintTimestamps = new Map<string, number[]>();

/** Reset the rate-limiter — test-only. */
export function _resetCompanionRateLimit(): void {
  mintTimestamps.clear();
}

function rateLimited(userId: string, now: number): boolean {
  const recent = (mintTimestamps.get(userId) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    mintTimestamps.set(userId, recent);
    return true;
  }
  recent.push(now);
  mintTimestamps.set(userId, recent);
  return false;
}

// ── Route ────────────────────────────────────────────────────────────────────

export default async function companionRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/companion/sessions",
    { preHandler: [requireClerkSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secret = process.env.COMPANION_TOKEN_SECRET;
      if (!secret || secret.trim().length === 0) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "COMPANION_TOKEN_SECRET not configured",
          statusCode: 500,
        });
      }

      const userId = request.auth.userId;
      const body = (request.body ?? {}) as MintBody;
      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);

      // Validate the request shape.
      if (typeof body.ticketId !== "string" || body.ticketId.length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "ticketId is required",
          statusCode: 400,
        });
      }
      if (typeof body.origin !== "string" || body.origin.length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "origin is required",
          statusCode: 400,
        });
      }

      // Rate limit per user — a mint route for an RCE-grade credential must
      // not be hammerable.
      if (rateLimited(userId, now)) {
        return reply.status(429).send({
          error: "Too Many Requests",
          message: "Companion session mint rate limit exceeded",
          statusCode: 429,
        });
      }

      // Authorize: the calling user may only mint a token for a ticket that
      // actually exists. The token is scoped to that ticket; the Companion
      // additionally rejects it if presented for any other ticket (A12d).
      const ticket = body.ticketId.startsWith("DSP-")
        ? await getTicketByDisplayId(fastify.db, body.ticketId)
        : await getTicket(fastify.db, body.ticketId);

      if (!ticket) {
        // A user requesting a ticket they cannot access — for the Phase-1
        // pilot every SE can see every ticket, so "cannot access" reduces to
        // "ticket does not exist". A real per-SE ACL plugs in here in Phase 2.
        return reply.status(403).send({
          error: "Forbidden",
          message: "No access to the requested ticket",
          statusCode: 403,
        });
      }

      // Mint the scoped, short-TTL, single-use token.
      const sessionId = `sess-${crypto.randomBytes(6).toString("hex")}`;
      const jti = crypto.randomUUID();
      const token = jwt.sign(
        {
          sub: userId,
          ticketId: ticket.displayId,
          sessionId,
          aud: body.origin,
          jti,
        },
        secret,
        { algorithm: "HS256", expiresIn: TOKEN_TTL_SECONDS }
      );

      // Audit event per mint — the token VALUE is never logged; the jti is a
      // safe correlation handle.
      request.log.info(
        {
          audit: "companion.session_minted",
          userId,
          ticketId: ticket.displayId,
          sessionId,
          jti,
        },
        "companion session token minted"
      );

      // no-store — a credential that opens a PTY must never be cached.
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        token,
        sessionId,
        port: COMPANION_PORT,
        expiresIn: TOKEN_TTL_SECONDS,
      });
    }
  );
}
