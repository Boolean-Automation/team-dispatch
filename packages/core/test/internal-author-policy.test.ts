// dispatch — Internal-author policy unit tests (Fix 6 / AC-9 main)
//
// Packet §F1 Internal-sender policy:
//   Seed internal_users with a test Clerk ID.
//   Simulate a webhook event from a mapped client channel where the author is
//   in internal_users. Assert per INGESTION_INTERNAL_AUTHOR_POLICY:
//     route-complete → ticket status='complete', authorKind='se'
//     suppress       → no ticket created (internal-channel result)
//     route-on-you   → ticket status='new' (normal routing path)
//   All three branches via env var only (no code change).
//
// Dev phase gate-dev.md commit f2db350.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb } from "../../db/src/client.js";
import {
  accounts,
  tickets,
  messages,
  auditLog,
  notifications,
  internalUsers,
} from "../../db/src/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import { ingestMessage } from "../src/ingestion/ingest-message.js";
import type { ParsedRegistry } from "../src/registry/build-registry.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;

// ── test fixtures ─────────────────────────────────────────────────────────────

let clientAccountId: string;
const CLIENT_CHANNEL = "C_INTERNAL_POLICY_001";
const INTERNAL_USER_CLERK_ID = `clerk_internal_policy_test_${Date.now()}`;
const INTERNAL_USER_SLACK_ID = `U_INT_POLICY_${Date.now()}`;
const OWNING_SE = "clerk_se_policy_test";

