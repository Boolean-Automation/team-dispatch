// dispatch — messages API integration tests
//
// Tests:
//   1. GET  /api/tickets/:id/messages returns 200 with message list.
//   2. GET  /api/tickets/:id/messages requires Clerk session auth (401 without token).
//   3. POST /api/tickets/:id/messages creates a message + outbox row (201).
//   4. POST /api/tickets/:id/messages with resolve=true closes the ticket.
//   5. POST /api/tickets/:id/messages with missing body returns 400.
//   6. POST /api/tickets/:id/messages for non-existent ticket returns 404.
//   7. undoToken is in the response; POST /api/undo cancels the outbox row.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
} from "../src/plugins/clerk-auth.js";
import { createDb } from "../../db/src/client.js";
import {
  accounts,
  tickets,
  messages,
  slackOutbox,
  auditLog,
} from "../../db/src/schema.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let app: FastifyInstance;
let testAccountId: string;
let testTicketId: string;

const db = createDb(DATABASE_URL);

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedData() {
  const acct = await db
    .insert(accounts)
    .values({
      slug: `msg-api-test-${Date.now()}`,
      displayName: "Messages API Test Account",
      health: "good",
    })
    .returning();
  testAccountId = acct[0]!.id;

  const tkt = await db
    .insert(tickets)
    .values({
      accountId: testAccountId,
      status: "on-you",
      type: "question",
      sourceKind: "channel",
      sourceChannelId: "C_MSGS_API_TEST",
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;

  // Seed an inbound message
  await db.insert(messages).values({
    ticketId: testTicketId,
    direction: "inbound",
    authorKind: "client",
    authorRef: "U_CLIENT_TEST",
    body: "Client question about something.",
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  _setClerkVerifierForTest(async (token: string) => {
    if (token === "valid-se-token") {
      return { sub: "user_msgs_se", public_metadata: { role: "se" } };
    }
    if (token === "valid-admin-token") {
      return { sub: "user_msgs_admin", public_metadata: { role: "admin" } };
    }
    throw new Error("invalid token");
  });

  await seedData();

  app = await buildServer({ db });
  await app.ready();
});

afterAll(async () => {
  _resetClerkVerifier();
  await app.close();

  // Clean up test data
  await db.delete(slackOutbox).where(eq(slackOutbox.ticketId, testTicketId));
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(messages).where(eq(messages.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/tickets/:id/messages", () => {
  it("returns 200 with message list for authenticated request", async () => {
    const res = await supertest(app.server)
      .get(`/api/tickets/${testTicketId}/messages`)
      .set("Authorization", "Bearer valid-se-token");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const msg = res.body.find((m: { direction: string }) => m.direction === "inbound");
    expect(msg).toBeDefined();
    expect(msg.body).toBe("Client question about something.");
  });

  it("returns 401 without auth token", async () => {
    const res = await supertest(app.server).get(
      `/api/tickets/${testTicketId}/messages`
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/tickets/:id/messages", () => {
  it("creates a message + outbox row and returns 201 with undoToken", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/messages`)
      .set("Authorization", "Bearer valid-se-token")
      .send({
        body: "Looking into this for you now.",
        actorName: "Dan Chen",
        resolve: false,
      });

    expect(res.status).toBe(201);
    expect(res.body.message).toBeDefined();
    expect(res.body.message.direction).toBe("outbound");
    expect(res.body.message.body).toBe("Looking into this for you now.");
    expect(res.body.undoToken).toBeTruthy();
    expect(res.body.outboxId).toBeTruthy();
  });

  it("returns 400 when body is missing", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/messages`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ actorName: "Dan Chen" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty string", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/messages`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ body: "   ", actorName: "Dan Chen" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent ticket", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/00000000-0000-0000-0000-000000000000/messages`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ body: "Hello", actorName: "Dan" });

    expect(res.status).toBe(404);
  });

  it("moves ticket to waiting-client (not closed) when resolve=true from on-you (A15)", async () => {
    // Ensure ticket is on-you before test
    await db
      .update(tickets)
      .set({ status: "on-you", resolvedAt: null, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/messages`)
      .set("Authorization", "Bearer valid-se-token")
      .send({
        body: "All fixed, let me know if you need anything.",
        actorName: "Dan Chen",
        resolve: true,
      });

    expect(res.status).toBe(201);

    // Verify ticket moved to waiting-client (A15), not closed
    const tkt = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(tkt[0]?.status).toBe("waiting-client");
    expect(tkt[0]?.status).not.toBe("closed");

    // Reset for subsequent tests
    await db
      .update(tickets)
      .set({ status: "on-you", resolvedAt: null, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));
  });

  it("undoToken from POST can be used to cancel outbox row via POST /api/undo", async () => {
    const sendRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/messages`)
      .set("Authorization", "Bearer valid-se-token")
      .send({
        body: "Send and then undo.",
        actorName: "Dan Chen",
        resolve: false,
      });

    expect(sendRes.status).toBe(201);
    const { undoToken } = sendRes.body as { undoToken: string };
    expect(undoToken).toBeTruthy();

    // Undo via POST /api/undo (also requires Clerk session auth)
    const undoRes = await supertest(app.server)
      .post("/api/undo")
      .set("Authorization", "Bearer valid-se-token")
      .send({ token: undoToken });

    expect(undoRes.status).toBe(200);
    expect(undoRes.body.ok).toBe(true);
  });

  it("returns 401 without auth token", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/messages`)
      .send({ body: "no auth", actorName: "Dan" });
    expect(res.status).toBe(401);
  });
});
