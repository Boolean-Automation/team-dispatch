// dispatch — undo-service tests
//
// Tests: reverse ticket.created, ticket.dismissed, ticket.status_changed.
// Verifies: not-found token, already-undone token.
// P1-1: message.created undo — TOCTOU race: (a) undo before worker claims →
//        cancel + delete + revert; (b) worker claims first → undo bails without delete.
//
// plan §Slice 4 / spec §3.9 / A25

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages, auditLog, notifications, slackOutbox } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { undoByToken, generateUndoToken } from "../src/services/undo-service.js";
import { appendAudit } from "../src/services/audit-service.js";
import { insertOutboxRow, claimOutboxRow } from "../src/services/outbox-service.js";

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

// ── P1-1: message.created undo — TOCTOU race branches ────────────────────────
//
// Branch (a): undo before the outbox worker claims the row
//   → cancel succeeds → message is deleted → ticket status reverts
//
// Branch (b): worker already claimed the row (pending → sent)
//   → cancel UPDATE matches nothing → undo bails with 'undo-too-late'
//   → message record is NOT deleted (data integrity)
//   → ticket status is NOT reverted

async function seedTicketWithMessage(db: Db, accountId: string) {
  const ticket = await seedTicket(db, accountId, "on-you");

  // Insert a message row
  const msgRows = await db
    .insert(messages)
    .values({
      ticketId: ticket.id,
      direction: "outbound",
      authorKind: "se",
      authorRef: "user_se_test",
      body: "Undo TOCTOU test reply",
    })
    .returning();
  const msg = msgRows[0]!;

  // Insert a pending outbox row
  const outboxRow = await insertOutboxRow(db, {
    ticketId: ticket.id,
    messageId: msg.id,
    idempotencyKey: `test:toctou:${msg.id}`,
    channelId: "C_TOCTOU_TEST",
    payload: { text: "Undo TOCTOU test" },
    scheduledAt: new Date(Date.now() + 30_000), // in window — not yet due
  });

  return { ticket, msg, outboxRow };
}

describe("undoByToken — message.created TOCTOU race (P1-1)", () => {
  it("(a) undo before worker claims: cancels row, deletes message, reverts status", async () => {
    const { ticket, msg, outboxRow } = await seedTicketWithMessage(db, testAccountId);

    // Advance ticket to waiting-client (simulates reply resolving it)
    await db
      .update(tickets)
      .set({ status: "waiting-client" })
      .where(eq(tickets.id, ticket.id));

    const token = generateUndoToken();
    await appendAudit(db, {
      ticketId: ticket.id,
      event: "message.created",
      before: { status: "on-you" },
      after: {
        messageId: msg.id,
        resolvedTicket: true,
      },
      undoToken: token,
    });

    // Undo before worker claims — outbox row is still 'pending'
    const result = await undoByToken(db, token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("message.created");

    // Message should be deleted
    const msgRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, msg.id))
      .limit(1);
    expect(msgRows.length).toBe(0);

    // Outbox row cascades when message is deleted (FK messages(id) ON DELETE CASCADE)
    // so the row should no longer exist either
    const outboxRows = await db
      .select({ status: slackOutbox.status })
      .from(slackOutbox)
      .where(eq(slackOutbox.id, outboxRow.id))
      .limit(1);
    expect(outboxRows.length).toBe(0);

    // Ticket status should revert to 'on-you'
    const ticketRows = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(ticketRows[0]?.status).toBe("on-you");

    // Outbox row already gone via cascade; no cleanup needed
  });

  it("(b) worker claims first: undo bails with undo-too-late, message NOT deleted", async () => {
    const { ticket, msg, outboxRow } = await seedTicketWithMessage(db, testAccountId);

    const token = generateUndoToken();
    await appendAudit(db, {
      ticketId: ticket.id,
      event: "message.created",
      before: { status: "on-you" },
      after: {
        messageId: msg.id,
        resolvedTicket: false,
      },
      undoToken: token,
    });

    // Simulate the outbox worker claiming the row (pending → sent)
    await claimOutboxRow(db, outboxRow.id);

    // Undo after worker claims — outbox row is now 'sent', not 'pending'
    const result = await undoByToken(db, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("undo-too-late");

    // Message must NOT be deleted (data integrity — Slack already received it)
    const msgRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, msg.id))
      .limit(1);
    expect(msgRows.length).toBe(1);

    // Ticket status must be unchanged (still 'on-you')
    const ticketRows = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(ticketRows[0]?.status).toBe("on-you");

    // Cleanup
    await db.delete(slackOutbox).where(eq(slackOutbox.id, outboxRow.id));
    await db.delete(messages).where(eq(messages.id, msg.id));
  });
});
