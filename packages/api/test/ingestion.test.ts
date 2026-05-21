// dispatch — ingestion API integration tests (FIX 3)
//
// Tests:
//   1. Unsigned request to /api/ingest/slack is rejected (401).
//   2. Request with a stale timestamp is rejected (401).
//   3. Validly-signed Slack request is accepted with NO Clerk session.
//   4. url_verification handshake is handled correctly.
//   5. POST /api/ingest/stub requires Clerk-admin auth.
//
// Auth class (b) — Slack HMAC signature verification, no Clerk session.

import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
  _setSlackSigningSecretForTest,
  _resetSlackSigningSecret,
} from "../src/plugins/clerk-auth.js";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages, auditLog, notifications } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

const TEST_SIGNING_SECRET = "test_signing_secret_abc123";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSlackSignature(
  secret: string,
  timestamp: string,
  body: string
): string {
  const sigBasestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(sigBasestring, "utf8")
    .digest("hex");
  return `v0=${hmac}`;
}

function validTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let testAccountId: string;

const db = createDb(DATABASE_URL);

beforeAll(async () => {
  _setSlackSigningSecretForTest(TEST_SIGNING_SECRET);
  _setClerkVerifierForTest(async (token: string) => {
    if (token === "valid-admin-token") {
      return { sub: "user_ingest_admin", public_metadata: { role: "admin" } };
    }
    if (token === "valid-se-token") {
      return { sub: "user_ingest_se", public_metadata: { role: "se" } };
    }
    throw new Error("invalid token");
  });

  // Seed a test account with a channel for ingestion
  const inserted = await db
    .insert(accounts)
    .values({
      slug: `ingest-api-test-${Date.now()}`,
      displayName: "Ingestion API Test Account",
      slackChannelIds: ["C_INGEST_API_001"],
      health: "good",
    })
    .returning();
  testAccountId = inserted[0]!.id;

  app = await buildServer({ db });
  await app.ready();
});

afterAll(async () => {
  _resetSlackSigningSecret();
  _resetClerkVerifier();

  // Cleanup
  const testTickets = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.accountId, testAccountId));

  for (const t of testTickets) {
    await db.delete(notifications).where(eq(notifications.ticketId, t.id));
    await db.delete(auditLog).where(eq(auditLog.ticketId, t.id));
    await db.delete(messages).where(eq(messages.ticketId, t.id));
  }

  await db.delete(tickets).where(eq(tickets.accountId, testAccountId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));

  await app.close();
});

// ── Tests: /api/ingest/slack ──────────────────────────────────────────────────

describe("POST /api/ingest/slack — signature verification (FIX 3)", () => {
  it("rejects unsigned request with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/slack",
      payload: { type: "event_callback", event: { type: "message" } },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects request with missing timestamp header with 401", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const timestamp = validTimestamp();
    const sig = makeSlackSignature(TEST_SIGNING_SECRET, timestamp, body);

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/slack",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": sig,
        // No x-slack-request-timestamp
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects request with a stale timestamp (> 5 min old)", async () => {
    const staleTs = (Math.floor(Date.now() / 1000) - 400).toString(); // 6+ min ago
    const body = JSON.stringify({ type: "event_callback" });
    const sig = makeSlackSignature(TEST_SIGNING_SECRET, staleTs, body);

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/slack",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": sig,
        "x-slack-request-timestamp": staleTs,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects request with a wrong signing secret", async () => {
    const timestamp = validTimestamp();
    const body = JSON.stringify({ type: "event_callback" });
    const wrongSig = makeSlackSignature("wrong_secret", timestamp, body);

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/slack",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": wrongSig,
        "x-slack-request-timestamp": timestamp,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a validly-signed request with NO Clerk session", async () => {
    const timestamp = validTimestamp();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "test_challenge_abc",
    });
    const sig = makeSlackSignature(TEST_SIGNING_SECRET, timestamp, body);

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/slack",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": sig,
        "x-slack-request-timestamp": timestamp,
        // No Authorization header — no Clerk session
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ challenge: string }>();
    expect(json.challenge).toBe("test_challenge_abc");
  });

  it("handles url_verification handshake and returns challenge", async () => {
    const timestamp = validTimestamp();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "my_challenge_xyz",
      token: "verification_token",
    });
    const sig = makeSlackSignature(TEST_SIGNING_SECRET, timestamp, body);

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/slack",
      headers: {
        "Content-Type": "application/json",
        "x-slack-signature": sig,
        "x-slack-request-timestamp": timestamp,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ challenge: string }>();
    expect(json.challenge).toBe("my_challenge_xyz");
  });
});

// ── Tests: /api/ingest/stub ───────────────────────────────────────────────────

describe("POST /api/ingest/stub — requires Clerk-admin auth", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/stub",
      payload: { channelId: "C_TEST" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a non-admin session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/stub",
      headers: { Authorization: "Bearer valid-se-token" },
      payload: { channelId: "C_TEST" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts an admin session and creates a ticket", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/stub",
      headers: { Authorization: "Bearer valid-admin-token" },
      payload: {
        channelId: "C_STUB_UNKNOWN_001",
        body: "Stub test message",
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json<{ ok: boolean; result: { kind: string } }>();
    expect(json.ok).toBe(true);
    expect(json.result.kind).toBe("ticket-created");
  });
});
