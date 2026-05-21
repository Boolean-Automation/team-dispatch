// dispatch — reassignment-service
//
// Reassignment handshake state machine (spec §3.11, A26):
//
//   SE-initiated:  writes reassignments row status='pending';
//                  tickets.assignee stays with the original SE.
//                  Recipient must accept/reject via the notification center.
//     accept:      row status → 'accepted'; tickets.assignee → recipient.
//     reject:      row status → 'rejected'; tickets.assignee unchanged.
//
//   Admin-initiated: writes row status='accepted' immediately and moves
//                    tickets.assignee at once (no pending phase).
//
//   Phase 1 has no auto-expiry. A never-accepted pending reassignment
//   sits as 'pending' indefinitely; the ticket stays with the original SE.
//
// plan §Slice 7

import { eq, and } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { reassignments, tickets } from "@dispatch/db";
import type { Reassignment } from "@dispatch/db";
import { appendAudit } from "./audit-service.js";
import { generateUndoToken } from "./undo-service.js";
import { createNotification } from "./notification-service.js";

export interface ReassignmentDto {
  id: string;
  ticketId: string;
  proposer: string;
  recipient: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
}

function toDto(row: Reassignment): ReassignmentDto {
  return {
    id: row.id,
    ticketId: row.ticketId,
    proposer: row.proposer,
    recipient: row.recipient,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

export interface InitiateReassignmentResult {
  ok: boolean;
  error?: string;
  reassignment?: ReassignmentDto;
  undoToken?: string;
}

/**
 * Initiate a reassignment. The proposer's role determines the path:
 *   - 'admin': immediate (status='accepted', assignee moves now)
 *   - 'se':    pending (status='pending', assignee unchanged)
 */
export async function initiateReassignment(
  db: Db,
  ticketId: string,
  proposerId: string,
  recipientId: string,
  proposerRole: "admin" | "se"
): Promise<InitiateReassignmentResult> {
  // Verify the ticket exists
  const ticketRows = await db
    .select({ id: tickets.id, assignee: tickets.assignee })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (ticketRows.length === 0) {
    return { ok: false, error: `Ticket ${ticketId} not found` };
  }

  const ticket = ticketRows[0]!;
  const isAdmin = proposerRole === "admin";

  const undoToken = generateUndoToken();

  // Write the reassignment row
  const insertedRows = await db
    .insert(reassignments)
    .values({
      ticketId,
      proposer: proposerId,
      recipient: recipientId,
      status: isAdmin ? "accepted" : "pending",
      resolvedAt: isAdmin ? new Date() : undefined,
    })
    .returning();

  const row = insertedRows[0]!;

  // Admin path: move assignee immediately
  if (isAdmin) {
    await db
      .update(tickets)
      .set({ assignee: recipientId, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));

    await appendAudit(db, {
      ticketId,
      actorId: proposerId,
      event: "reassignment.created",
      before: { assignee: ticket.assignee },
      after: { assignee: recipientId, reassignmentId: row.id, adminImmediate: true },
      undoToken,
    });

    // Notify recipient of incoming assignment
    await createNotification(db, {
      recipientId,
      kind: "reassignment-accepted",
      ticketId,
      payload: { reassignmentId: row.id, proposer: proposerId },
    });
  } else {
    // SE path: pending — notify recipient of incoming request
    await appendAudit(db, {
      ticketId,
      actorId: proposerId,
      event: "reassignment.created",
      before: { assignee: ticket.assignee },
      after: { reassignmentId: row.id, recipient: recipientId, pending: true },
      undoToken,
    });

    await createNotification(db, {
      recipientId,
      kind: "reassignment-incoming",
      ticketId,
      payload: { reassignmentId: row.id, proposer: proposerId },
    });
  }

  return { ok: true, reassignment: toDto(row), undoToken };
}

export interface ResolveReassignmentResult {
  ok: boolean;
  error?: string;
  reassignment?: ReassignmentDto;
  undoToken?: string;
}

/**
 * Accept a pending reassignment.
 * Only the recipient may accept. Moves tickets.assignee to recipient.
 */
export async function acceptReassignment(
  db: Db,
  reassignmentId: string,
  actorId: string
): Promise<ResolveReassignmentResult> {
  const rows = await db
    .select()
    .from(reassignments)
    .where(eq(reassignments.id, reassignmentId))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: `Reassignment ${reassignmentId} not found` };
  }

  const row = rows[0]!;

  if (row.status !== "pending") {
    return { ok: false, error: `Reassignment is already ${row.status}` };
  }

  if (row.recipient !== actorId) {
    return { ok: false, error: "Only the recipient may accept a reassignment" };
  }

  // Fetch current assignee for audit
  const ticketRows = await db
    .select({ assignee: tickets.assignee })
    .from(tickets)
    .where(eq(tickets.id, row.ticketId))
    .limit(1);
  const prevAssignee = ticketRows[0]?.assignee ?? null;

  const undoToken = generateUndoToken();

  // Update the reassignment row
  const updated = await db
    .update(reassignments)
    .set({ status: "accepted", resolvedAt: new Date() })
    .where(eq(reassignments.id, reassignmentId))
    .returning();

  // Move the ticket assignee
  await db
    .update(tickets)
    .set({ assignee: row.recipient, updatedAt: new Date() })
    .where(eq(tickets.id, row.ticketId));

  await appendAudit(db, {
    ticketId: row.ticketId,
    actorId,
    event: "reassignment.accepted",
    before: { assignee: prevAssignee },
    after: { assignee: row.recipient, reassignmentId },
    undoToken,
  });

  // Notify proposer that the reassignment was accepted
  await createNotification(db, {
    recipientId: row.proposer,
    kind: "reassignment-accepted",
    ticketId: row.ticketId,
    payload: { reassignmentId, recipient: row.recipient },
  });

  return { ok: true, reassignment: toDto(updated[0]!), undoToken };
}

