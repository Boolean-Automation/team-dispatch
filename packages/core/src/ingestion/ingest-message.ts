// dispatch — ingestMessage: the core ingestion function
//
// Applies the ingestion rule (spec §5.1):
//   - Top-level message in a client channel → one Ticket on the matching Account
//   - Top-level message in a registered internal channel → no Ticket
//   - DM from a discovered Contact → Ticket on that Contact's Account (FIX 2 / A9)
//   - Group-DM resolved to a single client Account → Ticket on that Account
//   - Unknown origin → Ticket, unassigned, origin_class = 'unknown', on __unrouted__ account (A10)
//   - Thread reply → Message on the parent Ticket, no new Ticket
//
// Idempotent on (channelId, eventTs): same event delivered twice yields
// exactly one Ticket or one Message. Dedup key is PERSISTED via:
//   tickets.source_channel_id + tickets.source_event_ts (unique index)
//   messages.slack_ts (dedup key for replies)
//
// Race safety: INSERT ... ON CONFLICT DO NOTHING ... RETURNING — concurrent
// re-delivery races are resolved at the DB layer, never throw on the unique
// index (P1-C).
//
// Orphan replies (thread reply arrives before parent is ingested):
//   logged + handled gracefully; no crash, no drop, no fabricated parent.
//   Returns result.kind = 'orphan-reply' (not an error).
//
// plan §Slice 4 / CONTRACT.md

import { and, eq, isNull, inArray } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { tickets, messages, accounts, internalUsers } from "@dispatch/db";
import type { IngestionEvent } from "./types.js";
import { classifyOrigin } from "../registry/build-registry.js";
import type { ParsedRegistry } from "../registry/build-registry.js";
import { routeTicket } from "../services/routing.js";
import { appendAudit } from "../services/audit-service.js";
import { createNotification } from "../services/notification-service.js";
import { generateUndoToken } from "../services/undo-service.js";
import { resolveClientReplyTransition } from "../services/status-ladder.js";
import {
  resolveContactBySlackUser,
  resolveGroupDmAccount,
  findOrCreateUnroutedAccount,
} from "../services/contact-discovery.js";

// ── Result types ───────────────────────────────────────────────────────────────

export type IngestResult =
  | {
      kind: "ticket-created";
      ticketId: string;
      accountId: string;
      originClass: "client" | "unknown";
      undoToken: string;
    }
  | {
      kind: "ticket-exists";
      ticketId: string;
    }
  | {
      kind: "message-created";
      messageId: string;
      ticketId: string;
      undoToken: string;
    }
  | {
      kind: "message-exists";
      messageId: string;
      ticketId: string;
    }
  | {
      kind: "internal-channel";
    }
  | {
      kind: "orphan-reply";
      channelId: string;
      eventTs: string;
      threadTs: string;
    };

// ── ingestMessage ─────────────────────────────────────────────────────────────

export interface IngestMessageOptions {
  db: Db;
  event: IngestionEvent;
  /** Parsed registry for origin classification. */
  registry: ParsedRegistry;
  /**
   * Optional: Slack user ids to treat as internal/operator accounts.
   * Used for contact-based DM resolution to skip self-created tickets.
   */
  internalUserIds?: string[];
}

