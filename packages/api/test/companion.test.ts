// dispatch — POST /api/companion/sessions integration tests (Spike #1)
//
// Uses Supertest against a real Fastify instance + real Postgres test DB.
// Auth is bypassed via _setClerkVerifierForTest().
//
// Tests:
//  1. An authed SE with access to the ticket gets a scoped signed token.
//  2. An unauthed request gets 401.
//  3. An authed SE requesting a ticket they cannot access gets 403 (A12e).
//  4. The response carries Cache-Control: no-store (A12e).
//  5. The minted token verifies under the shared secret and carries the
//     user / ticket / origin / session / TTL claims.
//  6. The route is a POST — a GET is rejected (Codex P1-2: not a broad GET).
//  7. The mint route is rate-limited per user (429 past the cap).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
} from "../src/plugins/clerk-auth.js";
import { _resetCompanionRateLimit } from "../src/routes/companion.js";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

const TEST_USER_ID = "user_test_companion_api";
const TOKEN_SECRET = "test-companion-shared-secret-32bytes!!";
const TEST_ORIGIN = "http://localhost:5173";

// ── Mock Clerk verifier ──────────────────────────────────────────────────────

function mockClerkVerifier(token: string) {
  if (token === "valid-token") {
    return Promise.resolve({
      sub: TEST_USER_ID,
      public_metadata: { role: "se" },
    });
  }
  return Promise.reject(new Error("invalid token"));
}

// ── Token claim shape ────────────────────────────────────────────────────────

interface MintedClaims {
  sub: string;
  ticketId: string;
  sessionId: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let testAccountId: string;
let testTicketDisplayId: string;
let fastify: Awaited<ReturnType<typeof buildServer>>;
const db = createDb(DATABASE_URL);

beforeAll(async () => {
  process.env.COMPANION_TOKEN_SECRET = TOKEN_SECRET;
  _setClerkVerifierForTest(mockClerkVerifier as never);

  const accts = await db
    .insert(accounts)
    .values({
      slug: `companion-test-acct-${Date.now()}`,
      displayName: "Companion Test Account",
      emailDomains: ["companiontest.example.com"],
      slackChannelIds: ["C_COMPANION_001"],
      owningSe: TEST_USER_ID,
      health: "good",
    })
    .returning();
  testAccountId = accts[0]!.id;

  const tkts = await db
    .insert(tickets)
    .values({
      accountId: testAccountId,
      status: "new",
      type: "question",
      sourceKind: "channel",
      originClass: "client",
    })
    .returning();
  testTicketDisplayId = tkts[0]!.displayId;

  fastify = await buildServer({ db });
  await fastify.ready();
});

afterAll(async () => {
  _resetClerkVerifier();
  delete process.env.COMPANION_TOKEN_SECRET;
  await db.delete(tickets).where(eq(tickets.accountId, testAccountId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
  await fastify.close();
});

beforeEach(() => {
  _resetCompanionRateLimit();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/companion/sessions", () => {
  it("returns 201 with a scoped signed token for an authed SE with ticket access", async () => {
    const res = await request(fastify.server)
      .post("/api/companion/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ ticketId: testTicketDisplayId, origin: TEST_ORIGIN });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe("string");
    expect(typeof res.body.sessionId).toBe("string");
    expect(res.body.port).toBe(Number(process.env.COMPANION_PORT ?? 7720));
  });

  it("returns 401 for an unauthed request", async () => {
    const res = await request(fastify.server)
      .post("/api/companion/sessions")
      .send({ ticketId: testTicketDisplayId, origin: TEST_ORIGIN });

    expect(res.status).toBe(401);
  });

  it("returns 403 when the SE requests a ticket they cannot access (A12e)", async () => {
    const res = await request(fastify.server)
      .post("/api/companion/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ ticketId: "DSP-999999", origin: TEST_ORIGIN });

    expect(res.status).toBe(403);
  });

  it("returns 400 when ticketId is missing", async () => {
    const res = await request(fastify.server)
      .post("/api/companion/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ origin: TEST_ORIGIN });

    expect(res.status).toBe(400);
  });

  it("returns the response with Cache-Control: no-store (A12e)", async () => {
    const res = await request(fastify.server)
      .post("/api/companion/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ ticketId: testTicketDisplayId, origin: TEST_ORIGIN });

    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("mints a token that verifies under the shared secret with the five claims", async () => {
    const res = await request(fastify.server)
      .post("/api/companion/sessions")
      .set("Authorization", "Bearer valid-token")
      .send({ ticketId: testTicketDisplayId, origin: TEST_ORIGIN });

    expect(res.status).toBe(201);
    const decoded = jwt.verify(res.body.token, TOKEN_SECRET, {
      algorithms: ["HS256"],
    }) as MintedClaims;

    // user + ticket + origin/audience + session id + a short TTL.
    expect(decoded.sub).toBe(TEST_USER_ID);
    expect(decoded.ticketId).toBe(testTicketDisplayId);
    expect(decoded.aud).toBe(TEST_ORIGIN);
    expect(decoded.sessionId).toBe(res.body.sessionId);
    expect(typeof decoded.jti).toBe("string");
    // Short TTL — exp is ~60s out from iat, not a long-lived secret.
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(120);
  });

  it("rejects a GET — the route is a non-cacheable POST, not a broad GET (P1-2)", async () => {
    const res = await request(fastify.server)
      .get("/api/companion/sessions")
      .set("Authorization", "Bearer valid-token");

    // Fastify returns 404 for an unregistered method+path combination.
    expect(res.status).toBe(404);
  });

  it("rate-limits a user past the per-window mint cap (429)", async () => {
    let sawRateLimit = false;
    // The cap is 10/min — fire enough to trip it.
    for (let i = 0; i < 15; i++) {
      const res = await request(fastify.server)
        .post("/api/companion/sessions")
        .set("Authorization", "Bearer valid-token")
        .send({ ticketId: testTicketDisplayId, origin: TEST_ORIGIN });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
