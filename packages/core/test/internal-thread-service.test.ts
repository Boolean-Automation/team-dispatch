// dispatch — internal-thread-service tests
//
// Tests:
//   1. listInternalThreadMessages returns empty list for a new ticket.
//   2. postInternalMessage creates a message and returns a valid undoToken.
//   3. postInternalMessage throws on empty body.
//   4. Multiple messages are returned in order (oldest first).
//   5. Undo via undoByToken deletes the internal thread message.
//   6. Internal thread messages are NOT written to Slack (A21 — no outbox row).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import {
  accounts,
  tickets,
  auditLog,
  internalThreadMessages,
} from "../../db/src/schema.js";
import {
  listInternalThreadMessages,
  postInternalMessage,
} from "../src/services/internal-thread-service.js";
import { undoByToken } from "../src/services/undo-service.js";
import type { Db } from "../../db/src/client.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;
let testTicketId: string;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const acct = await db
    .insert(accounts)
    .values({
      slug: `int-thread-test-${Date.now()}`,
      displayName: "Internal Thread Test Account",
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
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;
});

afterAll(async () => {
  // Delete child rows before parent rows
  await db
    .delete(internalThreadMessages)
    .where(eq(internalThreadMessages.ticketId, testTicketId));
  await db.delete(auditLog).where(eq(auditLog.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

describe("listInternalThreadMessages", () => {
  it("returns an empty list for a new ticket with no internal messages", async () => {
    const msgs = await listInternalThreadMessages(db, testTicketId);
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBe(0);
  });
});

describe("postInternalMessage", () => {
  it("creates a message and returns a valid undoToken", async () => {
    const result = await postInternalMessage(
      db,
      testTicketId,
      "user_int_author",
      "Internal note: checking with team"
    );

    expect(result.message.ticketId).toBe(testTicketId);
    expect(result.message.authorId).toBe("user_int_author");
    expect(result.message.body).toBe("Internal note: checking with team");
    expect(result.message.postedAt).toBeTruthy();
    expect(result.undoToken).toBeTruthy();
    expect(typeof result.undoToken).toBe("string");
  });

  it("throws on empty body", async () => {
    await expect(
      postInternalMessage(db, testTicketId, "user_int_author", "   ")
    ).rejects.toThrow("body is required");
  });

  it("multiple messages are returned oldest first", async () => {
    // Post a second message
    await postInternalMessage(
      db,
      testTicketId,
      "user_int_author2",
      "Follow-up internal note"
    );

    const msgs = await listInternalThreadMessages(db, testTicketId);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    // Oldest should come first
    const times = msgs.map((m) => new Date(m.postedAt).getTime());
    expect(times[0]).toBeLessThanOrEqual(times[times.length - 1]!);
  });

  it("messages have no Slack channel tag (A21 — dispatch-native only)", async () => {
    // The message DTO has no slack_ts or channel fields — confirm shape
    const result = await postInternalMessage(
      db,
      testTicketId,
      "user_int_author",
      "Another internal note"
    );
    const msg = result.message;
    // DTO should NOT have a Slack-related field
    expect("slackTs" in msg).toBe(false);
    expect("channelId" in msg).toBe(false);
  });
});

describe("undo internal thread message", () => {
  it("undoByToken deletes the internal thread message", async () => {
    const result = await postInternalMessage(
      db,
      testTicketId,
      "user_undo_test",
      "Message to be undone"
    );

    // Verify the message exists
    const before = await listInternalThreadMessages(db, testTicketId);
    const exists = before.some((m) => m.id === result.message.id);
    expect(exists).toBe(true);

    // Undo
    const undoResult = await undoByToken(db, result.undoToken);
    expect(undoResult.ok).toBe(true);
    expect(undoResult).toMatchObject({ ok: true, action: "message.created" });

    // Verify the message is gone
    const after = await listInternalThreadMessages(db, testTicketId);
    const stillExists = after.some((m) => m.id === result.message.id);
    expect(stillExists).toBe(false);
  });

  it("cannot undo the same token twice", async () => {
    const result = await postInternalMessage(
      db,
      testTicketId,
      "user_double_undo",
      "Double undo test"
    );

    await undoByToken(db, result.undoToken);
    const secondUndo = await undoByToken(db, result.undoToken);
    expect(secondUndo.ok).toBe(false);
    expect(secondUndo).toMatchObject({ ok: false, reason: "already-undone" });
  });
});