export async function ingestMessage(
  opts: IngestMessageOptions
): Promise<IngestResult> {
  const { db, event, registry } = opts;

  // ── Thread reply path ────────────────────────────────────────────────────────
  if (!event.isTopLevel) {
    return await handleThreadReply(db, event);
  }

  // ── Top-level message path ────────────────────────────────────────────────────

  // Determine effective source kind (default 'channel' for backward compat)
  const sourceKind = event.sourceKind ?? "channel";

  // ── DM / group-DM resolution (P1-A / FIX 2) ──────────────────────────────────
  if (sourceKind === "dm" || sourceKind === "group-dm") {
    return await handleDmTopLevel(db, event, sourceKind);
  }

  // ── Channel classification ────────────────────────────────────────────────────
  const { originClass, entry } = classifyOrigin(event.channelId, registry);

  if (originClass === "internal") {
    // Internal channel — no Ticket
    return { kind: "internal-channel" };
  }

  // Resolve account id for client-origin tickets
  let resolvedAccountId: string | null = null;

  if (originClass === "client" && entry) {
    // Look up the account by slug
    const acctRows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.slug, entry.slug))
      .limit(1);
    resolvedAccountId = acctRows[0]?.id ?? null;
  }

  if (originClass === "client" && !resolvedAccountId) {
    // Channel is registered as a client channel but account not in DB yet.
    // Fall through to unknown-origin handling.
  }

  if (originClass === "unknown" || !resolvedAccountId) {
    // Unknown origin: attach to the reserved __unrouted__ quarantine account.
    // Do NOT route (P1-B / A10).
    return await createUnknownOriginTicket(db, event, sourceKind);
  }

  // ── Internal-author policy (OQ-4 / ADR §A3) ──────────────────────────────────
  //
  // When a Boolean SE replies in a client channel, their message is classified
  // as origin_class='client' (channel is a client channel). But the author is
  // internal. INGESTION_INTERNAL_AUTHOR_POLICY controls routing:
  //
  //   route-complete (default) — create Ticket with status='complete', authorKind='se'
  //   suppress                 — no Ticket created; return internal-channel kind
  //   route-on-you             — create Ticket with status='new' (normal routing)
  //
  // This is an env-var-flippable policy branch (Cody calls OQ-4 at Phase 7).
  if (resolvedAccountId) {
    const internalAuthor = await isInternalAuthor(db, event.authorRef);
    if (internalAuthor) {
      const policy =
        (process.env.INGESTION_INTERNAL_AUTHOR_POLICY ?? "route-complete") as
          | "route-complete"
          | "suppress"
          | "route-on-you";

      if (policy === "suppress") {
        // Do not create a ticket for internal messages
        return { kind: "internal-channel" };
      }

      if (policy === "route-on-you") {
        // Route normally — internalAuthor flag is metadata only
        return await createClientTicket(
          db, event, resolvedAccountId, sourceKind, "client"
        );
      }

      // Default: route-complete — SE reply in client channel → completed ticket
      return await createInternalAuthorTicket(
        db, event, resolvedAccountId, sourceKind
      );
    }
  }

  // ── Client-origin ticket: INSERT ... ON CONFLICT DO NOTHING (P1-C) ───────────
  return await createClientTicket(db, event, resolvedAccountId!, sourceKind, "client");
}

// ── Internal-author helpers ───────────────────────────────────────────────────

/**
 * Returns true if the given authorRef (Clerk user id OR Slack user id) is
 * present in the internal_users table.
 *
 * The check matches on both clerk_id and slack_id so that messages arriving
 * with Slack user ids (channel webhooks) are detected even before the SE has
 * a Clerk session in the ingestion path.
 */
async function isInternalAuthor(db: Db, authorRef: string): Promise<boolean> {
  if (!authorRef) return false;

  // Try clerk_id match
  const byClerk = await db
    .select({ id: internalUsers.id })
    .from(internalUsers)
    .where(eq(internalUsers.clerkId, authorRef))
    .limit(1);

  if (byClerk.length > 0) return true;

  // Try slack_id match (channel webhooks carry Slack user ids)
  const bySlack = await db
    .select({ id: internalUsers.id })
    .from(internalUsers)
    .where(eq(internalUsers.slackId, authorRef))
    .limit(1);

  return bySlack.length > 0;
}

/**
 * Creates a ticket for an internal-author message in a client channel.
 * Used when INGESTION_INTERNAL_AUTHOR_POLICY='route-complete'.
 *
 * The ticket is:
 *   - origin_class='client' (the channel is a client channel)
 *   - status='complete'     (SE message, not a new client inquiry)
 *   - authorKind='se'       (the author is Boolean staff)
 *   - assignee=event.authorRef (the SE who sent it)
 *
 * Idempotent on (source_channel_id, source_event_ts) per P1-C.
 */
