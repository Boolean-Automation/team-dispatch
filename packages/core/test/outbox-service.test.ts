// dispatch — outbox-service tests
//
// Tests (FIX 6 — durable outbox):
//   1. insertOutboxRow creates a pending row with the correct fields.
//   2. Pending row survives a simulated restart (the row is in the DB, not memory).
//   3. cancelOutboxRow within the window transitions pending → canceled.
//   4. cancelOutboxRow on an already-sent row returns { ok: false, reason: 'already-terminal' }.
//   5. getDueOutboxRows returns pending rows past their scheduled_at.
//   6. getDueOutboxRows does NOT return rows still in the future.
//   7. markOutboxRowSent transitions pending → sent (idempotency guard).
//   8. markOutboxRowSent on a non-pending row returns false (double-post guard).
//   9. markOutboxRowFailed increments attempts; reaches 'failed' at MAX_ATTEMPTS.
//   10. The idempotency_key unique constraint prevents a duplicate insert.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages, slackOutbox } from "../../db/src/schema.js";
import {
  insertOutboxRow,
  cancelOutboxRow,
  getDueOutboxRows,
  markOutboxRowSent,
  markOutboxRowFailed,
  getOutboxRowByMessageId,
  claimOutboxRow,
} from "../src/services/outbox-service.js";
import type { Db } from "../../db/src/client.js";
import { eq } from "drizzle-orm";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;
let testTicketId: string;
let testMessageId: string;

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seed(db: Db) {
  const acct = await db
    .insert(accounts)
    .values({
      slug: `outbox-test-${Date.now()}`,
      displayName: "Outbox Test Account",
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
      sourceChannelId: "C_OUTBOX_TEST",
      originClass: "client",
    })
    .returning();
  testTicketId = tkt[0]!.id;

  const msg = await db
    .insert(messages)
    .values({
      ticketId: testTicketId,
      direction: "outbound",
      authorKind: "se",
      authorRef: "user_outbox_test",
      body: "Test reply body",
    })
    .returning();
  testMessageId = msg[0]!.id;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await seed(db);
});

afterAll(async () => {
  // Clean up — outbox rows CASCADE from messages/tickets; delete in order
  await db.delete(slackOutbox).where(eq(slackOutbox.ticketId, testTicketId));
  await db.delete(messages).where(eq(messages.ticketId, testTicketId));
  await db.delete(tickets).where(eq(tickets.id, testTicketId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("insertOutboxRow", () => {
  it("creates a pending row with the correct fields", async () => {
    const key = `test:${testMessageId}:1`;
    const scheduledAt = new Date(Date.now() + 10_000);

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: testMessageId,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: { text: "hello", username: "Dan" },
      scheduledAt,
    });

    expect(row.status).toBe("pending");
    expect(row.ticketId).toBe(testTicketId);
    expect(row.messageId).toBe(testMessageId);
    expect(row.idempotencyKey).toBe(key);
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.sentAt).toBeNull();

    // Clean up this specific row for isolation
    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
  });

  it("prevents duplicate insert on the same idempotency_key", async () => {
    const key = `test:dedup:${Date.now()}`;
    const scheduledAt = new Date(Date.now() + 10_000);

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: testMessageId,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: { text: "hello" },
      scheduledAt,
    });

    await expect(
      insertOutboxRow(db, {
        ticketId: testTicketId,
        messageId: testMessageId,
        idempotencyKey: key, // same key — must throw
        channelId: "C_OUTBOX_TEST",
        payload: { text: "hello" },
        scheduledAt,
      })
    ).rejects.toThrow();

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
  });
});

describe("pending row survives a simulated restart (durable outbox — FIX 6)", () => {
  it("row inserted to DB is readable after 'restart' (fresh db reference)", async () => {
    const key = `test:restart:${Date.now()}`;
    const scheduledAt = new Date(Date.now() - 1000); // already past window

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: testMessageId,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: { text: "restart test" },
      scheduledAt,
    });

    // Simulate a restart by creating a brand-new db reference and reading the row
    const db2 = createDb(DATABASE_URL);
    const dueRows = await getDueOutboxRows(db2);
    const found = dueRows.find((r) => r.id === row.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("pending");

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
  });
});

describe("cancelOutboxRow (undo within window)", () => {
  it("transitions pending → canceled", async () => {
    const key = `test:cancel:${Date.now()}`;
    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: testMessageId,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() + 30_000),
    });

    const result = await cancelOutboxRow(db, testMessageId);
    expect(result.ok).toBe(true);

    const updated = await getOutboxRowByMessageId(db, testMessageId);
    expect(updated?.status).toBe("canceled");

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
  });

  it("returns already-terminal when row is already sent", async () => {
    // Insert a new message for this test to avoid conflicts
    const msg2 = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_outbox_test",
        body: "Second message",
      })
      .returning();

    const key = `test:already-sent:${Date.now()}`;
    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg2[0]!.id,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 1000),
    });

    // Manually mark it sent
    await markOutboxRowSent(db, row.id, "stub-ts");

    const result = await cancelOutboxRow(db, msg2[0]!.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("already-terminal");
    }

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg2[0]!.id));
  });
});

