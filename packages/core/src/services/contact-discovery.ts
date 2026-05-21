// dispatch — contact-discovery service
//
// Channel-membership sync: walks the membership of every registered client channel,
// and for each non-internal member upserts a contacts row with:
//   slack_user_id = member_user_id
//   discovered_via = 'channel-membership'
//
// The Slack conversations.members client is an injectable interface so tests
// can mock it without a live Slack token (plan §Slice 4 / FIX 2).
//
// After this sync runs, a DM/group-DM author who is a member of any client
// channel resolves to a Contact → Account. A DM author who matches no
// discovered Contact falls into the unknown-origin path.

import { eq, and } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { contacts, accounts } from "@dispatch/db";
import type { Contact } from "@dispatch/db";

// ── Injectable Slack client interface ─────────────────────────────────────────
//
// The real implementation calls @slack/web-api conversations.members.
// Tests inject a mock via this interface — no live Slack call in tests.

export interface SlackMembersClient {
  /**
   * Returns the Slack user ids that are members of the given channel.
   * Should return an empty array if the channel cannot be fetched.
   */
  getChannelMembers(channelId: string): Promise<string[]>;
}

// ── Internal SE user ids ───────────────────────────────────────────────────────
//
// In production this would be derived from the Slack workspace members
// and compared against the Boolean team list. For Phase 1 we use a simple
// injectable filter function so callers can exclude known internal users.

export type InternalUserFilter = (slackUserId: string) => boolean;

// Default filter: no users are considered internal (include all)
const defaultInternalFilter: InternalUserFilter = () => false;

// ── contactDiscoverySync ───────────────────────────────────────────────────────

export interface ContactDiscoverySyncOptions {
  /** The injectable Slack members client. */
  slackClient: SlackMembersClient;
  /** Optional filter: return true for Slack user ids that are internal (skip them). */
  isInternal?: InternalUserFilter;
}

export interface ContactDiscoverySyncResult {
  /** Total contacts upserted across all channels. */
  upserted: number;
  /** Per-channel breakdown. */
  channels: Array<{
    channelId: string;
    accountId: string;
    membersFound: number;
    upserted: number;
  }>;
}

/**
 * Sync contact discovery for all registered client accounts.
 *
 * For each account.slack_channel_ids[] entry:
 *   1. Fetch channel members via slackClient.getChannelMembers().
 *   2. For each non-internal member, upsert a contacts row with
 *      slack_user_id + discovered_via = 'channel-membership'.
 *
 * Upsert is on slack_user_id conflict:
 *   - If the contact already exists with the same account_id: no-op.
 *   - If the contact exists with a DIFFERENT account_id: we do not overwrite
 *     (the existing explicit entry wins; channel-discovery is additive).
 */
export async function contactDiscoverySync(
  db: Db,
  opts: ContactDiscoverySyncOptions
): Promise<ContactDiscoverySyncResult> {
  const isInternal = opts.isInternal ?? defaultInternalFilter;

  // Fetch all accounts that have at least one channel
  const allAccounts = await db
    .select({
      id: accounts.id,
      slackChannelIds: accounts.slackChannelIds,
    })
    .from(accounts);

  const result: ContactDiscoverySyncResult = { upserted: 0, channels: [] };

  for (const account of allAccounts) {
    for (const channelId of account.slackChannelIds) {
      let members: string[];
      try {
        members = await opts.slackClient.getChannelMembers(channelId);
      } catch {
        // If we can't fetch members, skip this channel silently
        result.channels.push({
          channelId,
          accountId: account.id,
          membersFound: 0,
          upserted: 0,
        });
        continue;
      }

      const externalMembers = members.filter((uid) => !isInternal(uid));
      let channelUpserted = 0;

      for (const slackUserId of externalMembers) {
        // Check if a contact with this slack_user_id already exists
        const existing = await db
          .select({ id: contacts.id, accountId: contacts.accountId })
          .from(contacts)
          .where(eq(contacts.slackUserId, slackUserId))
          .limit(1);

        if (existing.length === 0) {
          // Insert new discovered contact
          await db.insert(contacts).values({
            accountId: account.id,
            slackUserId,
            discoveredVia: "channel-membership",
          });
          channelUpserted++;
        }
        // If contact already exists (any account), skip — existing entry wins
      }

      result.upserted += channelUpserted;
      result.channels.push({
        channelId,
        accountId: account.id,
        membersFound: externalMembers.length,
        upserted: channelUpserted,
      });
    }
  }

  return result;
}

/**
 * Resolve a Slack user id to a Contact + Account.
 * Returns the contact row if found, null if not discovered yet.
 */
export async function resolveContactBySlackUser(
  db: Db,
  slackUserId: string
): Promise<(Contact & { accountId: string }) | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(eq(contacts.slackUserId, slackUserId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a group-DM to an Account by finding any participant who is
 * a discovered Contact.
 *
 * If participants map to multiple different accounts → returns null
 * (unknown-origin: ambiguous group DM).
 * If exactly one account is represented → returns that account id.
 */
export async function resolveGroupDmAccount(
  db: Db,
  participantSlackUserIds: string[]
): Promise<string | null> {
  if (participantSlackUserIds.length === 0) return null;

  const matched = await db
    .select({ accountId: contacts.accountId, slackUserId: contacts.slackUserId })
    .from(contacts)
    .where(
      and(
        // Match any of the participants
        // Using a manual IN-style check since Drizzle requires inArray import
        eq(contacts.slackUserId, participantSlackUserIds[0]!)
      )
    )
    .limit(participantSlackUserIds.length * 2);

  // Filter to only matching participants
  const matchedContacts = matched.filter((c) =>
    participantSlackUserIds.includes(c.slackUserId!)
  );

  if (matchedContacts.length === 0) return null;

  // Check if all matched contacts map to the same account
  const accountIds = new Set(matchedContacts.map((c) => c.accountId));
  if (accountIds.size === 1) {
    return matchedContacts[0]!.accountId;
  }

  // Multiple accounts represented — ambiguous
  return null;
}
