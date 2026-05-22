// dispatch — POST /api/audit/launcher-fired route
//
// Phase 2 / Slice 4 — Codex F5 binding. Server-side hash-only audit log for
// terminal launcher button clicks.
//
// Auth class: (a) requireClerkSession — Clerk session JWT.
//
// CONTRACT (load-bearing):
//   - The web client computes SHA-256(command) via crypto.subtle BEFORE
//     posting. The raw command itself NEVER leaves the SE's browser.
//   - The server REJECTS any body whose command_hash is not exactly 64
//     lowercase/uppercase hex characters — defensive against a buggy client
//     accidentally posting a raw command string.
//   - The web caller fires-and-forgets — failure here MUST NOT block the
//     launcher's keystroke macro on the browser side. The launcher is the
//     user-visible behavior; the audit log is operator-side hygiene.
//
// SHAPE:
//   request body:  { ticket_display_id: string, command_hash: string, label: string }
//   response 204:  no body, success
//   response 400:  { error, message, statusCode } — body failed validation
//   response 401:  { error, message, statusCode } — no/invalid Clerk session
//   response 429:  { error, message, statusCode } — rate-limit (10/min/user)
//   response 500:  { error, message, statusCode } — DB insert failed
//
// RATE LIMIT:
//   The companion-session mint route has the same per-user 10/min sliding-
//   window limiter. The launcher is a click-driven UI event — an SE clicking
//   it >10 times/min is either testing or wedged; either way the audit row
//   loss is acceptable for the pilot. The shell-typing path is unaffected.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { requireClerkSession } from "../../plugins/clerk-auth.js";
import { auditLauncherFired } from "@dispatch/db";

// ── Config ───────────────────────────────────────────────────────────────────

/** Per-user mint rate limit: max launcher-fired posts inside the window. */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ── Zod body schema ──────────────────────────────────────────────────────────
//
// command_hash MUST be 64 hex chars (SHA-256 hex digest). A 64-char string
// that contains a non-hex byte is rejected — that's what catches an
// accidentally-leaked raw command (a raw "claude" would be 6 chars, fail
// length; a 64-char raw command would fail the regex). This is a
// defense-in-depth assert, not the security boundary.

const launcherFiredBody = z.object({
  ticket_display_id: z.string().min(1).max(64),
  command_hash: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]+$/i),
  label: z.string().max(64),
});

// ── In-process rate limiter (per-user sliding window) ────────────────────────

const fireTimestamps = new Map<string, number[]>();

/** Reset the rate-limiter — test-only. */
export function _resetLauncherAuditRateLimit(): void {
  fireTimestamps.clear();
}

function rateLimited(userId: string, now: number): boolean {
  const recent = (fireTimestamps.get(userId) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    fireTimestamps.set(userId, recent);
    return true;
  }
  recent.push(now);
  fireTimestamps.set(userId, recent);
  return false;
}

// ── Route ────────────────────────────────────────────────────────────────────

export default async function launcherAuditRoutes(
  fastify: FastifyInstance
): Promise<void> {
  fastify.post(
    "/api/audit/launcher-fired",
    { preHandler: [requireClerkSession] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.auth.userId;
      const now = Date.now();

      if (rateLimited(userId, now)) {
        return reply.status(429).send({
          error: "Too Many Requests",
          message: "Launcher audit rate limit exceeded",
          statusCode: 429,
        });
      }

      const parsed = launcherFiredBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Bad Request",
          message: parsed.error.issues[0]?.message ?? "Invalid request body",
          statusCode: 400,
        });
      }

      try {
        await fastify.db.insert(auditLauncherFired).values({
          userId,
          ticketDisplayId: parsed.data.ticket_display_id,
          commandHash: parsed.data.command_hash.toLowerCase(),
          label: parsed.data.label,
        });
      } catch (err) {
        request.log.error(
          { err, userId },
          "audit_launcher_fired insert failed"
        );
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to record audit event",
          statusCode: 500,
        });
      }

      return reply.status(204).send();
    }
  );
}