describe("getDueOutboxRows", () => {
  it("returns pending rows past their scheduled_at", async () => {
    const key = `test:due:${Date.now()}`;
    const msg3 = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_outbox_test",
        body: "Due row message",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg3[0]!.id,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 5000), // past
    });

    const dueRows = await getDueOutboxRows(db);
    expect(dueRows.some((r) => r.id === row.id)).toBe(true);

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg3[0]!.id));
  });

  it("does NOT return rows whose scheduled_at is in the future", async () => {
    const key = `test:future:${Date.now()}`;
    const msg4 = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_outbox_test",
        body: "Future row message",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg4[0]!.id,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() + 60_000), // future
    });

    const dueRows = await getDueOutboxRows(db);
    expect(dueRows.some((r) => r.id === row.id)).toBe(false);

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg4[0]!.id));
  });
});

describe("markOutboxRowSent (idempotency guard — double-post prevention)", () => {
  it("transitions pending → sent and returns true", async () => {
    const key = `test:mark-sent:${Date.now()}`;
    const msg5 = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_outbox_test",
        body: "Mark sent message",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg5[0]!.id,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 1000),
    });

    const result = await markOutboxRowSent(db, row.id, "real-ts.001");
    expect(result).toBe(true);

    const updated = await db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.id, row.id))
      .limit(1);
    expect(updated[0]?.status).toBe("sent");
    expect(updated[0]?.sentAt).not.toBeNull();

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg5[0]!.id));
  });

  it("returns false if the row is already sent (double-post guard)", async () => {
    const key = `test:double-guard:${Date.now()}`;
    const msg6 = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_outbox_test",
        body: "Double guard message",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg6[0]!.id,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 1000),
    });

    await markOutboxRowSent(db, row.id, "ts-1"); // first call
    const second = await markOutboxRowSent(db, row.id, "ts-2"); // second call — guard
    expect(second).toBe(false); // already sent — no double-post

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg6[0]!.id));
  });
});

// ── claimOutboxRow (P1-E: atomic claim for double-post prevention) ────────────

describe("claimOutboxRow (P1-E: atomic claim)", () => {
  it("atomically claims a pending row — transitions pending→sent and returns the id", async () => {
    const key = `test:claim:${Date.now()}`;
    const msg = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_claim_test",
        body: "Claim test message",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg[0]!.id,
      idempotencyKey: key,
      channelId: "C_CLAIM_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 1000),
    });

    const claimed = await claimOutboxRow(db, row.id);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(row.id);

    // Row is now 'sent'
    const updated = await db
      .select({ status: slackOutbox.status })
      .from(slackOutbox)
      .where(eq(slackOutbox.id, row.id))
      .limit(1);
    expect(updated[0]?.status).toBe("sent");

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg[0]!.id));
  });

  it("concurrent second claim of the same row returns null (double-post guard)", async () => {
    const key = `test:claim2:${Date.now()}`;
    const msg = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_claim_test2",
        body: "Concurrent claim test",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg[0]!.id,
      idempotencyKey: key,
      channelId: "C_CLAIM_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 1000),
    });

    // First claim succeeds
    const firstClaim = await claimOutboxRow(db, row.id);
    expect(firstClaim).not.toBeNull();

    // Second claim returns null — row is already 'sent', not 'pending'
    const secondClaim = await claimOutboxRow(db, row.id);
    expect(secondClaim).toBeNull();

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg[0]!.id));
  });
});

describe("markOutboxRowFailed", () => {
  it("increments attempts and transitions to 'failed' at MAX_ATTEMPTS (3)", async () => {
    const key = `test:failed:${Date.now()}`;
    const msg7 = await db
      .insert(messages)
      .values({
        ticketId: testTicketId,
        direction: "outbound",
        authorKind: "se",
        authorRef: "user_outbox_test",
        body: "Failed row message",
      })
      .returning();

    const row = await insertOutboxRow(db, {
      ticketId: testTicketId,
      messageId: msg7[0]!.id,
      idempotencyKey: key,
      channelId: "C_OUTBOX_TEST",
      payload: {},
      scheduledAt: new Date(Date.now() - 1000),
    });

    // First two attempts — should stay pending
    await markOutboxRowFailed(db, row.id, "error 1");
    let updated = await db.select().from(slackOutbox).where(eq(slackOutbox.id, row.id)).limit(1);
    expect(updated[0]?.status).toBe("pending");
    expect(updated[0]?.attempts).toBe(1);

    await markOutboxRowFailed(db, row.id, "error 2");
    updated = await db.select().from(slackOutbox).where(eq(slackOutbox.id, row.id)).limit(1);
    expect(updated[0]?.status).toBe("pending");
    expect(updated[0]?.attempts).toBe(2);

    // Third attempt — should transition to 'failed'
    await markOutboxRowFailed(db, row.id, "error 3");
    updated = await db.select().from(slackOutbox).where(eq(slackOutbox.id, row.id)).limit(1);
    expect(updated[0]?.status).toBe("failed");
    expect(updated[0]?.attempts).toBe(3);
    expect(updated[0]?.lastError).toBe("error 3");

    await db.delete(slackOutbox).where(eq(slackOutbox.id, row.id));
    await db.delete(messages).where(eq(messages.id, msg7[0]!.id));
  });
});
