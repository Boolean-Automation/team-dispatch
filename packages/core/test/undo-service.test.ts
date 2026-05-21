// dispatch — undo-service tests
//
// Tests: reverse ticket.created, ticket.dismissed, ticket.status_changed.
// Verifies: not-found token, already-undone token.
//
// plan §Slice 4 / spec §3.9 / A25

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages, auditLog, notifications } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { undoByToken, generateUndoToken } from "../src/services/undo-service.js";
import { appendAudit } from "../src/services/audit-service.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const inserted = await db
    .insert(accounts)
    .values({
      slug: `undo-test-${Date.now()}`,
      displayName: "Undo Test Account",
      slackChannelIds: [],
      health: "good",
    })
    .returning();

  testAccountId = inserted[0]!.id;
});

afterAll(async () => {
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
});

async function seedTicket(db: Db, accountId: string, status = "new" as "new" | "on-you") {
  const rows = await db
    .insert(tickets)
    .values({
      accountId,
      status,
      type: "question",
      sourceKind: "channel",
      originClass: "client",
    })
    .returning();
  return rows[0]!;
}

describe("undoByToken — ticket.created", () => {
  it("reverses ticket.created by setting dismissed_at", async () => {
    const ticket = await seedTicket(db, testAccountId);
    const token = generateUndoToken();

    await appendAudit(db, {
      ticketId: ticket.id,
      event: "ticket.created",
      after: { ticketId: ticket.id },
      undoToken: token,
    });

    const result = await undoByToken(db, token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("ticket.created");

    // Ticket should now be dismissed
    const rows = await db
      .select({ dismissedAt: tickets.dismissedAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);

    expect(rows[0]!.dismissedAt).not.toBeNull();
  });
});

describe("undoByToken — ticket.dismissed", () => {
  it("reverses ticket.dismissed by clearing dismissed_at", async () => {
    const ticket = await seedTicket(db, testAccountId);

    // Set dismissed
    await db
      .update(tickets)
      .set({ dismissedAt: new Date() })
      .where(eq(tickets.id, ticket.id));

    const token = generateUndoToken();

    await appendAudit(db, {
      ticketId: ticket.id,
      event: "ticket.dismissed",
      before: { dismissedAt: null },
      after: { dismissedAt: new Date().toISOString() },
      undoToken: token,
    });

    const result = await undoByToken(db, token);
    expect(result.ok).toBe(true);

    const rows = await db
      .select({ dismissedAt: tickets.dismissedAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);

    expect(rows[0]!.dismissedAt).toBeNull();
  });
});

describe("undoByToken — ticket.status_changed", () => {
  it("reverts status to the before state", async () => {
    const ticket = await seedTicket(db, testAccountId, "on-you");

    // "Advance" the status in the DB
    await db
      .update(tickets)
      .set({ status: "waiting-client" })
      .where(eq(tickets.id, ticket.id));

    const token = generateUndoToken();

    await appendAudit(db, {
      ticketId: ticket.id,
      event: "ticket.status_changed",
      before: { status: "on-you" },
      after: { status: "waiting-client" },
      undoToken: token,
    });

    const result = await undoByToken(db, token);
    expect(result.ok).toBe(true);

    const rows = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);

    expect(rows[0]!.status).toBe("on-you");
  });
});

describe("undoByToken — error cases", () => {
  it("returns not-found for an unknown token", async () => {
    const result = await undoByToken(db, "00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-found");
  });

  it("returns already-undone for a token used twice", async () => {
    const ticket = await seedTicket(db, testAccountId);
    const token = generateUndoToken();

    await appendAudit(db, {
      ticketId: ticket.id,
      event: "ticket.created",
      after: { ticketId: ticket.id },
      undoToken: token,
    });

    // First undo
    const result1 = await undoByToken(db, token);
    expect(result1.ok).toBe(true);

    // Second undo of the same token
    const result2 = await undoByToken(db, token);
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toBe("already-undone");
  });
});
