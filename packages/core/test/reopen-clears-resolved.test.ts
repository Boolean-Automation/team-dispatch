// dispatch — reopen clears resolved_at
//
// Regression: reopening a closed ticket (closed → on-you via updateTicketStatus)
// must CLEAR resolved_at, else the reopened ticket stays marked resolved in
// persisted state. Real Postgres test DB (dispatch_test).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, auditLog } from "../../db/src/schema.js";
import { updateTicketStatus } from "../src/services/ticket-service.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let accountId: string;
let ticketId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const accts = await db
    .insert(accounts)
    .values({
      slug: `reopen-acct-${Date.now()}`,
      displayName: "Reopen Test Account",
      slackChannelIds: [],
      owningSe: "clerk_reopen_se",
      health: "good",
    })
    .returning();
  accountId = accts[0]!.id;

  // Seed a ticket that is already closed + resolved (effort bucket set so it
  // is a valid closed state per the ladder guard).
  const tkts = await db
    .insert(tickets)
    .values({
      accountId,
      status: "closed",
      type: "question",
      sourceKind: "channel",
      originClass: "client",
      effortBucket: "client-specific",
      resolvedAt: new Date(),
    })
    .returning();
  ticketId = tkts[0]!.id;
});

afterAll(async () => {
  await db.delete(auditLog).where(eq(auditLog.ticketId, ticketId));
  await db.delete(tickets).where(eq(tickets.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("updateTicketStatus — reopen", () => {
  it("clears resolved_at when reopening closed → on-you", async () => {
    const before = await db
      .select({ resolvedAt: tickets.resolvedAt })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    expect(before[0]?.resolvedAt).toBeInstanceOf(Date); // precondition: resolved

    const result = await updateTicketStatus(db, ticketId, "on-you", "clerk_admin");
    expect(result.ok).toBe(true);

    const after = await db
      .select({ status: tickets.status, resolvedAt: tickets.resolvedAt })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .limit(1);
    expect(after[0]?.status).toBe("on-you");
    expect(after[0]?.resolvedAt).toBeNull();
  });
});
