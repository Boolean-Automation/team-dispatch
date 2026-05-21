// dispatch — tickets API integration tests
//
// Uses Supertest against a real Fastify instance + real Postgres test DB.
// Auth is bypassed via _setClerkVerifierForTest().
//
// Tests:
//  1. GET /api/tickets returns 200 with an array.
//  2. GET /api/tickets?status=new filters correctly.
//  3. GET /api/tickets/:id returns 200 for an existing ticket.
//  4. GET /api/tickets/:id returns 404 for a missing id.
//  5. GET /api/tickets without auth returns 401.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
} from "../src/plugins/clerk-auth.js";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

const TEST_USER_ID = "user_test_tickets_api";

// ── Mock Clerk verifier ────────────────────────────────────────────────────────

function mockClerkVerifier(token: string) {
  if (token === "valid-token") {
    return Promise.resolve({
      sub: TEST_USER_ID,
      public_metadata: { role: "admin" },
    });
  }
  return Promise.reject(new Error("invalid token"));
}

// ── Test fixtures ──────────────────────────────────────────────────────────────

let testAccountId: string;
let testTicketId: string;
let fastify: Awaited<ReturnType<typeof buildServer>>;
const db = createDb(DATABASE_URL);

beforeAll(async () => {
  _setClerkVerifierForTest(mockClerkVerifier as never);

  // Seed test account + ticket
  const accts = await db
    .insert(accounts)
    .values({
      slug: `api-test-acct-${Date.now()}`,
      displayName: "API Test Account",
      emailDomains: ["apitest.example.com"],
      slackChannelIds: ["C_APITEST_001"],
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
  testTicketId = tkts[0]!.id;

  await db.insert(messages).values({
    ticketId: testTicketId,
    direction: "inbound",
    authorKind: "client",
    authorRef: "U_API_TEST_CLIENT",
    body: "API test message preview",
  });

  fastify = await buildServer({ db });
  await fastify.ready();
});

afterAll(async () => {
  _resetClerkVerifier();
  // Delete tickets first (accounts.id has RESTRICT FK from tickets)
  await db.delete(tickets).where(eq(tickets.accountId, testAccountId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
  await fastify.close();
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("GET /api/tickets", () => {
  it("returns 200 with an array of ticket cards", async () => {
    const res = await request(fastify.server)
      .get("/api/tickets")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns cards with clientName, preview, ageMin fields", async () => {
    const res = await request(fastify.server)
      .get("/api/tickets")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    const card = (res.body as Array<Record<string, unknown>>).find(
      (c) => c["id"] === testTicketId
    );
    expect(card).toBeDefined();
    expect(card?.["clientName"]).toBe("API Test Account");
    expect(card?.["preview"]).toBe("API test message preview");
    expect(typeof card?.["ageMin"]).toBe("number");
  });

  it("filters by status=new", async () => {
    const res = await request(fastify.server)
      .get("/api/tickets?status=new")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    const cards = res.body as Array<{ status: string }>;
    expect(cards.every((c) => c.status === "new")).toBe(true);
  });

  it("returns 401 without a token", async () => {
    const res = await request(fastify.server).get("/api/tickets");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/tickets/:id", () => {
  it("returns 200 with the ticket dto", async () => {
    const res = await request(fastify.server)
      .get(`/api/tickets/${testTicketId}`)
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(testTicketId);
    expect(res.body.status).toBe("new");
  });

  it("returns 200 when fetching by DSP- display id (P1-D)", async () => {
    // First get the ticket to learn its display id
    const dtoRes = await request(fastify.server)
      .get(`/api/tickets/${testTicketId}`)
      .set("Authorization", "Bearer valid-token");

    expect(dtoRes.status).toBe(200);
    const displayId: string = dtoRes.body.displayId;
    expect(displayId).toMatch(/^DSP-/);

    // Now fetch using the display id
    const res = await request(fastify.server)
      .get(`/api/tickets/${displayId}`)
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(testTicketId);
    expect(res.body.displayId).toBe(displayId);
  });

  it("returns 404 for a missing ticket id", async () => {
    const res = await request(fastify.server)
      .get("/api/tickets/00000000-0000-0000-0000-000000000000")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(404);
  });

  // P3-A: malformed id (neither UUID nor DSP-####) must return 400, not 500
  it("returns 400 for a malformed ticket id (P3-A)", async () => {
    const res = await request(fastify.server)
      .get("/api/tickets/not-a-valid-id")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid ticket id");
  });

  it("returns 400 for a partial UUID (P3-A)", async () => {
    const res = await request(fastify.server)
      .get("/api/tickets/00000000-0000-0000-0000")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(400);
  });
});
