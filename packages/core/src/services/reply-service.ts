// dispatch — reply-service
//
// Creates an outbound Message and inserts a slack_outbox 'pending' row with
// scheduled_at = now + windowSecs (default 10s). Does NOT post to Slack inline.
//
// The durable outbox pattern (FIX 6): the reply endpoint calls this service;
// the outbox worker fires the actual send after the undo window expires.
//
// Status transition (Slice 6 / A15 / FIX 4):
//   resolveTicket=true from on-you        → waiting-client (A15)
//   resolveTicket=true from follow-up-required → follow-up-1-sent + stamps followUp1SentAt (FIX 4)
//   resolveTicket=false                   → status unchanged
//   A reply NEVER moves a ticket to 'closed'.
//
// plan §Slice 5 / spec §3.7 / OQ-4

import { eq } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { messages, tickets } from "@dispatch/db";
import type { MessageDto } from "../entities/message.js";
import { appendAudit } from "./audit-service.js";
import { generateUndoToken } from "./undo-service.js";
import { insertOutboxRow } from "./outbox-service.js";
import { resolveReplyTransition } from "./status-ladder.js";

// ── Default undo window ───────────────────────────────────────────────────────

export const DEFAULT_UNDO_WINDOW_SECS = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SendReplyOpts {
  db: Db;
  ticketId: string;
  /** Clerk user id of the SE pressing Send */
  actorId: string;
  /** Reply body text */
  body: string;
  /** SE display name for Slack attribution */
  actorName: string;
  /** SE avatar URL for Slack attribution (optional) */
  actorIconUrl?: string;
  /**
   * If true, advance the ticket status after sending ("Send & resolve" flow).
   * - on-you → waiting-client (A15)
   * - follow-up-required → follow-up-1-sent + stamps followUp1SentAt (FIX 4)
   * A reply NEVER moves a ticket to 'closed'.
   */
  resolveTicket?: boolean;
  /** Undo window in seconds — defaults to DEFAULT_UNDO_WINDOW_SECS */
  undoWindowSecs?: number;
}

export interface SendReplyResult {
  message: MessageDto;
  undoToken: string;
  outboxId: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Create an outbound Message and insert a pending outbox row.
 *
 * Returns the Message DTO, an undo token, and the outbox row id.
 * The undo token can be posted to POST /api/undo within the window to cancel
 * the send (cancels the outbox row; the worker skips canceled rows).
 */
export async function sendReply(opts: SendReplyOpts): Promise<SendReplyResult> {
  const {
    db,
    ticketId,
    actorId,
    body,
    actorName,
    actorIconUrl,
    resolveTicket = false,
    undoWindowSecs = DEFAULT_UNDO_WINDOW_SECS,
  } = opts;

  // Verify the ticket exists and get its source_channel_id
  const ticketRows = await db
    .select({
      id: tickets.id,
      sourceChannelId: tickets.sourceChannelId,
      status: tickets.status,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (ticketRows.length === 0) {
    throw new Error(`Ticket ${ticketId} not found`);
  }

  const ticket = ticketRows[0]!;
  const channelId = ticket.sourceChannelId ?? "UNKNOWN";

  // Create the outbound Message
  const messageRows = await db
    .insert(messages)
    .values({
      ticketId,
      direction: "outbound",
      authorKind: "se",
      authorRef: actorId,
      body,
    })
    .returning();

  const messageRow = messageRows[0]!;

  const messageDto: MessageDto = {
    id: messageRow.id,
    ticketId: messageRow.ticketId,
    direction: messageRow.direction,
    authorKind: messageRow.authorKind,
    authorRef: messageRow.authorRef,
    body: messageRow.body,
    slackTs: messageRow.slackTs ?? null,
    postedAt: messageRow.postedAt.toISOString(),
    createdAt: messageRow.createdAt.toISOString(),
  };

  // Build undo token
  const undoToken = generateUndoToken();

  // Compute scheduled_at (undo window expiry)
  const scheduledAt = new Date(Date.now() + undoWindowSecs * 1000);

  // Idempotency key: deterministic from message_id so worker restarts are safe
  const idempotencyKey = `reply:${messageRow.id}`;

  // Insert the pending outbox row
  const outboxRow = await insertOutboxRow(db, {
    ticketId,
    messageId: messageRow.id,
    idempotencyKey,
    channelId,
    payload: {
      channelId,
      text: body,
      // actorId resolves the per-SE Slack user token at send time (OQ-2).
      actorId,
      username: actorName,
      iconUrl: actorIconUrl ?? null,
    },
    scheduledAt,
  });

  // Optionally advance the ticket status ("Send & resolve" flow).
  // Route through status-ladder rules — never set 'closed' directly from a reply.
  const prevStatus = ticket.status;
  const targetStatus = resolveTicket ? resolveReplyTransition(ticket.status) : null;

  if (targetStatus) {
    // FIX 4: follow-up-required → follow-up-1-sent stamps follow_up_1_sent_at
    const followUp1SentAt =
      targetStatus === "follow-up-1-sent" ? new Date() : undefined;

    // Record firstResponseAt on the first SE reply (status was on-you or new)
    let firstResponseAtStamp: Date | undefined;
    if (ticket.status === "on-you" || ticket.status === "new") {
      const existingRow = await db
        .select({ firstResponseAt: tickets.firstResponseAt })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1);
      if (!existingRow[0]?.firstResponseAt) {
        firstResponseAtStamp = new Date();
      }
    }

    await db
      .update(tickets)
      .set({
        status: targetStatus,
        updatedAt: new Date(),
        ...(followUp1SentAt ? { followUp1SentAt } : {}),
        ...(firstResponseAtStamp ? { firstResponseAt: firstResponseAtStamp } : {}),
      })
      .where(eq(tickets.id, ticketId));
  }

  // Append audit log entry (message.created) with undo token
  await appendAudit(db, {
    ticketId,
    actorId,
    event: "message.created",
    before: targetStatus ? { status: prevStatus } : null,
    after: {
      messageId: messageRow.id,
      direction: "outbound",
      resolvedTicket: resolveTicket,
      ...(targetStatus ? { statusTransition: { from: prevStatus, to: targetStatus } } : {}),
    },
    undoToken,
  });

  return {
    message: messageDto,
    undoToken,
    outboxId: outboxRow.id,
  };
}
