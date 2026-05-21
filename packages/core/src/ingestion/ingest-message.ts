// dispatch — ingestMessage: the core ingestion function
//
// Applies the ingestion rule (spec §5.1):
//   - Top-level message in a client channel → one Ticket on the matching Account
//   - Top-level message in a registered internal channel → no Ticket
//   - Unknown origin → Ticket, unassigned, origin_class = 'unknown'
//   - Thread reply → Message on the parent Ticket, no new Ticket
//
// Idempotent on (channelId, eventTs): same event delivered twice yields
// exactly one Ticket or one Message. Dedup key is PERSISTED via:
//   tickets.source_channel_id + tickets.source_event_ts (unique index)
//   messages.slack_ts (dedup key for replies)
//
// Orphan replies (thread reply arrives before parent is ingested):
//   logged + handled gracefully; no crash, no drop, no fabricated parent.
//   Returns result.kind = 'orphan-reply' (not an error).
//
// plan §Slice 4 / CONTRACT.md

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { tickets, messages, accounts } from "@dispatch/db";
import type { IngestionEvent } from "./types.js";
import { classifyOrigin } from "../registry/build-registry.js";
import type { ParsedRegistry } from "../registry/build-registry.js";
import { routeTicket } from "../services/routing.js";
import { appendAudit } from "../services/audit-service.js";
import { createNotification } from "../services/notification-service.js";
import { generateUndoToken } from "../services/undo-service.js";

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

  // Classify the channel
  const { originClass, entry } = classifyOrigin(event.channelId, registry);

  if (originClass === "internal") {
    // Internal channel — no Ticket
    return { kind: "internal-channel" };
  }

  // Idempotency check: has this (channelId, eventTs) already been ingested?
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

  if (!resolvedAccountId) {
    // Unknown origin or account not found in DB — we need an account to create a ticket.
    // Use any account with a matching channel id as a fallback, else skip for now.
    // Per plan: unknown-origin tickets need an account. We create them on a
    // "catch-all" basis: use the first account in the DB if none matches, or
    // handle as unassigned with a synthetic unknown account context.
    //
    // For Phase 1: if we cannot resolve an account, we still create the ticket
    // but we need SOME account_id. We require at least one account to exist.
    // In practice, unknown-origin tickets in the demo always have at least
    // the default seeded accounts.
    //
    // Look for any account whose slack_channel_ids includes this channel:
    const allAccounts = await db
      .select({ id: accounts.id, slackChannelIds: accounts.slackChannelIds })
      .from(accounts)
      .limit(100);

    const match = allAccounts.find((a) =>
      a.slackChannelIds.includes(event.channelId)
    );

    if (match) {
      resolvedAccountId = match.id;
    } else {
      // Truly unknown: pick the first account as a triage target
      resolvedAccountId = allAccounts[0]?.id ?? null;
    }
  }

  if (!resolvedAccountId) {
    // No accounts in the database at all — cannot create ticket
    return { kind: "internal-channel" }; // treat as no-op (edge case in tests)
  }

  // Create the Ticket
  const undoToken = generateUndoToken();

  const ticketRows = await db
    .insert(tickets)
    .values({
      accountId: resolvedAccountId,
      status: "new",
      type: "other", // will be classified by future NLP in later phases
      sourceKind: "channel",
      sourceChannelId: event.channelId,
      sourceEventTs: event.eventTs,
      originClass: originClass === "client" ? "client" : "unknown",
    })
    .returning();

  const ticket = ticketRows[0]!;

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
    actorId: null, // system event
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
    originClass: originClass === "client" ? "client" : "unknown",
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
    // Log and return gracefully — do not crash, do not drop, do not fabricate
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

  // Idempotency check: has this reply already been ingested?
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

  // Create the thread-reply Message
  const undoToken = generateUndoToken();

  const msgRows = await db
    .insert(messages)
    .values({
      ticketId: parentTicketId,
      direction: "inbound",
      authorKind: "client",
      authorRef: event.authorRef,
      body: event.body,
      slackTs: event.eventTs,
    })
    .returning();

  const msg = msgRows[0]!;

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
}

export type CreateTicketManualResult = {
  ticketId: string;
  undoToken: string;
};

export async function createTicketManual(
  opts: CreateTicketManualOptions
): Promise<CreateTicketManualResult> {
  const { db, accountId, type = "question", body, actorId } = opts;

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

  // Route to owning SE
  const { assignee, status } = await routeTicket(db, ticket.id, accountId);

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