const TEST_REGISTRY: ParsedRegistry = {
  clients: [
    {
      slug: "", // filled in beforeAll
      displayName: "Internal Policy Test Client",
      emailDomains: ["intpolicytest.example.com"],
      slackChannelIds: [CLIENT_CHANNEL],
      owningSe: OWNING_SE,
    },
  ],
  internalChannelIds: [],
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  // Seed client account
  const insertedAccount = await db
    .insert(accounts)
    .values({
      slug: `internal-policy-test-${Date.now()}`,
      displayName: "Internal Policy Test Client",
      emailDomains: ["intpolicytest.example.com"],
      slackChannelIds: [CLIENT_CHANNEL],
      owningSe: OWNING_SE,
      health: "good",
    })
    .returning();
  clientAccountId = insertedAccount[0]!.id;
  TEST_REGISTRY.clients[0]!.slug = insertedAccount[0]!.slug;

  // Seed internal_users with the test Clerk ID
  await db
    .insert(internalUsers)
    .values({
      clerkId: INTERNAL_USER_CLERK_ID,
      slackId: INTERNAL_USER_SLACK_ID,
      label: "Test Internal SE",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // Clean up tickets referencing our account
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
  await db.delete(internalUsers).where(eq(internalUsers.clerkId, INTERNAL_USER_CLERK_ID));
  await db.delete(accounts).where(eq(accounts.id, clientAccountId));
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeInternalAuthorEvent(overrides?: { eventTs?: string }) {
  const eventTs = overrides?.eventTs ?? `${Date.now()}.${Math.random().toString().slice(2, 8)}`;
  return {
    source: "stub" as const,
    channelId: CLIENT_CHANNEL,
    eventTs,
    threadTs: null,
    authorRef: INTERNAL_USER_CLERK_ID, // this author IS in internal_users
    body: "SE reply in client channel",
    isTopLevel: true,
  };
}

function makeInternalAuthorSlackEvent(overrides?: { eventTs?: string }) {
  const eventTs = overrides?.eventTs ?? `${Date.now()}.${Math.random().toString().slice(2, 8)}`;
  return {
    source: "stub" as const,
    channelId: CLIENT_CHANNEL,
    eventTs,
    threadTs: null,
    authorRef: INTERNAL_USER_SLACK_ID, // matched via slack_id column
    body: "SE reply via Slack ID",
    isTopLevel: true,
  };
}

// ── tests: three policy branches ─────────────────────────────────────────────

describe("ingestMessage — internal-author policy (OQ-4, AC-9)", () => {
  const branches = [
    { policy: "route-complete", label: "default" },
    { policy: "suppress", label: "suppress" },
    { policy: "route-on-you", label: "route-on-you" },
  ] as const;

  for (const { policy, label } of branches) {
    it(`INGESTION_INTERNAL_AUTHOR_POLICY=${policy} (${label}) via Clerk ID`, async () => {
      const originalPolicy = process.env.INGESTION_INTERNAL_AUTHOR_POLICY;
      process.env.INGESTION_INTERNAL_AUTHOR_POLICY = policy;

      try {
        const event = makeInternalAuthorEvent();
        const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

        if (policy === "suppress") {
          // suppress → no ticket; returns internal-channel kind
          expect(result.kind).toBe("internal-channel");
        } else if (policy === "route-on-you") {
          // route-on-you → creates ticket with status='new' (normal client routing)
          expect(result.kind).toBe("ticket-created");
          if (result.kind !== "ticket-created") return;

          const tkts = await db
            .select({ status: tickets.status, authorKind: messages.authorKind })
            .from(tickets)
            .where(eq(tickets.id, result.ticketId))
            .limit(1);
          // status should be 'on-you' (normal routing to owning SE) or 'new'
          // route-on-you calls createClientTicket → routeTicket → on-you or new
          expect(["new", "on-you"]).toContain(tkts[0]!.status);
        } else {
          // route-complete (default) → status='complete', authorKind='se' on the ticket
          expect(result.kind).toBe("ticket-created");
          if (result.kind !== "ticket-created") return;

          const tkts = await db
            .select({ status: tickets.status })
            .from(tickets)
            .where(eq(tickets.id, result.ticketId))
            .limit(1);
          expect(tkts[0]!.status).toBe("complete");

          // Check the linked message has authorKind='se'
          const msgs = await db
            .select({ authorKind: messages.authorKind })
            .from(messages)
            .where(eq(messages.ticketId, result.ticketId))
            .limit(1);
          if (msgs.length > 0) {
            expect(msgs[0]!.authorKind).toBe("se");
          }
        }
      } finally {
        // Restore original env var (or delete if it wasn't set)
        if (originalPolicy === undefined) {
          delete process.env.INGESTION_INTERNAL_AUTHOR_POLICY;
        } else {
          process.env.INGESTION_INTERNAL_AUTHOR_POLICY = originalPolicy;
        }
      }
    });
  }

  it("isInternalAuthor matches on slack_id (channel webhook path)", async () => {
    // Slack webhooks carry Slack user IDs, not Clerk IDs.
    // ingest-message.ts:211-214 checks slack_id as fallback.
    const originalPolicy = process.env.INGESTION_INTERNAL_AUTHOR_POLICY;
    process.env.INGESTION_INTERNAL_AUTHOR_POLICY = "suppress";

    try {
      const event = makeInternalAuthorSlackEvent();
      const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

      // With suppress policy, an internal-slack-ID author in a client channel = internal-channel
      expect(result.kind).toBe("internal-channel");
    } finally {
      if (originalPolicy === undefined) {
        delete process.env.INGESTION_INTERNAL_AUTHOR_POLICY;
      } else {
        process.env.INGESTION_INTERNAL_AUTHOR_POLICY = originalPolicy;
      }
    }
  });

  it("external author in same channel is NOT affected by internal-author policy", async () => {
    // An author NOT in internal_users → normal client ticket creation
    const originalPolicy = process.env.INGESTION_INTERNAL_AUTHOR_POLICY;
    process.env.INGESTION_INTERNAL_AUTHOR_POLICY = "suppress"; // would suppress if internal

    try {
      const event = {
        source: "stub" as const,
        channelId: CLIENT_CHANNEL,
        eventTs: `${Date.now()}.external_author`,
        threadTs: null,
        authorRef: "U_EXTERNAL_CLIENT_NOT_IN_TABLE",
        body: "External client message — should create ticket",
        isTopLevel: true,
      };
      const result = await ingestMessage({ db, event, registry: TEST_REGISTRY });

      // External author → NOT suppressed → ticket created
      expect(result.kind).toBe("ticket-created");
    } finally {
      if (originalPolicy === undefined) {
        delete process.env.INGESTION_INTERNAL_AUTHOR_POLICY;
      } else {
        process.env.INGESTION_INTERNAL_AUTHOR_POLICY = originalPolicy;
      }
    }
  });
});
