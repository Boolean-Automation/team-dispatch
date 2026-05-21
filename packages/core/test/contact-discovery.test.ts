// dispatch — contact-discovery tests (FIX 2)
//
// Verifies: channel-membership sync upserts contacts with
//   slack_user_id + discovered_via = 'channel-membership'
//
// The Slack conversations.members client is injected as a mock.
//
// plan §Slice 4

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createDb } from "../../db/src/client.js";
import { accounts, contacts } from "../../db/src/schema.js";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/src/client.js";
import {
  contactDiscoverySync,
  resolveContactBySlackUser,
} from "../src/services/contact-discovery.js";
import type { SlackMembersClient } from "../src/services/contact-discovery.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://cody@localhost:5432/dispatch_test";

let db: Db;
let testAccountId: string;

const DISC_CHANNEL_1 = "C_DISC_TEST_001";
const DISC_CHANNEL_2 = "C_DISC_TEST_002";

const MEMBER_A = "U_DISC_MEMBER_A";
const MEMBER_B = "U_DISC_MEMBER_B";
const INTERNAL_USER = "U_DISC_INTERNAL";

beforeAll(async () => {
  db = createDb(DATABASE_URL);

  const inserted = await db
    .insert(accounts)
    .values({
      slug: `disc-test-${Date.now()}`,
      displayName: "Contact Discovery Test",
      slackChannelIds: [DISC_CHANNEL_1, DISC_CHANNEL_2],
      health: "good",
    })
    .returning();

  testAccountId = inserted[0]!.id;
});

afterAll(async () => {
  await db.delete(contacts).where(eq(contacts.accountId, testAccountId));
  await db.delete(accounts).where(eq(accounts.id, testAccountId));
});

// ── Mock Slack client ──────────────────────────────────────────────────────────

function makeMockSlackClient(
  members: Record<string, string[]>
): SlackMembersClient {
  return {
    getChannelMembers: vi.fn(async (channelId: string) => {
      return members[channelId] ?? [];
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("contactDiscoverySync", () => {
  it("upserts contacts with slack_user_id + discovered_via=channel-membership", async () => {
    const mockClient = makeMockSlackClient({
      [DISC_CHANNEL_1]: [MEMBER_A, MEMBER_B, INTERNAL_USER],
      [DISC_CHANNEL_2]: [],
    });

    const result = await contactDiscoverySync(db, {
      slackClient: mockClient,
      isInternal: (uid) => uid === INTERNAL_USER,
    });

    // Should have upserted MEMBER_A and MEMBER_B (not INTERNAL_USER)
    expect(result.upserted).toBeGreaterThanOrEqual(2);

    // Verify contacts in DB
    const contactA = await resolveContactBySlackUser(db, MEMBER_A);
    expect(contactA).not.toBeNull();
    expect(contactA!.accountId).toBe(testAccountId);
    expect(contactA!.discoveredVia).toBe("channel-membership");

    const contactB = await resolveContactBySlackUser(db, MEMBER_B);
    expect(contactB).not.toBeNull();
    expect(contactB!.accountId).toBe(testAccountId);
    expect(contactB!.discoveredVia).toBe("channel-membership");

    // Internal user should NOT be in contacts for this account
    const internalContact = await db
      .select()
      .from(contacts)
      .where(eq(contacts.slackUserId, INTERNAL_USER))
      .limit(1);
    expect(internalContact.length).toBe(0);
  });

  it("does not re-upsert an already discovered contact", async () => {
    // MEMBER_A was already discovered above
    const contactBefore = await resolveContactBySlackUser(db, MEMBER_A);
    expect(contactBefore).not.toBeNull();

    const mockClient = makeMockSlackClient({
      [DISC_CHANNEL_1]: [MEMBER_A],
      [DISC_CHANNEL_2]: [],
    });

    const result = await contactDiscoverySync(db, {
      slackClient: mockClient,
    });

    // No new upserts for already-discovered member
    expect(result.upserted).toBe(0);

    // Still only one contact row for MEMBER_A
    const allA = await db
      .select()
      .from(contacts)
      .where(eq(contacts.slackUserId, MEMBER_A));
    expect(allA.length).toBe(1);
  });

  it("handles a channel whose member fetch fails gracefully", async () => {
    const mockClient: SlackMembersClient = {
      getChannelMembers: async (channelId: string) => {
        if (channelId === DISC_CHANNEL_1) {
          throw new Error("Slack API error");
        }
        return [];
      },
    };

    // Should not throw
    await expect(
      contactDiscoverySync(db, { slackClient: mockClient })
    ).resolves.toBeDefined();
  });

  it("reports per-channel breakdown", async () => {
    const memberC = `U_DISC_MEMBER_C_${Date.now()}`;
    const mockClient = makeMockSlackClient({
      [DISC_CHANNEL_1]: [memberC],
      [DISC_CHANNEL_2]: [],
    });

    const result = await contactDiscoverySync(db, {
      slackClient: mockClient,
    });

    expect(result.channels.length).toBeGreaterThanOrEqual(2);

    const ch1 = result.channels.find((c) => c.channelId === DISC_CHANNEL_1);
    expect(ch1).toBeDefined();
    expect(ch1!.membersFound).toBe(1);
  });
});

describe("resolveContactBySlackUser", () => {
  it("resolves a discovered contact to their account", async () => {
    const contact = await resolveContactBySlackUser(db, MEMBER_A);
    expect(contact).not.toBeNull();
    expect(contact!.accountId).toBe(testAccountId);
    expect(contact!.slackUserId).toBe(MEMBER_A);
  });

  it("returns null for an undiscovered user", async () => {
    const contact = await resolveContactBySlackUser(
      db,
      "U_COMPLETELY_UNKNOWN_USER"
    );
    expect(contact).toBeNull();
  });
});