/**
 * Reject a pending reassignment.
 * Only the recipient may reject. tickets.assignee unchanged.
 */
export async function rejectReassignment(
  db: Db,
  reassignmentId: string,
  actorId: string
): Promise<ResolveReassignmentResult> {
  const rows = await db
    .select()
    .from(reassignments)
    .where(eq(reassignments.id, reassignmentId))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: `Reassignment ${reassignmentId} not found` };
  }

  const row = rows[0]!;

  if (row.status !== "pending") {
    return { ok: false, error: `Reassignment is already ${row.status}` };
  }

  if (row.recipient !== actorId) {
    return { ok: false, error: "Only the recipient may reject a reassignment" };
  }

  const undoToken = generateUndoToken();

  const updated = await db
    .update(reassignments)
    .set({ status: "rejected", resolvedAt: new Date() })
    .where(eq(reassignments.id, reassignmentId))
    .returning();

  await appendAudit(db, {
    ticketId: row.ticketId,
    actorId,
    event: "reassignment.rejected",
    before: { reassignmentId, status: "pending" },
    after: { reassignmentId, status: "rejected" },
    undoToken,
  });

  // Notify proposer that the reassignment was rejected
  await createNotification(db, {
    recipientId: row.proposer,
    kind: "reassignment-rejected",
    ticketId: row.ticketId,
    payload: { reassignmentId, recipient: row.recipient },
  });

  return { ok: true, reassignment: toDto(updated[0]!), undoToken };
}

/** Get a single reassignment by id (for undo verification / display). */
export async function getReassignment(
  db: Db,
  reassignmentId: string
): Promise<ReassignmentDto | null> {
  const rows = await db
    .select()
    .from(reassignments)
    .where(eq(reassignments.id, reassignmentId))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

/** List all reassignments for a ticket. */
export async function listReassignmentsForTicket(
  db: Db,
  ticketId: string
): Promise<ReassignmentDto[]> {
  const rows = await db
    .select()
    .from(reassignments)
    .where(eq(reassignments.ticketId, ticketId));
  return rows.map(toDto);
}
