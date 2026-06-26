// dispatch — hand-create + role-aware assignment integration tests
//
// Covers POST /api/tickets assignment rules (ADR-005 follow-up) and the
// GET /api/engineers picker source. Supertest against a real Fastify instance
// + real Postgres test DB; auth bypassed via _setClerkVerifierForTest().
//
// Rules under test:
//   SE caller    → ticket always self-assigns to the caller.
//   Admin caller → may pick any known engineer; unknown id → 400;
//                  omitted → falls back to the account's owning SE.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
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
  notifications,
  auditLog,
  internalUsers,
} from "../../db/src/schema.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

const ADMIN_ID = "user_handcreate_admin";
const SE_ID = "user_handcreate_se";
const PICK_ID = "user_handcreate_pick";
const OWNER_ID = "user_handcreate_owner";

function mockClerkVerifier(token: string) {
  if (token === "admin-token") {
    return Promise.resolve({ sub: ADMIN_ID, public_metadata: { role: "admin" } });
  }
  if (token === "se-token") {
    return Promise.resolve({ sub: SE_ID, public_metadata: { role: "se" } });
  }
  return Promise.reject(new Error("invalid token"));
}

let testAccountId: string;
let fastify: Awaited<ReturnType<typeof buildServer>>;
const db = createDb(DATABASE_URL);

beforeAll(async () => {
  _setClerkVerifierForTest(mockClerkVerifier as never);

  const accts = await db
    .insert(accounts)
    .values({
      slug: `handcreate-acct-${Date.now()}`,
      displayName: "Hand Create Account",
      emailDomains: ["handcreate.example.com"],
      slackChannelIds: ["C_HANDCREATE_001"],
      owningSe: OWNER_ID,
      health: "good",
    })
    .returning();
  testAccountId = accts[0]!.id;

  await db.insert(internalUsers).values([
    { clerkId: SE_ID, slackId: null, label: "SE Tester" },
    { clerkId: PICK_ID, slackId: null, label: "Pick Tester" },
  ]);

  fastify = await buildServer({ db });
  await fastify.ready();
});

afterAll(async () => {
  _resetClerkVerifier();
  const tkts = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.accountId, testAccountId));
  for (const t of tkts) {
    await db.delete(notifications).where(eq(notifications.ticketId, t.id));
    await db.delete(auditLog).where(eq(auditLog.ticketId, t.id));
    await db.delete(messages).where(eq(messages.ticketId, t.id));
  }
  await db.delete(tickets).where(eq(tickets.accountId, testAccountId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
  await db.delete(internalUsers).where(eq(internalUsers.clerkId, SE_ID));
  await db.delete(internalUsers).where(eq(internalUsers.clerkId, PICK_ID));
  await fastify.close();
});

async function assigneeOf(ticketId: string): Promise<string | null> {
  const rows = await db
    .select({ assignee: tickets.assignee, status: tickets.status })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return rows[0]?.assignee ?? null;
}

describe("POST /api/tickets — role-aware assignment", () => {
  it("SE caller self-assigns the ticket", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .set("Authorization", "Bearer se-token")
      .send({ accountId: testAccountId });

    expect(res.status).toBe(201);
    expect(await assigneeOf(res.body.ticketId)).toBe(SE_ID);
  });

  it("SE caller cannot route to another engineer (assigneeId ignored)", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .set("Authorization", "Bearer se-token")
      .send({ accountId: testAccountId, assigneeId: PICK_ID });

    expect(res.status).toBe(201);
    expect(await assigneeOf(res.body.ticketId)).toBe(SE_ID);
  });

  it("admin caller may assign to a known engineer", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .set("Authorization", "Bearer admin-token")
      .send({ accountId: testAccountId, assigneeId: PICK_ID });

    expect(res.status).toBe(201);
    expect(await assigneeOf(res.body.ticketId)).toBe(PICK_ID);
  });

  it("admin caller with an unknown assignee gets 400", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .set("Authorization", "Bearer admin-token")
      .send({ accountId: testAccountId, assigneeId: "user_does_not_exist" });

    expect(res.status).toBe(400);
  });

  it("admin caller with a present-but-malformed assignee (null) gets 400", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .set("Authorization", "Bearer admin-token")
      .send({ accountId: testAccountId, assigneeId: null });

    expect(res.status).toBe(400);
  });

  it("admin caller without an assignee falls back to the owning SE", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .set("Authorization", "Bearer admin-token")
      .send({ accountId: testAccountId });

    expect(res.status).toBe(201);
    expect(await assigneeOf(res.body.ticketId)).toBe(OWNER_ID);
  });

  it("returns 401 without a token", async () => {
    const res = await request(fastify.server)
      .post("/api/tickets")
      .send({ accountId: testAccountId });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/engineers", () => {
  it("lists internal users for the picker", async () => {
    const res = await request(fastify.server)
      .get("/api/engineers")
      .set("Authorization", "Bearer admin-token");

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ clerkId: string }>).map((e) => e.clerkId);
    expect(ids).toContain(SE_ID);
    expect(ids).toContain(PICK_ID);
  });
});
