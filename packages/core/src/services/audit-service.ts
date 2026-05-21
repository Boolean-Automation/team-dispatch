// dispatch — audit-service
//
// Immutable append-only log. Every mutation appends a row to audit_log.
// The Ticket-detail Activity panel reads this via GET /api/tickets/:id/activity.
//
// plan §Slice 4 / §3 cross-cutting concerns

import { eq } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { auditLog } from "@dispatch/db";
import type { AuditLogEntry } from "@dispatch/db";

export type AuditEvent =
  | "ticket.created"
  | "ticket.status_changed"
  | "ticket.assigned"
  | "ticket.dismissed"
  | "ticket.effort_bucket_set"
  | "message.created"
  | "account.highlights_updated"
  | "reassignment.created"
  | "reassignment.accepted"
  | "reassignment.rejected"
  | "reinforcement.added"
  | "reinforcement.removed";

export interface AppendAuditOptions {
  ticketId?: string | null;
  actorId?: string | null;
  event: AuditEvent;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  undoToken?: string | null;
}

/** Append one audit_log row. Returns the created entry. */
export async function appendAudit(
  db: Db,
  opts: AppendAuditOptions
): Promise<AuditLogEntry> {
  const rows = await db
    .insert(auditLog)
    .values({
      ticketId: opts.ticketId ?? null,
      actorId: opts.actorId ?? null,
      event: opts.event,
      before: opts.before ?? null,
      after: opts.after ?? null,
      meta: opts.meta ?? null,
      undoToken: opts.undoToken ?? null,
    })
    .returning();
  return rows[0]!;
}

/** Read all audit_log entries for a ticket, newest first. */
export async function getTicketActivity(
  db: Db,
  ticketId: string
): Promise<AuditLogEntry[]> {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ticketId, ticketId))
    .orderBy(auditLog.createdAt);
}