async function createInternalAuthorTicket(
  db: Db,
  event: IngestionEvent,
  resolvedAccountId: string,
  sourceKind: "channel" | "dm" | "group-dm" | "email"
): Promise<IngestResult> {
  // Idempotency check
  if (event.channelId && event.eventTs) {
    const existing = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.sourceChannelId, event.channelId),
          eq(tickets.sourceEventTs, event.eventTs)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return { kind: "ticket-exists", ticketId: existing[0]!.id };
    }
  }

  const undoToken = generateUndoToken();

  const inserted = await db
    .insert(tickets)
    .values({
      accountId: resolvedAccountId,
      status: "complete",      // SE reply → immediately complete
      type: "other",
      sourceKind,
      sourceChannelId: event.channelId,
      sourceEventTs: event.eventTs,
      originClass: "client",   // The channel is a client channel
      assignee: event.authorRef, // The SE who sent it
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    const existing = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.sourceChannelId, event.channelId),
          eq(tickets.sourceEventTs, event.eventTs)
        )
      )
      .limit(1);
    return { kind: "ticket-exists", ticketId: existing[0]!.id };
  }

  const ticket = inserted[0]!;

  await db.insert(messages).values({
    ticketId: ticket.id,
    direction: "outbound",  // SE message going to client channel
    authorKind: "se",
    authorRef: event.authorRef,
    body: event.body,
    slackTs: event.eventTs,
  });

  await appendAudit(db, {
    ticketId: ticket.id,
    actorId: event.authorRef,
    event: "ticket.created",
    after: {
      ticketId: ticket.id,
      originClass: "client",
      accountId: resolvedAccountId,
      internalAuthor: true,
      policy: "route-complete",
    },
    undoToken,
  });

  return {
    kind: "ticket-created",
    ticketId: ticket.id,
    accountId: resolvedAccountId,
    originClass: "client",
    undoToken,
  };
}

// ── DM / group-DM handling ────────────────────────────────────────────────────

async function handleDmTopLevel(
  db: Db,
  event: IngestionEvent,
  sourceKind: "dm" | "group-dm"
): Promise<IngestResult> {
  let resolvedAccountId: string | null = null;

  if (sourceKind === "dm") {
    // Resolve by author's Slack user id → contacts row → account
    const contact = await resolveContactBySlackUser(db, event.authorRef);
    resolvedAccountId = contact?.accountId ?? null;
  } else {
    // group-dm: resolve via all participants
    const participants = event.participantUserIds ?? [event.authorRef];
    resolvedAccountId = await resolveGroupDmAccount(db, participants);
  }

  if (!resolvedAccountId) {
    // No discovered Contact → unknown origin
    return await createUnknownOriginTicket(db, event, sourceKind);
  }

  // Found a client account via contact discovery
  return await createClientTicket(db, event, resolvedAccountId, sourceKind, "client");
}

// ── Create unknown-origin ticket on __unrouted__ account (P1-B / A10) ────────
//
// Unknown-origin tickets are:
//   - attached to the __unrouted__ quarantine account
//   - NOT routed (assignee stays null)
//   - origin_class = 'unknown'

