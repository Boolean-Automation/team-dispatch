// dispatch — ingestMessage unit tests
//
// Tests the core ingestion function against the real dispatch_test database.
// Covers: client-channel top-level message, internal-channel no-op,
//         unknown-origin unassigned ticket, routing to owning SE.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, contacts, tickets, messages, auditLog, notifications } from "../../db/src/schema.js";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { ingestMessage } from "../src/ingestion/ingest-message.js";
import type { ParsedRegistry } from "../src/registry/build-registry.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;

// ── test fixtures ─────────────────────────────────────────────────────────────

let clientAccountId: string;
let clientAccountSlug: string;
const CLIENT_CHANNEL = "C_INGEST_CLIENT_001";
const INTERNAL_CHANNEL = "C_INGEST_INTERNAL_001";
const UNKNOWN_CHANNEL = "C_INGEST_UNKNOWN_001";
const OWNING_SE = "clerk_user_ingest_se";

const TEST_REGISTRY: ParsedRegistry = {
  clients: [
    {
      slug: "",  // filled in beforeAll
      displayName: "Ingest Test Client",
      emailDomains: ["ingesttest.example.com"],
      slackChannelIds: [CLIENT_CHANNEL],
      owningSe: OWNING_SE,
    },
  ],
  internalChannelIds: [INTERNAL_CHANNEL],
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const inserted = await db
    .insert(accounts)
    .values({
      slug: `ingest-test-${Date.now()}`,
      displayName: "Ingest Test Client",
      emailDomains: ["ingesttest.example.com"],
      slackChannelIds: [CLIENT_CHANNEL],
      owningSe: OWNING_SE,
      health: "good",
    })
    .returning();

  clientAccountId = inserted[0]!.id;
  clientAccountSlug = inserted[0]!.slug;

  // Update registry to use real slug
  TEST_REGISTRY.clients[0]!.slug = clientAccountSlug;
});

afterAll(async () => {
  // Clean up: delete notifications + audit log entries referencing our tickets,
  // then tickets, then contacts, then accounts
  const testTickets = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.accountId, clientAccountId));

  for (const t of testTickets) {
    await db.delete(notifications).where(eq(notifications.ticketId, t.id));
    await db.delete(auditLog).where(eq(auditLog.ticketId, t.id));
    await db.delete(messages).where(eq(messages.ticketId, t.id));
  }

  await db.delete(tickets).where(eq(tickets.accountId, clientAccountId));
  await db.delete(contacts).where(eq(contacts.accountId, clientAccountId));
  await db.delete(accounts).where(eq(accounts.id, clientAccountId));
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: {
  channelId?: string;
  eventTs?: string;
  threadTs?: string | null;
  authorRef?: string;
  body?: string;
  isTopLevel?: boolean;
}) {
  const eventTs = overrides.eventTs ?? `${Date.now()}.${Math.random().toString().slice(2, 8)}`;
  return {
    source: "stub" as const,
    channelId: overrides.channelId ?? CLIENT_CHANNEL,
    eventTs,
    threadTs: overrides.threadTs ?? null,
    authorRef: overrides.authorRef ?? "U_TEST_001",
    body: overrides.body ?? "Hello from ingest test",
    isTopLevel: overrides.isTopLevel ?? true,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("ingestMessage — top-level messages", () => {
  it("creates a ticket for a client-channel message", async () => {
    const event = makeEvent({ channelId: CLIENT_CHANNEL });
    const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.accountId).toBe(clientAccountId);
    expect(result.originClass).toBe("client");
    expect(result.undoToken).toBeTruthy();
  });

  it("returns internal-channel for a registered internal channel", async () => {
    const event = makeEvent({ channelId: INTERNAL_CHANNEL });
    const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

    expect(result.kind).toBe("internal-channel");
  });

  it("creates an unassigned ticket for an unknown channel", async () => {
    const event = makeEvent({ channelId: UNKNOWN_CHANNEL });
    const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.originClass).toBe("unknown");
  });
});

describe("ingestMessage — routing", () => {
  it("routes to owning SE and sets status on-you", async () => {
    const event = makeEvent({
      channelId: CLIENT_CHANNEL,
      eventTs: `${Date.now()}.routing_test`,
    });
    const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    // Check the ticket was routed
    const tkts = await db
      .select({ assignee: tickets.assignee, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, result.ticketId))
      .limit(1);

    expect(tkts[0]!.assignee).toBe(OWNING_SE);
    expect(tkts[0]!.status).toBe("on-you");
  });

  it("creates a ticket-assigned notification for the owning SE", async () => {
    const event = makeEvent({
      channelId: CLIENT_CHANNEL,
      eventTs: `${Date.now()}.notif_test`,
    });
    const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.ticketId, result.ticketId),
          eq(notifications.recipientId, OWNING_SE)
        )
      );

    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0]!.kind).toBe("ticket-assigned");
  });
});

describe("ingestMessage — audit log", () => {
  it("appends a ticket.created audit entry", async () => {
    const event = makeEvent({
      channelId: CLIENT_CHANNEL,
      eventTs: `${Date.now()}.audit_test`,
    });
    const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ticketId, result.ticketId));

    const createdEntry = entries.find((e) => e.event === "ticket.created");
    expect(createdEntry).toBeDefined();
    expect(createdEntry!.undoToken).toBe(result.undoToken);
  });
});
