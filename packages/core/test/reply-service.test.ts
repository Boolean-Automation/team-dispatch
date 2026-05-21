// dispatch — reply-service tests
//
// Tests:
//   1. sendReply creates an outbound Message + pending outbox row.
//   2. sendReply with resolveTicket=true closes the ticket.
//   3. sendReply returns a valid undoToken.
//   4. sendReply throws if the ticket does not exist.
//   5. Undo via undoByToken cancels the outbox row and removes the message.
//   6. Undo with resolveTicket=true reverts the ticket status.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages, slackOutbox, auditLog } from "../../db/src/schema.js";
import { sendReply } from "../src/services/reply-service.js";
import { undoByToken } from "../src/services/undo-service.js";
import { getOutboxRowByMessageId } from "../src/services/outbox-service.js";
import type { Db } from "../../db/src/client.js";
import { eq, and } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;
let testTicketId: string;

async function seed(db: Db) {
  const acct = await db
    .insert(accounts)
    .values({
      slug: `reply-svc-test-${Date.now()}`,
      displayName: "Reply Service Test Account",
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
      sourceChannelId: "C_REPLY_TEST",
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await seed(db);
});

afterAll(async () => {
  // Clean up — slack_outbox CASCADE from messages/tickets; delete in order
  await db.delete(slackOutbox).where(eq(slackOutbox.ticketId, testTicketId));
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(messages).where(eq(messages.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

describe("sendReply", () => {
  it("creates an outbound Message and a pending outbox row", async () => {
    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_reply_test",
      body: "Hey, looking into this now.",
      actorName: "Dan Chen",
    });

    expect(result.message.direction).toBe("outbound");
    expect(result.message.authorKind).toBe("se");
    expect(result.message.body).toBe("Hey, looking into this now.");
    expect(result.undoToken).toBeTruthy();
    expect(result.outboxId).toBeTruthy();

    // Verify outbox row
    const outbox = await getOutboxRowByMessageId(db, result.message.id);
    expect(outbox).toBeDefined();
    expect(outbox?.status).toBe("pending");
    expect(outbox?.channelId).toBe("C_REPLY_TEST");
    const payload = outbox?.payload as Record<string, unknown>;
    expect(payload.username).toBe("Dan Chen");
    expect(payload.text).toBe("Hey, looking into this now.");
  });

  it("returns a valid undoToken", async () => {
    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_reply_test",
      body: "Another reply for undo token test.",
      actorName: "Dan Chen",
    });

    // UUID format check
    expect(result.undoToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("marks ticket closed when resolveTicket=true", async () => {
    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_reply_test",
      body: "All fixed — closing this out.",
      actorName: "Dan Chen",
      resolveTicket: true,
    });

    expect(result.message.direction).toBe("outbound");

    // Ticket should now be closed
    const updated = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(updated[0]?.status).toBe("closed");

    // Reset for subsequent tests
    await db
      .update(tickets)
      .set({ status: "on-you", resolvedAt: null, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));
  });

  it("throws when the ticket does not exist", async () => {
    await expect(
      sendReply({
        db,
        ticketId: "00000000-0000-0000-0000-000000000000",
        actorId: "user_reply_test",
        body: "This should throw",
        actorName: "Dan Chen",
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("undo on reply send", () => {
  it("undo within window cancels outbox row and removes the message", async () => {
    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_reply_test",
      body: "Undo test — this send will be canceled.",
      actorName: "Dan Chen",
      undoWindowSecs: 60, // generous window so it's definitely still pending
    });

    const messageId = result.message.id;
    const undoToken = result.undoToken;

    // Verify outbox row is pending before undo
    const outboxBefore = await getOutboxRowByMessageId(db, messageId);
    expect(outboxBefore?.status).toBe("pending");

    // Execute undo
    const undoResult = await undoByToken(db, undoToken);
    expect(undoResult.ok).toBe(true);

    // Message should be deleted (soft or hard delete)
    const msgRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    expect(msgRows.length).toBe(0);

    // Outbox row should be gone (CASCADE delete from message delete) OR canceled.
    // Either outcome means the worker will not fire this send.
    const outboxAfter = await getOutboxRowByMessageId(db, messageId);
    // null (CASCADE deleted) or 'canceled' — both are correct
    const outboxIsClean =
      outboxAfter === null || outboxAfter.status === "canceled";
    expect(outboxIsClean).toBe(true);
  });

  it("undo with resolveTicket=true reverts ticket status", async () => {
    // Ensure ticket is on-you before the test
    await db
      .update(tickets)
      .set({ status: "on-you", resolvedAt: null, updatedAt: new Date() })
      .where(eq(tickets.id, testTicketId));

    const result = await sendReply({
      db,
      ticketId: testTicketId,
      actorId: "user_reply_test",
      body: "Send & resolve — then undo.",
      actorName: "Dan Chen",
      resolveTicket: true,
      undoWindowSecs: 60,
    });

    // Ticket is now closed
    const closedRow = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(closedRow[0]?.status).toBe("closed");

    // Undo
    const undoResult = await undoByToken(db, result.undoToken);
    expect(undoResult.ok).toBe(true);

    // Ticket should be back to on-you
    const revertedRow = await db
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, testTicketId))
      .limit(1);
    expect(revertedRow[0]?.status).toBe("on-you");
  });
});
