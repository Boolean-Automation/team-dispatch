// dispatch — orphan-reply test (FIX 7)
//
// A thread reply ingested before its parent:
//   - does NOT crash
//   - does NOT silently drop the reply (returns orphan-reply, not ignored)
//   - does NOT fabricate a parent Ticket
//
// plan §Slice 4 / CONTRACT.md §"Orphan replies"

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

const ORPHAN_CHANNEL = "C_ORPHAN_TEST_001";

let TEST_REGISTRY: ParsedRegistry;

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const inserted = await db
    .insert(accounts)
    .values({
      slug: `orphan-test-${Date.now()}`,
      displayName: "Orphan Test Account",
      slackChannelIds: [ORPHAN_CHANNEL],
      health: "good",
    })
    .returning();

  testAccountId = inserted[0]!.id;
  testAccountSlug = inserted[0]!.slug;

  TEST_REGISTRY = {
    clients: [
      {
        slug: testAccountSlug,
        displayName: "Orphan Test Account",
        emailDomains: [],
        slackChannelIds: [ORPHAN_CHANNEL],
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

describe("orphan-reply handling (FIX 7)", () => {
  it("does not crash when a reply arrives before its parent", async () => {
    const orphanReplyTs = `${Date.now()}.orphan_reply_001`;
    const missingParentTs = `${Date.now()}.missing_parent_001`;

    const replyEvent = {
      source: "stub" as const,
      channelId: ORPHAN_CHANNEL,
      eventTs: orphanReplyTs,
      threadTs: missingParentTs,
      authorRef: "U_ORPHAN_001",
      body: "Orphan reply before parent",
      isTopLevel: false,
    };

    // Should not throw
    let result;
    expect(async () => {
      result = await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });
    }).not.toThrow();

    result = await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });
    expect(result).toBeDefined();
  });

  it("returns orphan-reply kind (not ignored or error)", async () => {
    const orphanReplyTs = `${Date.now()}.orphan_reply_002`;
    const missingParentTs = `${Date.now()}.missing_parent_002`;

    const replyEvent = {
      source: "stub" as const,
      channelId: ORPHAN_CHANNEL,
      eventTs: orphanReplyTs,
      threadTs: missingParentTs,
      authorRef: "U_ORPHAN_002",
      body: "Orphan reply test",
      isTopLevel: false,
    };

    const result = await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });

    expect(result.kind).toBe("orphan-reply");
  });

  it("does not fabricate a parent Ticket", async () => {
    const orphanReplyTs = `${Date.now()}.orphan_reply_003`;
    const missingParentTs = `${Date.now()}.missing_parent_003`;

    const ticketCountBefore = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.accountId, testAccountId));

    const replyEvent = {
      source: "stub" as const,
      channelId: ORPHAN_CHANNEL,
      eventTs: orphanReplyTs,
      threadTs: missingParentTs,
      authorRef: "U_ORPHAN_003",
      body: "No fabricated parent",
      isTopLevel: false,
    };

    await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });

    const ticketCountAfter = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.accountId, testAccountId));

    // No new tickets created
    expect(ticketCountAfter.length).toBe(ticketCountBefore.length);
  });

  it("does not silently drop the orphan reply — kind is orphan-reply with channel info", async () => {
    const orphanReplyTs = `${Date.now()}.orphan_reply_004`;
    const missingParentTs = `${Date.now()}.missing_parent_004`;

    const replyEvent = {
      source: "stub" as const,
      channelId: ORPHAN_CHANNEL,
      eventTs: orphanReplyTs,
      threadTs: missingParentTs,
      authorRef: "U_ORPHAN_004",
      body: "Orphan reply — should be visible in result",
      isTopLevel: false,
    };

    const result = await ingestMessage({ db, event: replyEvent, registry: TEST_REGISTRY });

    // Result carries enough info to identify the orphan
    expect(result.kind).toBe("orphan-reply");
    if (result.kind === "orphan-reply") {
      expect(result.channelId).toBe(ORPHAN_CHANNEL);
      expect(result.eventTs).toBe(orphanReplyTs);
      expect(result.threadTs).toBe(missingParentTs);
    }
  });
});