async function createUnknownOriginTicket(
  db: Db,
  event: IngestionEvent,
  sourceKind: "channel" | "dm" | "group-dm" | "email"
): Promise<IngestResult> {
  // Idempotency check (fast path) — P1-C
  if (event.channelId && event.eventTs) {
    const existing = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.sourceChannelId, event.channelId),
          eq(tickets.sourceEventTs, event.eventTs)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return { kind: "ticket-exists", ticketId: existing[0]!.id };
    }
  }

  const unroutedAccountId = await findOrCreateUnroutedAccount(db);
  const undoToken = generateUndoToken();

  // INSERT ... ON CONFLICT DO NOTHING ... RETURNING (P1-C race-safety)
  const inserted = await db
    .insert(tickets)
    .values({
      accountId: unroutedAccountId,
      status: "new",
      type: "other",
      sourceKind,
      sourceChannelId: event.channelId,
      sourceEventTs: event.eventTs,
      originClass: "unknown",
      // assignee stays null — unknown-origin tickets are not routed (A10)
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    // Concurrent insert won — re-select and return ticket-exists
    const existing = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.sourceChannelId, event.channelId),
          eq(tickets.sourceEventTs, event.eventTs)
        )
      )
      .limit(1);

    return { kind: "ticket-exists", ticketId: existing[0]!.id };
  }

  const ticket = inserted[0]!;

  // Insert the originating message
  await db.insert(messages).values({
    ticketId: ticket.id,
    direction: "inbound",
    authorKind: "client",
    authorRef: event.authorRef,
    body: event.body,
    slackTs: event.eventTs,
  });

  // Audit log — no routing, no notification (A10: unassigned)
  await appendAudit(db, {
    ticketId: ticket.id,
    actorId: null,
    event: "ticket.created",
    after: {
      ticketId: ticket.id,
      originClass: "unknown",
      accountId: unroutedAccountId,
      unrouted: true,
    },
    undoToken,
  });

  return {
    kind: "ticket-created",
    ticketId: ticket.id,
    accountId: unroutedAccountId,
    originClass: "unknown",
    undoToken,
  };
}

// ── Create client-origin ticket (P1-C race-safe) ─────────────────────────────

async function createClientTicket(
  db: Db,
  event: IngestionEvent,
  resolvedAccountId: string,
  sourceKind: "channel" | "dm" | "group-dm" | "email",
  originClass: "client"
): Promise<IngestResult> {
  // Idempotency check (fast path) — P1-C
  const existing = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.sourceChannelId, event.channelId),
        eq(tickets.sourceEventTs, event.eventTs)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return { kind: "ticket-exists", ticketId: existing[0]!.id };
  }

  const undoToken = generateUndoToken();

  // INSERT ... ON CONFLICT DO NOTHING ... RETURNING (P1-C race-safety)
  const inserted = await db
    .insert(tickets)
    .values({
      accountId: resolvedAccountId,
      status: "new",
      type: "other",
      sourceKind,
      sourceChannelId: event.channelId,
      sourceEventTs: event.eventTs,
      originClass,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    // Concurrent insert won — re-select and return ticket-exists
    const existing2 = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.sourceChannelId, event.channelId),
          eq(tickets.sourceEventTs, event.eventTs)
        )
      )
      .limit(1);

    return { kind: "ticket-exists", ticketId: existing2[0]!.id };
  }

  const ticket = inserted[0]!;

  // Insert the originating message
  await db.insert(messages).values({
    ticketId: ticket.id,
    direction: "inbound",
    authorKind: "client",
    authorRef: event.authorRef,
    body: event.body,
    slackTs: event.eventTs,
  });

  // Route the ticket (assign to owning SE → status on-you)
  const { assignee, status } = await routeTicket(db, ticket.id, resolvedAccountId);

  // Audit log
  await appendAudit(db, {
    ticketId: ticket.id,
    actorId: null,
    event: "ticket.created",
    after: { ticketId: ticket.id, originClass, accountId: resolvedAccountId },
    undoToken,
  });

  // If routed to an SE, append assignment audit + notification
  if (assignee) {
    await appendAudit(db, {
      ticketId: ticket.id,
      actorId: null,
      event: "ticket.assigned",
      before: { assignee: null },
      after: { assignee, status },
    });

    await createNotification(db, {
      recipientId: assignee,
      kind: "ticket-assigned",
      ticketId: ticket.id,
      payload: { originClass, source: event.source },
    });
  }

  return {
    kind: "ticket-created",
    ticketId: ticket.id,
    accountId: resolvedAccountId,
    originClass,
    undoToken,
  };
}

// ── Thread reply handler ───────────────────────────────────────────────────────

