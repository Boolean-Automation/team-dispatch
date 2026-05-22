// dispatch — POST /api/audit/launcher-fired integration tests.
//
// Phase 2 / Slice 4 — Codex F5 binding.
//
// Tests (binding from the slice plan):
//  1. 204 on valid POST (auth + hashed body + label) → row appears in
//     audit_launcher_fired with the right shape.
//  2. 400 on bad command_hash (not 64 hex chars).
//  3. 400 on raw-command-style hash (looks like a command, not a digest).
//  4. 401 on no Clerk session.
//  5. Rate-limit kicks in after 10/min/user (429).
//  6. Lowercase normalization — uppercase hex still stored lower.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
} from "../src/plugins/clerk-auth.js";
import { _resetLauncherAuditRateLimit } from "../src/routes/audit/launcher.js";
import { createDb } from "../../db/src/client.js";
import { auditLauncherFired } from "../../db/src/schema.js";
import { eq, desc } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

const TEST_USER_ID = "user_test_launcher_audit";

// SHA-256("claude") — canonical default-launcher hash for fixtures.
// node -e "console.log(require('crypto').createHash('sha256').update('claude').digest('hex'))"
const CLAUDE_HASH =
  "c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d";
// Any 64-hex string works for non-default fixtures.
const SAMPLE_HASH_A =
  "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef";

function mockClerkVerifier(token: string) {
  if (token === "valid-token") {
    return Promise.resolve({
      sub: TEST_USER_ID,
      public_metadata: { role: "se" },
    });
  }
  return Promise.reject(new Error("invalid token"));
}

let fastify: Awaited<ReturnType<typeof buildServer>>;
const db = createDb(DATABASE_URL);

beforeAll(async () => {
  _setClerkVerifierForTest(mockClerkVerifier as never);
  fastify = await buildServer({ db });
  await fastify.ready();
});

afterAll(async () => {
  _resetClerkVerifier();
  await db
    .delete(auditLauncherFired)
    .where(eq(auditLauncherFired.userId, TEST_USER_ID));
  await fastify.close();
});

beforeEach(async () => {
  _resetLauncherAuditRateLimit();
  await db
    .delete(auditLauncherFired)
    .where(eq(auditLauncherFired.userId, TEST_USER_ID));
});

describe("POST /api/audit/launcher-fired", () => {
  it("returns 204 on a valid POST and writes the audit row", async () => {
    const res = await request(fastify.server)
      .post("/api/audit/launcher-fired")
      .set("Authorization", "Bearer valid-token")
      .send({
        ticket_display_id: "DSP-2841",
        command_hash: CLAUDE_HASH,
        label: "Claude",
      });

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const rows = await db
      .select()
      .from(auditLauncherFired)
      .where(eq(auditLauncherFired.userId, TEST_USER_ID))
      .orderBy(desc(auditLauncherFired.firedAt));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe(TEST_USER_ID);
    expect(row.ticketDisplayId).toBe("DSP-2841");
    expect(row.commandHash).toBe(CLAUDE_HASH);
    expect(row.label).toBe("Claude");
    expect(row.firedAt).toBeInstanceOf(Date);
  });

  it("returns 400 when command_hash is not 64 hex chars (length)", async () => {
    const res = await request(fastify.server)
      .post("/api/audit/launcher-fired")
      .set("Authorization", "Bearer valid-token")
      .send({
        ticket_display_id: "DSP-2841",
        command_hash: "deadbeef", // too short
        label: "Claude",
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 when command_hash contains non-hex bytes (raw command leak)", async () => {
    // A 64-char raw command (or anything with letters past f) is rejected —
    // this is the defensive assert that a buggy client can't accidentally
    // post a raw command in the hash slot.
    const res = await request(fastify.server)
      .post("/api/audit/launcher-fired")
      .set("Authorization", "Bearer valid-token")
      .send({
        ticket_display_id: "DSP-2841",
        command_hash:
          "claude --some-flag arg arg arg arg arg arg arg arg arg arg arg ar", // 64 chars but not hex
        label: "Claude",
      });

    expect(res.status).toBe(400);

    // Confirm nothing was written.
    const rows = await db
      .select()
      .from(auditLauncherFired)
      .where(eq(auditLauncherFired.userId, TEST_USER_ID));
    expect(rows).toHaveLength(0);
  });

  it("returns 400 when ticket_display_id is empty", async () => {
    const res = await request(fastify.server)
      .post("/api/audit/launcher-fired")
      .set("Authorization", "Bearer valid-token")
      .send({
        ticket_display_id: "",
        command_hash: CLAUDE_HASH,
        label: "Claude",
      });

    expect(res.status).toBe(400);
  });

  it("returns 401 when no Clerk session is presented", async () => {
    const res = await request(fastify.server)
      .post("/api/audit/launcher-fired")
      .send({
        ticket_display_id: "DSP-2841",
        command_hash: CLAUDE_HASH,
        label: "Claude",
      });

    expect(res.status).toBe(401);
  });

  it("normalizes uppercase hex to lowercase before storing", async () => {
    const res = await request(fastify.server)
      .post("/api/audit/launcher-fired")
      .set("Authorization", "Bearer valid-token")
      .send({
        ticket_display_id: "DSP-2841",
        command_hash: SAMPLE_HASH_A.toUpperCase(),
        label: "codex",
      });

    expect(res.status).toBe(204);

    const rows = await db
      .select()
      .from(auditLauncherFired)
      .where(eq(auditLauncherFired.userId, TEST_USER_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commandHash).toBe(SAMPLE_HASH_A);
  });

  it("rate-limits a user past the per-window cap (429 after 10/min)", async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 15; i++) {
      const res = await request(fastify.server)
        .post("/api/audit/launcher-fired")
        .set("Authorization", "Bearer valid-token")
        .send({
          ticket_display_id: "DSP-2841",
          command_hash: CLAUDE_HASH,
          label: "Claude",
        });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
