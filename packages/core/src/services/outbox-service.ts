// dispatch — outbox-service: slack_outbox row lifecycle
//
// Insert a pending outbox row, cancel it, query rows due for sending,
// and mark rows as sent or failed. The outbox worker uses these functions.
//
// Idempotency: the idempotency_key + status transition guard prevent a double
// post if the worker restarts mid-send (FIX 6).
//
// plan §Slice 5 / spec §3.7 / OQ-4

import { and, eq, lte, sql } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { slackOutbox } from "@dispatch/db";
import type { SlackOutbox } from "@dispatch/db";

// ── Insert ─────────────────────────────────────────────────────────────────────

export interface InsertOutboxRowOpts {
  ticketId: string;
  messageId: string;
  /** Deterministic key derived from message_id — prevents double-post on restart */
  idempotencyKey: string;
  channelId: string;
  /** Resolved chat.postMessage arguments (SE attribution etc.) */
  payload: Record<string, unknown>;
  /** When the send becomes due (buffer window expiry) */
  scheduledAt: Date;
}

export async function insertOutboxRow(
  db: Db,
  opts: InsertOutboxRowOpts
): Promise<SlackOutbox> {
  const rows = await db
    .insert(slackOutbox)
    .values({
      ticketId: opts.ticketId,
      messageId: opts.messageId,
      idempotencyKey: opts.idempotencyKey,
      channelId: opts.channelId,
      payload: opts.payload,
      status: "pending",
      scheduledAt: opts.scheduledAt,
    })
    .returning();
  return rows[0]!;
}

// ── Cancel (undo within window) ───────────────────────────────────────────────

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "already-terminal" };

/**
 * Mark a pending outbox row as canceled.
 * Only transitions from 'pending' — a row that is already sent/failed/canceled
 * is untouched and returns { ok: false, reason: 'already-terminal' }.
 */
export async function cancelOutboxRow(
  db: Db,
  messageId: string
): Promise<CancelResult> {
  const rows = await db
    .update(slackOutbox)
    .set({ status: "canceled" })
    .where(
      and(
        eq(slackOutbox.messageId, messageId),
        eq(slackOutbox.status, "pending")
      )
    )
    .returning();

  if (rows.length > 0) {
    return { ok: true };
  }

  // Check whether the row exists at all (already terminal vs not found)
  const existing = await db
    .select({ status: slackOutbox.status })
    .from(slackOutbox)
    .where(eq(slackOutbox.messageId, messageId))
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, reason: "not-found" };
  }

  return { ok: false, reason: "already-terminal" };
}

// ── Due rows (worker poll) ─────────────────────────────────────────────────────

/**
 * Return all pending outbox rows whose scheduled_at has passed.
 * The worker calls this on each tick; the idempotency_key + status guard in
 * markSent / markFailed prevent a double-post if the worker restarts mid-send.
 */
export async function getDueOutboxRows(db: Db): Promise<SlackOutbox[]> {
  return db
    .select()
    .from(slackOutbox)
    .where(
      and(
        eq(slackOutbox.status, "pending"),
        lte(slackOutbox.scheduledAt, sql`NOW()`)
      )
    );
}

// ── Atomic claim (P1-E) ───────────────────────────────────────────────────────
//
// Before calling postReply(), the worker atomically claims the row by flipping
// it from 'pending' → 'sent' in a single UPDATE ... RETURNING. If another tick
// already claimed the row, the UPDATE matches nothing and returns null — the
// caller skips the send entirely, preventing a double-post.
//
// This replaces the old pattern of: fetch pending → send → mark sent.
// The new pattern is: atomic claim (pending→sent) → send.
// If send fails after the claim, the caller must call markOutboxRowFailed().

export async function claimOutboxRow(
  db: Db,
  rowId: string
): Promise<{ id: string } | null> {
  const rows = await db
    .update(slackOutbox)
    .set({ status: "sent", sentAt: new Date() })
    .where(and(eq(slackOutbox.id, rowId), eq(slackOutbox.status, "pending")))
    .returning({ id: slackOutbox.id });

  return rows[0] ?? null;
}

// ── Mark sent ─────────────────────────────────────────────────────────────────

/**
 * Transition pending → sent. Idempotency guard: only updates rows still in
 * 'pending' status — a row already moved to 'sent' by a concurrent worker is
 * skipped (returns false).
 */
export async function markOutboxRowSent(
  db: Db,
  rowId: string,
  _slackTs?: string
): Promise<boolean> {
  // Note: slackTs is reserved for future storage; the payload field can be
  // updated with the real ts once the OQ-2 live send is wired.
  const rows = await db
    .update(slackOutbox)
    .set({
      status: "sent",
      sentAt: new Date(),
    })
    .where(and(eq(slackOutbox.id, rowId), eq(slackOutbox.status, "pending")))
    .returning();
  return rows.length > 0;
}

// ── Mark failed ───────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

/**
 * Increment attempts and record the error. If attempts >= MAX_ATTEMPTS,
 * transition to 'failed'. Otherwise leaves the row 'pending' for retry.
 */
export async function markOutboxRowFailed(
  db: Db,
  rowId: string,
  error: string
): Promise<void> {
  // Fetch current attempts
  const rows = await db
    .select({ attempts: slackOutbox.attempts })
    .from(slackOutbox)
    .where(eq(slackOutbox.id, rowId))
    .limit(1);

  if (rows.length === 0) return;

  const newAttempts = (rows[0]!.attempts ?? 0) + 1;
  const newStatus = newAttempts >= MAX_ATTEMPTS ? "failed" : "pending";

  await db
    .update(slackOutbox)
    .set({
      attempts: newAttempts,
      lastError: error,
      status: newStatus,
    })
    .where(eq(slackOutbox.id, rowId));
}

// ── Lookup by message_id (for undo) ──────────────────────────────────────────

export async function getOutboxRowByMessageId(
  db: Db,
  messageId: string
): Promise<SlackOutbox | null> {
  const rows = await db
    .select()
    .from(slackOutbox)
    .where(eq(slackOutbox.messageId, messageId))
    .limit(1);
  return rows[0] ?? null;
}