async function handleThreadReply(
  db: Db,
  event: IngestionEvent
): Promise<IngestResult> {
  const threadTs = event.threadTs;

  if (!threadTs) {
    // Malformed reply — no threadTs; treat as orphan
    return {
      kind: "orphan-reply",
      channelId: event.channelId,
      eventTs: event.eventTs,
      threadTs: "(missing)",
    };
  }

  // Find the parent ticket by (channelId, threadTs) — the parent's source_event_ts
  // is the thread's top-level ts
  const parentTickets = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.sourceChannelId, event.channelId),
        eq(tickets.sourceEventTs, threadTs)
      )
    )
    .limit(1);

  if (parentTickets.length === 0) {
    // Orphan reply: parent not yet ingested
    console.warn(
      `[dispatch] orphan-reply: no parent ticket found for channel=${event.channelId} threadTs=${threadTs} eventTs=${event.eventTs}`
    );
    return {
      kind: "orphan-reply",
      channelId: event.channelId,
      eventTs: event.eventTs,
      threadTs,
    };
  }

  const parentTicketId = parentTickets[0]!.id;

  // INSERT ... ON CONFLICT DO NOTHING for thread-reply dedup (P1-C)
  // Conflict target: messages.slack_ts unique index
  const insertedMsg = await db
    .insert(messages)
    .values({
      ticketId: parentTicketId,
      direction: "inbound",
      authorKind: "client",
      authorRef: event.authorRef,
      body: event.body,
      slackTs: event.eventTs,
    })
    .onConflictDoNothing()
    .returning();

  if (insertedMsg.length === 0) {
    // Concurrent re-delivery — re-select and return message-exists cleanly
    const existingMsg = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.ticketId, parentTicketId),
          eq(messages.slackTs, event.eventTs)
        )
      )
      .limit(1);

    if (existingMsg.length > 0) {
      return {
        kind: "message-exists",
        messageId: existingMsg[0]!.id,
        ticketId: parentTicketId,
      };
    }
    // Fallback (should not happen): return orphan-reply to signal something unexpected
    return {
      kind: "orphan-reply",
      channelId: event.channelId,
      eventTs: event.eventTs,
      threadTs,
    };
  }

  // Message was newly inserted — apply client-reply status transitions
  const parentTicketStatus = await db
    .select({ status: tickets.status, assignee: tickets.assignee })
    .from(tickets)
    .where(eq(tickets.id, parentTicketId))
    .limit(1);

  const parentRow = parentTicketStatus[0];
  const clientReplyTargetStatus = parentRow
    ? resolveClientReplyTransition(parentRow.status)
    : null;

  if (clientReplyTargetStatus && parentRow) {
    // P2-3: clear waiting_client_since_at when a client reply moves a ticket
    // out of 'waiting-client'. The SLA timer skips rows where this is NULL.
    const clearWaitingClientSince = parentRow.status === "waiting-client";

    await db
      .update(tickets)
      .set({
        status: clientReplyTargetStatus,
        updatedAt: new Date(),
        ...(clearWaitingClientSince ? { waitingClientSinceAt: null } : {}),
      })
      .where(eq(tickets.id, parentTicketId));

    await appendAudit(db, {
      ticketId: parentTicketId,
      actorId: null,
      event: "ticket.status_changed",
      before: { status: parentRow.status },
      after: {
        status: clientReplyTargetStatus,
        reason:
          parentRow.status === "closed" ? "client-reply-reopen" : "client-reply",
      },
    });

    if (parentRow.assignee) {
      await createNotification(db, {
        recipientId: parentRow.assignee,
        kind: "ticket-assigned",
        ticketId: parentTicketId,
        payload: {
          event: "client-replied",
          previousStatus: parentRow.status,
          newStatus: clientReplyTargetStatus,
        },
      });
    }
  }

  const msg = insertedMsg[0]!;
  const undoToken = generateUndoToken();

  // Audit log
  await appendAudit(db, {
    ticketId: parentTicketId,
    actorId: null,
    event: "message.created",
    after: { messageId: msg.id, slackTs: event.eventTs },
    undoToken,
  });

  return {
    kind: "message-created",
    messageId: msg.id,
    ticketId: parentTicketId,
    undoToken,
  };
}

