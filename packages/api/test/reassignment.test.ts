// dispatch — reassignment API integration tests
//
// Tests:
//   1. POST /api/tickets/:id/reassign (SE token) creates a pending reassignment (201).
//   2. POST /api/tickets/:id/reassign (admin token) creates an accepted reassignment (201).
//   3. POST /api/tickets/:id/reassign requires auth (401 without token).
//   4. POST .../reassign with missing recipientId returns 400.
//   5. POST .../reassign/:reassignmentId/accept succeeds for SE-initiated (200).
//   6. POST .../reassign/:reassignmentId/reject succeeds for SE-initiated (200).
//   7. POST .../reassign/:reassignmentId/accept returns 400 if caller is not recipient.
//   8. undoToken returned from POST reassign; POST /api/undo works.

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
  auditLog,
  reassignments,
  notifications,
} from "../../db/src/schema.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let app: FastifyInstance;
let testAccountId: string;
let testTicketId: string;

const db = createDb(DATABASE_URL);

async function seedData() {
  const acct = await db
    .insert(accounts)
    .values({
      slug: `reassign-api-test-${Date.now()}`,
      displayName: "Reassignment API Test Account",
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
      assignee: "user_se_proposer",
      sourceKind: "channel",
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;
}

beforeAll(async () => {
  _setClerkVerifierForTest(async (token: string) => {
    if (token === "valid-se-token") {
      return { sub: "user_se_proposer", public_metadata: { role: "se" } };
    }
    if (token === "valid-admin-token") {
      return { sub: "user_admin_proposer", public_metadata: { role: "admin" } };
    }
    if (token === "valid-recipient-token") {
      return { sub: "user_recipient", public_metadata: { role: "se" } };
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
  await db
    .delete(notifications)
    .where(eq(notifications.ticketId, testTicketId));
  await db
    .delete(reassignments)
    .where(eq(reassignments.ticketId, testTicketId));
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

// Helper — reset ticket assignee between tests
async function resetTicket() {
  await db
    .update(tickets)
    .set({ assignee: "user_se_proposer", status: "on-you" })
    .where(eq(tickets.id, testTicketId));
  await db
    .delete(reassignments)
    .where(eq(reassignments.ticketId, testTicketId));
}

describe("POST /api/tickets/:id/reassign (SE)", () => {
  it("creates a pending reassignment (201)", async () => {
    await resetTicket();

    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ recipientId: "user_recipient" });

    expect(res.status).toBe(201);
    expect(res.body.reassignment.status).toBe("pending");
    expect(res.body.reassignment.proposer).toBe("user_se_proposer");
    expect(res.body.reassignment.recipient).toBe("user_recipient");
    expect(res.body.undoToken).toBeTruthy();
  });

  it("returns 401 without auth token", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .send({ recipientId: "user_recipient" });
    expect(res.status).toBe(401);
  });

  it("returns 400 without recipientId", async () => {
    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-se-token")
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/tickets/:id/reassign (admin)", () => {
  it("admin creates an accepted reassignment immediately (201)", async () => {
    await resetTicket();

    const res = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-admin-token")
      .send({ recipientId: "user_recipient" });

    expect(res.status).toBe(201);
    expect(res.body.reassignment.status).toBe("accepted");
    expect(res.body.undoToken).toBeTruthy();

    // Ticket assignee should now be user_recipient
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe("user_recipient");
  });
});

describe("POST .../reassign/:reassignmentId/accept", () => {
  it("recipient accepts SE-initiated reassignment (200)", async () => {
    await resetTicket();

    const initRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ recipientId: "user_recipient" });

    const reassignmentId = initRes.body.reassignment.id;

    const acceptRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign/${reassignmentId}/accept`)
      .set("Authorization", "Bearer valid-recipient-token");

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.reassignment.status).toBe("accepted");
    expect(acceptRes.body.undoToken).toBeTruthy();

    // Ticket assignee should now be user_recipient
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe("user_recipient");
  });

  it("returns 400 when caller is not the recipient", async () => {
    await resetTicket();

    const initRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ recipientId: "user_recipient" });

    const reassignmentId = initRes.body.reassignment.id;

    // SE proposer (not the recipient) tries to accept
    const acceptRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign/${reassignmentId}/accept`)
      .set("Authorization", "Bearer valid-se-token"); // proposer, not recipient

    expect(acceptRes.status).toBe(400);
  });
});

describe("POST .../reassign/:reassignmentId/reject", () => {
  it("recipient rejects SE-initiated reassignment (200)", async () => {
    await resetTicket();

    const initRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ recipientId: "user_recipient" });

    const reassignmentId = initRes.body.reassignment.id;

    const rejectRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign/${reassignmentId}/reject`)
      .set("Authorization", "Bearer valid-recipient-token");

    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.reassignment.status).toBe("rejected");

    // Ticket assignee stays with proposer
    const rows = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(rows[0]?.assignee).toBe("user_se_proposer");
  });
});

describe("POST /api/undo for reassignment", () => {
  it("undos a SE-initiated reassignment (removes the row)", async () => {
    await resetTicket();

    const initRes = await supertest(app.server)
      .post(`/api/tickets/${testTicketId}/reassign`)
      .set("Authorization", "Bearer valid-se-token")
      .send({ recipientId: "user_recipient" });

    const { undoToken, reassignment } = initRes.body;

    const undoRes = await supertest(app.server)
      .post("/api/undo")
      .set("Authorization", "Bearer valid-se-token")
      .send({ token: undoToken });

    expect(undoRes.status).toBe(200);
    expect(undoRes.body.ok).toBe(true);

    // Reassignment row should be gone
    const rows = await db
      .select()
      .from(reassignments)
      .where(eq(reassignments.id, reassignment.id));
    expect(rows.length).toBe(0);
  });
});
