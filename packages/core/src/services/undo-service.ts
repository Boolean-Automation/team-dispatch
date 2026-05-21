// dispatch — undo-service
//
// undo_token per mutation; reverse-by-token, per-action reversal.
// Every mutating operation returns an undo token that can be posted to
// POST /api/undo to reverse the mutation.
//
// plan §Slice 4 / spec §3.9 / A25

import { eq, and, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@dispatch/db";
import { tickets, auditLog, messages } from "@dispatch/db";
import { cancelOutboxRow, getOutboxRowByMessageId } from "./outbox-service.js";
import { appendAudit as appendAuditEntry } from "./audit-service.js";

export function generateUndoToken(): string {
  return randomUUID();
}

export type UndoResult =
  | { ok: true; action: string }
  | { ok: false; reason: "not-found" | "already-undone" | "not-undoable" };

/**
 * Reverse a mutation by its undo_token.
 *
 * Finds the audit_log entry with the matching undo_token and dispatches the
 * appropriate reversal handler for the event type.
 *
 * Per-action reversal:
 *   ticket.created  — sets dismissed_at to now (soft-removes from board)
 *   ticket.dismissed — clears dismissed_at (restores to board)
 *   ticket.status_changed — reverts status to before.status
 *   ticket.assigned — reverts assignee to before.assignee
 *
 * Other events are not reversible via undo in Phase 1.
 */
export async function undoByToken(db: Db, token: string): Promise<UndoResult> {
  // Find the audit log entry for this token
  const entries = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.undoToken, token))
    .limit(1);

  if (entries.length === 0) {
    return { ok: false, reason: "not-found" };
  }

  const entry = entries[0]!;

  // Check if already undone — we mark undo'd entries with meta.undone = true
  const meta = (entry.meta as Record<string, unknown> | null) ?? {};
  if (meta["undone"] === true) {
    return { ok: false, reason: "already-undone" };
  }

  const event = entry.event;

  // Dispatch per-action reversal
  let action: string;

  if (event === "ticket.created") {
    // Undo ticket creation: soft-dismiss (set dismissed_at)
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    await db
      .update(tickets)
      .set({ dismissedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tickets.id, entry.ticketId), isNull(tickets.dismissedAt)));
    action = "ticket.created";
  } else if (event === "ticket.dismissed") {
    // Undo dismiss: restore (clear dismissed_at)
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    await db
      .update(tickets)
      .set({ dismissedAt: null, updatedAt: new Date() })
      .where(eq(tickets.id, entry.ticketId));
    action = "ticket.dismissed";
  } else if (event === "ticket.status_changed") {
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const before = entry.before as { status?: string } | null;
    if (!before?.status) return { ok: false, reason: "not-undoable" };
    await db
      .update(tickets)
      .set({
        status: before.status as typeof tickets.$inferInsert["status"],
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, entry.ticketId));
    action = "ticket.status_changed";
  } else if (event === "ticket.assigned") {
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const before = entry.before as { assignee?: string | null } | null;
    const prevAssignee = before?.assignee ?? null;
    await db
      .update(tickets)
      .set({ assignee: prevAssignee, updatedAt: new Date() })
      .where(eq(tickets.id, entry.ticketId));
    action = "ticket.assigned";
  } else if (event === "message.created") {
    // Undo reply send: branch on whether the outbox row is still pending or
    // already sent (P2-L / OQ-4).
    //
    //   pending → cancel the outbox row (worker skips canceled rows) + delete
    //             the dispatch-side message record (send never happened)
    //   sent    → the Slack message was already delivered; do NOT delete the
    //             dispatch-side record. Instead, record an auditable
    //             "retracted after send" entry. The Slack post is left in-place
    //             (OQ-4: "does NOT delete the delivered Slack message").
    //             TODO: enqueue a flagged correction-note post to the Slack thread.
    const after = entry.after as {
      messageId?: string;
      resolvedTicket?: boolean;
    } | null;
    const before = entry.before as { status?: string } | null;

    if (!after?.messageId) return { ok: false, reason: "not-undoable" };

    // Look up the outbox row to determine its current state
    const outboxRow = await getOutboxRowByMessageId(db, after.messageId);

    if (!outboxRow || outboxRow.status === "pending" || outboxRow.status === "canceled") {
      // Within window (pending) or no outbox row: cancel + delete the message
      await cancelOutboxRow(db, after.messageId);

      await db
        .delete(messages)
        .where(eq(messages.id, after.messageId));

      // Revert ticket status if the send also resolved the ticket
      if (after.resolvedTicket && entry.ticketId && before?.status) {
        await db
          .update(tickets)
          .set({
            status: before.status as typeof tickets.$inferInsert["status"],
            resolvedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(tickets.id, entry.ticketId));
      }
    } else {
      // Already sent (or failed) — Slack message may already be delivered.
      // Do NOT delete the dispatch-side message (data integrity, OQ-4).
      // Record an audit entry marking the retraction attempt.
      await appendAuditEntry(db, {
        ticketId: entry.ticketId ?? null,
        actorId: null,
        event: "message.created", // closest event kind; retraction context in after
        after: {
          retractedMessageId: after.messageId,
          outboxStatus: outboxRow.status,
          note: "undo-after-send: message retained; Slack post not deleted (OQ-4). TODO: post correction note to thread.",
        },
      });
      // Note: ticket status revert is intentionally skipped when the send is
      // already delivered — the status reflects reality (waiting-client etc.)
    }

    action = "message.created";
  } else {
    return { ok: false, reason: "not-undoable" };
  }

  // Mark the audit entry as undone so we cannot undo the same token twice
  await db
    .update(auditLog)
    .set({ meta: { ...meta, undone: true } })
    .where(eq(auditLog.id, entry.id));

  return { ok: true, action };
}