// ── Hand-create ticket (POST /api/tickets) ─────────────────────────────────────
//
// Creates a ticket without an ingestion event (operator-initiated, ADR-005).
// No source_event_ts / source_channel_id — not a webhook-originated ticket.

export interface CreateTicketManualOptions {
  db: Db;
  accountId: string;
  type?: "question" | "reply" | "thanks" | "ooo" | "other";
  body?: string;
  actorId?: string;
  /**
   * Clerk user id to assign the ticket to directly, bypassing owning-SE routing.
   * Used by the hand-create flow: SEs self-assign (assigneeId = their own id);
   * admins may pick any engineer. When omitted, the ticket routes to the
   * account's owning SE (default behavior). The API layer validates that the
   * id belongs to a known internal user before passing it here.
   */
  assigneeId?: string;
}

export type CreateTicketManualResult = {
  ticketId: string;
  undoToken: string;
};

export async function createTicketManual(
  opts: CreateTicketManualOptions
): Promise<CreateTicketManualResult> {
  const { db, accountId, type = "question", body, actorId, assigneeId } = opts;

  const undoToken = generateUndoToken();

  const ticketRows = await db
    .insert(tickets)
    .values({
      accountId,
      status: "new",
      type,
      sourceKind: "channel",
      originClass: "client",
      // no sourceChannelId / sourceEventTs for hand-created tickets
    })
    .returning();

  const ticket = ticketRows[0]!;

  if (body) {
    await db.insert(messages).values({
      ticketId: ticket.id,
      direction: "inbound",
      authorKind: "se",
      authorRef: actorId ?? "system",
      body,
    });
  }

  // Assign directly when an explicit assignee is given (SE self-assign or
  // admin pick); otherwise route to the account's owning SE.
  let assignee: string | null;
  let status: string;
  if (assigneeId) {
    await db
      .update(tickets)
      .set({ assignee: assigneeId, status: "on-you", updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id));
    assignee = assigneeId;
    status = "on-you";
  } else {
    ({ assignee, status } = await routeTicket(db, ticket.id, accountId));
  }

  await appendAudit(db, {
    ticketId: ticket.id,
    actorId: actorId ?? null,
    event: "ticket.created",
    after: { ticketId: ticket.id, manual: true, accountId },
    undoToken,
  });

  if (assignee) {
    await appendAudit(db, {
      ticketId: ticket.id,
      actorId: null,
      event: "ticket.assigned",
      before: { assignee: null },
      after: { assignee, status },
    });

    await createNotification(db, {
      recipientId: assignee,
      kind: "ticket-assigned",
      ticketId: ticket.id,
      payload: { manual: true },
    });
  }

  return { ticketId: ticket.id, undoToken };
}

// ── dismissTicket ─────────────────────────────────────────────────────────────
//
// Soft-dismiss a Ticket (set dismissed_at). Undoable.
// plan §Slice 4 / A12

export interface DismissTicketResult {
  ok: boolean;
  undoToken: string;
}

export async function dismissTicket(
  db: Db,
  ticketId: string,
  actorId?: string
): Promise<DismissTicketResult> {
  const undoToken = generateUndoToken();

  const existing = await db
    .select({ id: tickets.id, dismissedAt: tickets.dismissedAt })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!existing[0]) {
    return { ok: false, undoToken };
  }

  await db
    .update(tickets)
    .set({ dismissedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.dismissedAt)));

  await appendAudit(db, {
    ticketId,
    actorId: actorId ?? null,
    event: "ticket.dismissed",
    before: { dismissedAt: null },
    after: { dismissedAt: new Date().toISOString() },
    undoToken,
  });

  return { ok: true, undoToken };
}
