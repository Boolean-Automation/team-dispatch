// dispatch — idempotency acceptance test
//
// Guarantees: same (channelId, eventTs) delivered twice creates
// exactly one Ticket (top-level) or one Message (thread reply).
//
// plan §Slice 4 / CONTRACT.md — idempotency is a hard guarantee

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, tickets, messages, auditLog, notifications } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { ingestMessage } from "../src/ingestion/ingest-message.js";
import type { ParsedRegistry } from "../src/registry/build-registry.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;
let testAccountSlug: string;

const IDEM_CHANNEL = "C_IDEM_TEST_001";

let TEST_REGISTRY: ParsedRegistry;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const inserted = await db
    .insert(accounts)
    .values({
      slug: `idem-test-${Date.now()}`,
      displayName: "Idempotency Test Account",
      slackChannelIds: [IDEM_CHANNEL],
      health: "good",
    })
    .returning();

  testAccountId = inserted[0]!.id;
  testAccountSlug = inserted[0]!.slug;

  TEST_REGISTRY = {
    clients: [
      {
        slug: testAccountSlug,
        displayName: "Idempotency Test Account",
        emailDomains: [],
        slackChannelIds: [IDEM_CHANNEL],
        owningSe: null,
      },
    ],
    internalChannelIds: [],
  };
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

describe("idempotency — top-level messages", () => {
  it("delivers the same (channelId, eventTs) twice → exactly one Ticket", async () => {
    const event = {
      source: "stub" as const,
      channelId: IDEM_CHANNEL,
      eventTs: `${Date.now()}.idem_toplevel_001`,
      threadTs: null,
      authorRef: "U_IDEM_001",
      body: "Idempotency test message",
      isTopLevel: true,
    };

    // First delivery
    const result1 = await ingestMessage({ db, event, registry: TEST_REGISTRY });
    expect(result1.kind).toBe("ticket-created");

    // Second delivery — same event
    const result2 = await ingestMessage({ db, event, registry: TEST_REGISTRY });
    expect(result2.kind).toBe("ticket-exists");

    // Confirm only one ticket exists with this source_event_ts
    const tkts = await db
      .select()
      .from(tickets)
      .where(eq(tickets.sourceEventTs, event.eventTs));

    expect(tkts.length).toBe(1);

    if (result1.kind === "ticket-created" && result2.kind === "ticket-exists") {
      expect(result2.ticketId).toBe(result1.ticketId);
    }
  });

  it("delivers 5 copies of the same event → still exactly one Ticket", async () => {
    const event = {
      source: "stub" as const,
      channelId: IDEM_CHANNEL,
      eventTs: `${Date.now()}.idem_five_001`,
      threadTs: null,
      authorRef: "U_IDEM_002",
      body: "Five copies test",
      isTopLevel: true,
    };

    const results = await Promise.all([
      ingestMessage({ db, event, registry: TEST_REGISTRY }),
      ingestMessage({ db, event, registry: TEST_REGISTRY }),
      ingestMessage({ db, event, registry: TEST_REGISTRY }),
      ingestMessage({ db, event, registry: TEST_REGISTRY }),
      ingestMessage({ db, event, registry: TEST_REGISTRY }),
    ]);

    const created = results.filter((r) => r.kind === "ticket-created");
    const existed = results.filter((r) => r.kind === "ticket-exists");

    // Exactly one created, four acknowledged as existing
    // Note: due to race, some may error on the unique constraint and return ticket-exists
    expect(created.length + existed.length).toBe(5);

    const tkts = await db
      .select()
      .from(tickets)
      .where(eq(tickets.sourceEventTs, event.eventTs));

    expect(tkts.length).toBe(1);
  });
});

describe("idempotency — thread replies", () => {
  it("delivers the same reply (channelId, eventTs) twice → exactly one Message", async () => {
    const parentTs = `${Date.now()}.idem_parent_001`;
    const replyTs = `${Date.now()}.idem_reply_001`;

    // First: ingest the parent
    const parentEvent = {
      source: "stub" as const,
      channelId: IDEM_CHANNEL,
      eventTs: parentTs,
      threadTs: null,
      authorRef: "U_IDEM_PARENT",
      body: "Parent message",
      isTopLevel: true,
    };
    const parentResult = await ingestMessage({
      db,
      event: parentEvent,
      registry: TEST_REGISTRY,
    });
    expect(parentResult.kind).toBe("ticket-created");

    // Now deliver the same reply twice
    const replyEvent = {
      source: "stub" as const,
      channelId: IDEM_CHANNEL,
      eventTs: replyTs,
      threadTs: parentTs,
      authorRef: "U_IDEM_REPLY",
      body: "Reply message",
      isTopLevel: false,
    };

    const reply1 = await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });
    const reply2 = await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });

    expect(reply1.kind).toBe("message-created");
    expect(reply2.kind).toBe("message-exists");

    if (reply1.kind === "message-created" && reply2.kind === "message-exists") {
      expect(reply2.messageId).toBe(reply1.messageId);
    }

    // Confirm exactly one message with this slackTs
    if (parentResult.kind === "ticket-created") {
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.slackTs, replyTs));
      expect(msgs.length).toBe(1);
    }
  });
});
