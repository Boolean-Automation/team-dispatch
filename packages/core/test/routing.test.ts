// dispatch — routing service tests
//
// Tests routeTicket: assigns new Ticket to Account's owning_se, sets status on-you.
// An account without an owning_se leaves the ticket unassigned (status new).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, auditLog, notifications, messages } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { routeTicket } from "../src/services/routing.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let ownedAccountId: string;
let unownedAccountId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const owned = await db
    .insert(accounts)
    .values({
      slug: `routing-owned-${Date.now()}`,
      displayName: "Routing Owned Account",
      slackChannelIds: [],
      owningSe: "clerk_routing_se",
      health: "good",
    })
    .returning();
  ownedAccountId = owned[0]!.id;

  const unowned = await db
    .insert(accounts)
    .values({
      slug: `routing-unowned-${Date.now()}`,
      displayName: "Routing Unowned Account",
      slackChannelIds: [],
      owningSe: null,
      health: "good",
    })
    .returning();
  unownedAccountId = unowned[0]!.id;
});

afterAll(async () => {
  const allAccountIds = [ownedAccountId, unownedAccountId];
  for (const accountId of allAccountIds) {
    const tkts = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.accountId, accountId));
    for (const t of tkts) {
      await db.delete(notifications).where(eq(notifications.ticketId, t.id));
      await db.delete(auditLog).where(eq(auditLog.ticketId, t.id));
      await db.delete(messages).where(eq(messages.ticketId, t.id));
    }
    await db.delete(tickets).where(eq(tickets.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.id, accountId));
  }
});

async function seedTicket(db: Db, accountId: string) {
  const rows = await db
    .insert(tickets)
    .values({
      accountId,
      status: "new",
      type: "question",
      sourceKind: "channel",
      originClass: "client",
    })
    .returning();
  return rows[0]!;
}

describe("routeTicket", () => {
  it("assigns to owning SE and sets status on-you", async () => {
    const t = await seedTicket(db, ownedAccountId);

    const result = await routeTicket(db, t.id, ownedAccountId);

    expect(result.assignee).toBe("clerk_routing_se");
    expect(result.status).toBe("on-you");

    // Verify DB state
    const rows = await db
      .select({ assignee: tickets.assignee, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, t.id))
      .limit(1);

    expect(rows[0]!.assignee).toBe("clerk_routing_se");
    expect(rows[0]!.status).toBe("on-you");
  });

  it("leaves assignee null and status new when account has no owning_se", async () => {
    const t = await seedTicket(db, unownedAccountId);

    const result = await routeTicket(db, t.id, unownedAccountId);

    expect(result.assignee).toBeNull();
    expect(result.status).toBe("new");
  });
});
