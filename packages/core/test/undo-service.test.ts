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
import { updateTicketStatus } from "../src/services/ticket-service.js";
import { sendReply } from "../src/services/reply-service.js";

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

// ── P2-B: ticket.status_changed undo restores SLA side-effect columns ─────────
//
// Undoing on-you → waiting-client must clear waiting_client_since_at.
// Undoing waiting-client → on-you must restore waiting_client_since_at to its
// prior value so the SLA timer still tracks it.

describe("undoByToken — ticket.status_changed SLA columns (P2-B)", () => {
  it("undo of on-you → waiting-client clears waiting_client_since_at", async () => {
    // Seed ticket in on-you
    const ticket = await seedTicket(db, testAccountId, "on-you");

    // Transition to waiting-client via the service (stamps waiting_client_since_at)
    const result = await updateTicketStatus(
      db,
      ticket.id,
      "waiting-client",
      "user_se_test"
    );
    expect(result.ok).toBe(true);

    // Verify waiting_client_since_at is set
    const afterTransition = await db
      .select({ waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(afterTransition[0]?.waitingClientSinceAt).not.toBeNull();

    // Undo the transition
    const undoResult = await undoByToken(db, result.undoToken!);
    expect(undoResult.ok).toBe(true);

    // After undo, status should be on-you and waiting_client_since_at cleared
    const afterUndo = await db
      .select({ status: tickets.status, waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(afterUndo[0]?.status).toBe("on-you");
    expect(afterUndo[0]?.waitingClientSinceAt).toBeNull();
  });

  it("undo of waiting-client → on-you restores waiting_client_since_at", async () => {
    // Seed ticket in on-you, then manually stamp waiting_client_since_at
    const ticket = await seedTicket(db, testAccountId, "on-you");
    const originalWcAt = new Date("2026-01-01T10:00:00Z");

    // Set to waiting-client with a known stamp (via service so audit is correct)
    const toWaiting = await updateTicketStatus(
      db,
      ticket.id,
      "waiting-client",
      "user_se_test"
    );
    expect(toWaiting.ok).toBe(true);

    // Override waiting_client_since_at to a known value for assertion
    await db
      .update(tickets)
      .set({ waitingClientSinceAt: originalWcAt })
      .where(eq(tickets.id, ticket.id));

    // Also update the audit before payload to capture this known timestamp
    // (patch the audit entry's before.waitingClientSinceAt to null since from
    // on-you there was no prior stamp — that's what the audit records)
    // This test instead transitions waiting-client → on-you and undoes that.

    // Transition FROM waiting-client (clears waiting_client_since_at)
    const toOnYou = await updateTicketStatus(
      db,
      ticket.id,
      "on-you",
      "user_se_test"
    );
    expect(toOnYou.ok).toBe(true);

    // Verify waiting_client_since_at was cleared by the transition
    const midState = await db
      .select({ waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(midState[0]?.waitingClientSinceAt).toBeNull();

    // Undo the waiting-client → on-you transition
    const undoResult = await undoByToken(db, toOnYou.undoToken!);
    expect(undoResult.ok).toBe(true);

    // After undo: status restored to waiting-client; waiting_client_since_at
    // restored to the value captured in the audit before payload.
    const afterUndo = await db
      .select({ status: tickets.status, waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(afterUndo[0]?.status).toBe("waiting-client");
    // The before payload for the second transition records the stamp that was
    // set by the first transition (the originalWcAt we applied).
    expect(afterUndo[0]?.waitingClientSinceAt).not.toBeNull();
  });
});

// ── P2-C: message.created undo restores SLA side-effect columns ───────────────
//
// Undoing a Send & resolve (on-you → waiting-client) must clear
// waiting_client_since_at that the reply stamped.

describe("undoByToken — message.created SLA columns (P2-C)", () => {
  it("undo of send-and-resolve (on-you → waiting-client) clears waiting_client_since_at", async () => {
    // Seed a ticket in on-you with a source channel (needed by sendReply)
    const ticketRows = await db
      .insert(tickets)
      .values({
        accountId: testAccountId,
        status: "on-you",
        type: "question",
        sourceKind: "channel",
        sourceChannelId: "C_UNDO_SLA_TEST",
        originClass: "client",
      })
      .returning();
    const ticket = ticketRows[0]!;

    // Send a reply with resolveTicket=true (on-you → waiting-client)
    const replyResult = await sendReply({
      db,
      ticketId: ticket.id,
      actorId: "user_se_test",
      body: "SLA undo test reply",
      actorName: "SE Test",
      resolveTicket: true,
      undoWindowSecs: 30,
    });

    // Verify waiting_client_since_at is stamped
    const afterSend = await db
      .select({ status: tickets.status, waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(afterSend[0]?.status).toBe("waiting-client");
    expect(afterSend[0]?.waitingClientSinceAt).not.toBeNull();

    // Undo the send (outbox row is still pending — within window)
    const undoResult = await undoByToken(db, replyResult.undoToken);
    expect(undoResult.ok).toBe(true);

    // After undo: status reverted to on-you; waiting_client_since_at cleared
    const afterUndo = await db
      .select({ status: tickets.status, waitingClientSinceAt: tickets.waitingClientSinceAt })
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .limit(1);
    expect(afterUndo[0]?.status).toBe("on-you");
    expect(afterUndo[0]?.waitingClientSinceAt).toBeNull();

    // Cleanup
    await db.delete(tickets).where(eq(tickets.id, ticket.id));
  });
});
