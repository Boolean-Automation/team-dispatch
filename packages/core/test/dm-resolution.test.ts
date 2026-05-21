// dispatch — DM / group-DM account resolution tests (P1-A / A9, P1-B / A10)
//
// Tests:
//   1. DM from a discovered Contact resolves to that Contact's Account (sourceKind='dm')
//   2. DM from an author with no Contact → unknown-origin, lands on __unrouted__ account
//   3. group-DM resolves to the single client participant's Account
//   4. group-DM spanning two different client Accounts → unknown-origin
//   5. Unknown-origin ticket has assignee=null (unassigned — A10)
//   6. Unknown-origin ticket is NOT routed to any real account (lands on __unrouted__)
//   7. Unknown-origin ticket source_kind is stamped from event.sourceKind

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import {
  accounts,
  contacts,
  tickets,
  messages,
  auditLog,
  notifications,
} from "../../db/src/schema.js";
import { eq, and } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { ingestMessage } from "../src/ingestion/ingest-message.js";
import type { ParsedRegistry } from "../src/registry/build-registry.js";
import { UNROUTED_ACCOUNT_SLUG } from "../src/services/contact-discovery.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let clientAccountIdA: string;
let clientAccountIdB: string;
let unroutedAccountId: string;

const DM_CHANNEL_A = `D_DMRES_A_${Date.now()}`;
const DM_CHANNEL_B = `D_DMRES_B_${Date.now()}`;
const DM_CHANNEL_UNKNOWN = `D_DMRES_UNKN_${Date.now()}`;
const GROUP_DM_CHANNEL = `G_DMRES_GRP_${Date.now()}`;
const AMBIGUOUS_GROUP_DM = `G_DMRES_AMBIG_${Date.now()}`;

const USER_A = `U_DMRES_A_${Date.now()}`;
const USER_B = `U_DMRES_B_${Date.now()}`;
const UNKNOWN_USER = `U_DMRES_UNKN_${Date.now()}`;

const EMPTY_REGISTRY: ParsedRegistry = {
  clients: [],
  internalChannelIds: [],
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  // Create two client accounts
  const acctA = await db
    .insert(accounts)
    .values({
      slug: `dmres-a-${Date.now()}`,
      displayName: "DM Res Client A",
      emailDomains: [],
      slackChannelIds: [],
      owningSe: "clerk_dmres_se_a",
      health: "good",
    })
    .returning();
  clientAccountIdA = acctA[0]!.id;

  const acctB = await db
    .insert(accounts)
    .values({
      slug: `dmres-b-${Date.now()}`,
      displayName: "DM Res Client B",
      emailDomains: [],
      slackChannelIds: [],
      owningSe: "clerk_dmres_se_b",
      health: "good",
    })
    .returning();
  clientAccountIdB = acctB[0]!.id;

  // Discover USER_A → Account A, USER_B → Account B
  await db.insert(contacts).values([
    {
      accountId: clientAccountIdA,
      slackUserId: USER_A,
      discoveredVia: "channel-membership",
    },
    {
      accountId: clientAccountIdB,
      slackUserId: USER_B,
      discoveredVia: "channel-membership",
    },
  ]);

  // Ensure the __unrouted__ account exists and capture its id
  const unroutedRows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.slug, UNROUTED_ACCOUNT_SLUG))
    .limit(1);
  unroutedAccountId = unroutedRows[0]?.id ?? "";
  // If it doesn't exist yet, ingestMessage will create it on first unknown-origin event
});

afterAll(async () => {
  // Clean up tickets on both test accounts and __unrouted__
  const allTestAccountIds = [clientAccountIdA, clientAccountIdB];
  if (unroutedAccountId) allTestAccountIds.push(unroutedAccountId);

  for (const accountId of allTestAccountIds) {
    const testTickets = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.accountId, accountId));

    for (const t of testTickets) {
      await db.delete(notifications).where(eq(notifications.ticketId, t.id));
      await db.delete(auditLog).where(eq(auditLog.ticketId, t.id));
      await db.delete(messages).where(eq(messages.ticketId, t.id));
    }
    await db.delete(tickets).where(eq(tickets.accountId, accountId));
  }

  await db.delete(contacts).where(eq(contacts.accountId, clientAccountIdA));
  await db.delete(contacts).where(eq(contacts.accountId, clientAccountIdB));
  await db.delete(accounts).where(eq(accounts.id, clientAccountIdA));
  await db.delete(accounts).where(eq(accounts.id, clientAccountIdB));
  // Do NOT delete the __unrouted__ account — it's a persistent system account
});

// ── P1-A: DM resolution via discovered Contact ────────────────────────────────

