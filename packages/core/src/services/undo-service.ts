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
import { tickets, auditLog } from "@dispatch/db";

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
