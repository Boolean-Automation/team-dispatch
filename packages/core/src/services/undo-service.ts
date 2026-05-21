// dispatch — undo-service
//
// undo_token per mutation; reverse-by-token, per-action reversal.
// Every mutating operation returns an undo token that can be posted to
// POST /api/undo to reverse the mutation.
//
// plan §Slice 4 / spec §3.9 / A25
//
// Slice 7 additions:
//   ticket.effort_bucket_set — reverts effort_bucket to before.effortBucket
//   reassignment.created     — deletes the reassignment row (and reverts
//                              assignee if admin-immediate)
//   reassignment.accepted    — reverts assignee to before.assignee, resets
//                              reassignment row to 'pending'
//   reassignment.rejected    — resets reassignment row to 'pending'
//   reinforcement.added      — removes the reinforcement row
//   reinforcement.removed    — re-inserts the reinforcement row
//   message.created (internal) — deletes the internal_thread_messages row

import { eq, and, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@dispatch/db";
import { tickets, auditLog, messages, reassignments, reinforcements, internalThreadMessages, slackOutbox } from "@dispatch/db";
import { appendAudit as appendAuditEntry } from "./audit-service.js";

export function generateUndoToken(): string {
  return randomUUID();
}

export type UndoResult =
  | { ok: true; action: string }
  | { ok: false; reason: "not-found" | "already-undone" | "not-undoable" | "undo-too-late" };

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
    // P2-B: restore all SLA side-effect columns from the before payload, not
    // just status. Omitting these leaves waiting_client_since_at / follow_up_1_sent_at
    // / resolved_at stamped on a ticket whose status no longer justifies them,
    // or restores a status without its required timer column.
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const before = entry.before as {
      status?: string;
      waitingClientSinceAt?: string | null;
      followUp1SentAt?: string | null;
      resolvedAt?: string | null;
    } | null;
    if (!before?.status) return { ok: false, reason: "not-undoable" };
    await db
      .update(tickets)
      .set({
        status: before.status as typeof tickets.$inferInsert["status"],
        updatedAt: new Date(),
        // Restore SLA columns if they were recorded in the audit before payload.
        // "undefined" means the key was absent (old audit entries before P2-B) —
        // leave the column as-is in that case. null means explicitly cleared.
        ...(before.waitingClientSinceAt !== undefined
          ? { waitingClientSinceAt: before.waitingClientSinceAt ? new Date(before.waitingClientSinceAt) : null }
          : {}),
        ...(before.followUp1SentAt !== undefined
          ? { followUp1SentAt: before.followUp1SentAt ? new Date(before.followUp1SentAt) : null }
          : {}),
        ...(before.resolvedAt !== undefined
          ? { resolvedAt: before.resolvedAt ? new Date(before.resolvedAt) : null }
          : {}),
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
  } else if (event === "ticket.effort_bucket_set") {
    // Revert effort_bucket to the previous value (may be null)
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const before = entry.before as { effortBucket?: string | null } | null;
    const prevBucket = before?.effortBucket ?? null;
    await db
      .update(tickets)
      .set({
        effortBucket: prevBucket as typeof tickets.$inferInsert["effortBucket"],
        updatedAt: new Date(),
      })
      .where(eq(tickets.id, entry.ticketId));
    action = "ticket.effort_bucket_set";

  } else if (event === "reassignment.created") {
    // Delete the reassignment row; if admin-immediate, revert the assignee too.
    const after = entry.after as {
      reassignmentId?: string;
      adminImmediate?: boolean;
    } | null;
    const before = entry.before as { assignee?: string | null } | null;
    if (!after?.reassignmentId) return { ok: false, reason: "not-undoable" };
    await db
      .delete(reassignments)
      .where(eq(reassignments.id, after.reassignmentId));
    if (after.adminImmediate && entry.ticketId) {
      const prevAssignee = before?.assignee ?? null;
      await db
        .update(tickets)
        .set({ assignee: prevAssignee, updatedAt: new Date() })
        .where(eq(tickets.id, entry.ticketId));
    }
    action = "reassignment.created";

  } else if (event === "reassignment.accepted") {
    // Revert assignee to before.assignee + reset reassignment to 'pending'
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const after = entry.after as { reassignmentId?: string } | null;
    const before = entry.before as { assignee?: string | null } | null;
    if (!after?.reassignmentId) return { ok: false, reason: "not-undoable" };
    await db
      .update(tickets)
      .set({ assignee: before?.assignee ?? null, updatedAt: new Date() })
      .where(eq(tickets.id, entry.ticketId));
    await db
      .update(reassignments)
      .set({ status: "pending", resolvedAt: null })
      .where(eq(reassignments.id, after.reassignmentId));
    action = "reassignment.accepted";

  } else if (event === "reassignment.rejected") {
    // Reset reassignment row to 'pending'
    const after = entry.after as { reassignmentId?: string } | null;
    if (!after?.reassignmentId) return { ok: false, reason: "not-undoable" };
    await db
      .update(reassignments)
      .set({ status: "pending", resolvedAt: null })
      .where(eq(reassignments.id, after.reassignmentId));
    action = "reassignment.rejected";

  } else if (event === "reinforcement.added") {
    // Remove the reinforcement row
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const after = entry.after as { collaborator?: string } | null;
    if (!after?.collaborator) return { ok: false, reason: "not-undoable" };
    await db
      .delete(reinforcements)
      .where(
        and(
          eq(reinforcements.ticketId, entry.ticketId),
          eq(reinforcements.collaborator, after.collaborator)
        )
      );
    action = "reinforcement.added";

  } else if (event === "reinforcement.removed") {
    // Re-insert the reinforcement row
    if (!entry.ticketId) return { ok: false, reason: "not-undoable" };
    const before = entry.before as { collaborator?: string } | null;
    if (!before?.collaborator) return { ok: false, reason: "not-undoable" };
    // Use INSERT ... ON CONFLICT DO NOTHING for idempotency
    await db
      .insert(reinforcements)
      .values({
        ticketId: entry.ticketId,
        collaborator: before.collaborator,
      })
      .onConflictDoNothing();
    action = "reinforcement.removed";

  } else if (event === "message.created") {
    // Branch: internal thread message vs outbound reply
    const msgAfter = entry.after as {
      messageId?: string;
      internalMessageId?: string;
      isInternal?: boolean;
      resolvedTicket?: boolean;
    } | null;

    if (msgAfter?.isInternal && msgAfter.internalMessageId) {
      // Undo internal thread post: delete the row
      await db
        .delete(internalThreadMessages)
        .where(eq(internalThreadMessages.id, msgAfter.internalMessageId));
      action = "message.created";
      // Mark as undone and return early
      await db
        .update(auditLog)
        .set({ meta: { ...meta, undone: true } })
        .where(eq(auditLog.id, entry.id));
      return { ok: true, action };
    }

    // Undo reply send: wrap the entire check-cancel-delete in a single DB
    // transaction with a GUARDED cancel UPDATE to prevent TOCTOU races with
    // the outbox worker (P1-1).
    //
    // Flow:
    //   1. Inside the transaction, attempt to atomically cancel the outbox row
    //      by updating it from 'pending' → 'canceled'. Only 'pending' rows are
    //      matched; a row already claimed as 'sent' by the worker will not match.
    //   2. If the cancel UPDATE returned zero rows (worker already claimed it),
    //      the undo BAILS: do NOT delete the message record and do NOT revert
    //      the ticket status. Slack already posted it. Append an audit entry
    //      noting the undo-too-late result and return "undo-too-late" to the caller.
    //   3. If the cancel UPDATE succeeded, delete the message record and revert
    //      the ticket status (if the send had resolved it), including all SLA
    //      side-effect columns recorded in the before payload (P2-C).
    //
    // OQ-4: we never delete a Slack message; the Slack post is left in-place.
    const before = entry.before as {
      status?: string;
      waitingClientSinceAt?: string | null;
      followUp1SentAt?: string | null;
      resolvedAt?: string | null;
    } | null;

    if (!msgAfter?.messageId) return { ok: false, reason: "not-undoable" };

    // Capture as a local string so TypeScript narrows the type inside the
    // transaction callback (the async closure would otherwise lose narrowing).
    const messageId: string = msgAfter.messageId;

    let undoTooLate = false;

    await db.transaction(async (tx) => {
      // Attempt atomic cancel: pending → canceled. If the row is already 'sent'
      // (worker claimed it) this UPDATE matches nothing and returns [].
      const canceled = await tx
        .update(slackOutbox)
        .set({ status: "canceled" })
        .where(
          and(
            eq(slackOutbox.messageId, messageId),
            eq(slackOutbox.status, "pending") // only cancel if still pending
          )
        )
        .returning({ id: slackOutbox.id });

      if (canceled.length === 0) {
        // Worker already claimed the row — the Slack message is either in-flight
        // or already delivered. Do NOT delete the dispatch-side record (OQ-4).
        // Append an audit trail for the failed undo attempt.
        await appendAuditEntry(tx, {
          ticketId: entry.ticketId ?? null,
          actorId: null,
          event: "message.created", // closest event kind; undo-too-late context in after
          after: {
            retractedMessageId: msgAfter.messageId,
            note: "undo-too-late: outbox row already claimed by worker; Slack post not deleted (OQ-4, P1-1).",
          },
        });
        // Mark the audit entry as undone so we cannot attempt the token again
        await tx
          .update(auditLog)
          .set({ meta: { ...(meta as Record<string, unknown>), undone: true } })
          .where(eq(auditLog.id, entry.id));
        undoTooLate = true;
        return; // bail from transaction — no message-delete, no status revert
      }

      // Cancel succeeded — the outbox row is now 'canceled'. Delete the message
      // record (the send never actually happened from Slack's perspective).
      await tx
        .delete(messages)
        .where(eq(messages.id, messageId));

      // Revert ticket status if the send also changed it, restoring all SLA
      // side-effect columns from the before payload (P2-C).
      if (msgAfter.resolvedTicket && entry.ticketId && before?.status) {
        await tx
          .update(tickets)
          .set({
            status: before.status as typeof tickets.$inferInsert["status"],
            updatedAt: new Date(),
            // Restore SLA side-effect columns from the audit before payload.
            // "undefined" key means the field was absent in the before payload
            // (old audit entries pre-P2-C) — leave column as-is.
            ...(before.waitingClientSinceAt !== undefined
              ? { waitingClientSinceAt: before.waitingClientSinceAt ? new Date(before.waitingClientSinceAt) : null }
              : {}),
            ...(before.followUp1SentAt !== undefined
              ? { followUp1SentAt: before.followUp1SentAt ? new Date(before.followUp1SentAt) : null }
              : {}),
            ...(before.resolvedAt !== undefined
              ? { resolvedAt: before.resolvedAt ? new Date(before.resolvedAt) : null }
              : {}),
          })
          .where(eq(tickets.id, entry.ticketId));
      }
    });

    if (undoTooLate) {
      return { ok: false, reason: "undo-too-late" };
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