describe("DM resolution via discovered Contact (P1-A / A9)", () => {
  it("DM from a discovered Contact resolves to that Contact's Account", async () => {
    const event = {
      source: "stub" as const,
      channelId: DM_CHANNEL_A,
      eventTs: `${Date.now()}.dm_resolved_001`,
      threadTs: null,
      authorRef: USER_A,
      body: "Hi from discovered user A",
      isTopLevel: true,
      sourceKind: "dm" as const,
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.accountId).toBe(clientAccountIdA);
    expect(result.originClass).toBe("client");
  });

  it("DM from a different discovered Contact resolves to that Contact's Account", async () => {
    const event = {
      source: "stub" as const,
      channelId: DM_CHANNEL_B,
      eventTs: `${Date.now()}.dm_resolved_002`,
      threadTs: null,
      authorRef: USER_B,
      body: "Hi from discovered user B",
      isTopLevel: true,
      sourceKind: "dm" as const,
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.accountId).toBe(clientAccountIdB);
    expect(result.originClass).toBe("client");
  });

  it("DM author with no discovered Contact → unknown-origin, unassigned (A9 / P1-B)", async () => {
    const event = {
      source: "stub" as const,
      channelId: DM_CHANNEL_UNKNOWN,
      eventTs: `${Date.now()}.dm_unknown_001`,
      threadTs: null,
      authorRef: UNKNOWN_USER,
      body: "Hi from unknown user",
      isTopLevel: true,
      sourceKind: "dm" as const,
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.originClass).toBe("unknown");

    // Ticket must be unassigned (A10)
    const ticketRow = await db
      .select({ assignee: tickets.assignee, accountId: tickets.accountId })
      .from(tickets)
      .where(eq(tickets.id, result.ticketId))
      .limit(1);

    expect(ticketRow[0]!.assignee).toBeNull();

    // Ticket must land on __unrouted__ account, NOT on any client account (P1-B)
    expect(ticketRow[0]!.accountId).not.toBe(clientAccountIdA);
    expect(ticketRow[0]!.accountId).not.toBe(clientAccountIdB);
  });
});

// ── P1-A: group-DM resolution ─────────────────────────────────────────────────

describe("group-DM resolution (P1-A / A9)", () => {
  it("group-DM resolves to the single client participant's Account", async () => {
    const event = {
      source: "stub" as const,
      channelId: GROUP_DM_CHANNEL,
      eventTs: `${Date.now()}.grpdm_001`,
      threadTs: null,
      authorRef: USER_A,
      body: "Hi from group DM",
      isTopLevel: true,
      sourceKind: "group-dm" as const,
      participantUserIds: [USER_A, UNKNOWN_USER], // A is discovered, unknown is not
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.accountId).toBe(clientAccountIdA);
    expect(result.originClass).toBe("client");
  });

  it("group-DM spanning two different client Accounts → unknown-origin (ambiguous)", async () => {
    const event = {
      source: "stub" as const,
      channelId: AMBIGUOUS_GROUP_DM,
      eventTs: `${Date.now()}.grpdm_ambig_001`,
      threadTs: null,
      authorRef: USER_A,
      body: "Ambiguous group DM",
      isTopLevel: true,
      sourceKind: "group-dm" as const,
      participantUserIds: [USER_A, USER_B], // A→AccountA, B→AccountB: ambiguous
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.originClass).toBe("unknown");

    // Must be unassigned
    const ticketRow = await db
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, result.ticketId))
      .limit(1);

    expect(ticketRow[0]!.assignee).toBeNull();
  });
});

// ── P1-B: unknown-origin quarantine ──────────────────────────────────────────

describe("unknown-origin quarantine on __unrouted__ account (P1-B / A10)", () => {
  it("unknown-origin ticket has assignee=null and lands on __unrouted__ account", async () => {
    const event = {
      source: "stub" as const,
      channelId: `C_UNKN_QUARANTINE_${Date.now()}`,
      eventTs: `${Date.now()}.quarantine_001`,
      threadTs: null,
      authorRef: "U_QUARANTINE_TEST",
      body: "Unknown origin message",
      isTopLevel: true,
      // sourceKind omitted → defaults to 'channel', unknown channel
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.originClass).toBe("unknown");

    // The account must be __unrouted__, not a real client account
    const unroutedAcct = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.slug, UNROUTED_ACCOUNT_SLUG))
      .limit(1);

    expect(unroutedAcct[0]).toBeDefined();
    expect(result.accountId).toBe(unroutedAcct[0]!.id);

    // Ticket must be unassigned (A10)
    const ticketRow = await db
      .select({ assignee: tickets.assignee, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, result.ticketId))
      .limit(1);

    expect(ticketRow[0]!.assignee).toBeNull();
  });

  it("unknown-origin ticket source_kind is stamped from event.sourceKind", async () => {
    const event = {
      source: "stub" as const,
      channelId: `D_UNKN_DM_${Date.now()}`,
      eventTs: `${Date.now()}.quarantine_dm_001`,
      threadTs: null,
      authorRef: UNKNOWN_USER + "_dm",
      body: "DM from unknown user",
      isTopLevel: true,
      sourceKind: "dm" as const,
    };

    const result = await ingestMessage({ db, event, registry: EMPTY_REGISTRY });

    expect(result.kind).toBe("ticket-created");
    if (result.kind !== "ticket-created") return;

    expect(result.originClass).toBe("unknown");

    const ticketRow = await db
      .select({ sourceKind: tickets.sourceKind })
      .from(tickets)
      .where(eq(tickets.id, result.ticketId))
      .limit(1);

    expect(ticketRow[0]!.sourceKind).toBe("dm");
  });
});
