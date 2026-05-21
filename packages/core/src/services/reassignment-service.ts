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

  // P2-A: guard against multiple concurrent pending reassignments per ticket.
  //
  // Two-layer protection:
  //   1. SELECT fast-path inside the transaction catches the common case and
  //      returns a friendly error message before the INSERT is attempted.
  //   2. DB-level partial unique index (0006) is the structural correctness
  //      guarantee: even under READ COMMITTED, two concurrent transactions that
  //      both pass the SELECT will collide on the INSERT and one will receive a
  //      unique-constraint violation (Postgres error code 23505). We catch that
  //      below and return the same _conflict: true result so the API layer
  //      returns 409.
  //
  // An accepted or rejected row does NOT block a new pending one — only an
  // active 'pending' row blocks.
  try {
    return await db.transaction(async (txn) => {
      const existingPending = await txn
        .select({ id: reassignments.id })
        .from(reassignments)
        .where(
          and(
            eq(reassignments.ticketId, ticketId),
            eq(reassignments.status, "pending")
          )
        )
        .limit(1);

      if (existingPending.length > 0) {
        return {
          ok: false,
          error: "A pending reassignment already exists for this ticket",
          _conflict: true,
        } as InitiateReassignmentResult & { _conflict?: boolean };
      }

      const undoToken = generateUndoToken();

      // Write the reassignment row
      const insertedRows = await txn
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
        await txn
          .update(tickets)
          .set({ assignee: recipientId, updatedAt: new Date() })
          .where(eq(tickets.id, ticketId));

        await appendAudit(txn, {
          ticketId,
          actorId: proposerId,
          event: "reassignment.created",
          before: { assignee: ticket.assignee },
          after: { assignee: recipientId, reassignmentId: row.id, adminImmediate: true },
          undoToken,
        });

        // Notify recipient of incoming assignment
        await createNotification(txn, {
          recipientId,
          kind: "reassignment-accepted",
          ticketId,
          payload: { reassignmentId: row.id, proposer: proposerId },
        });
      } else {
        // SE path: pending — notify recipient of incoming request
        await appendAudit(txn, {
          ticketId,
          actorId: proposerId,
          event: "reassignment.created",
          before: { assignee: ticket.assignee },
          after: { reassignmentId: row.id, recipient: recipientId, pending: true },
          undoToken,
        });

        await createNotification(txn, {
          recipientId,
          kind: "reassignment-incoming",
          ticketId,
          payload: { reassignmentId: row.id, proposer: proposerId },
        });
      }

      return { ok: true, reassignment: toDto(row), undoToken };
    });
  } catch (err) {
    // Catch the DB-level partial unique index violation (Postgres 23505).
    // This fires when two concurrent requests both pass the SELECT fast-path
    // and race to INSERT a second pending row for the same ticket.
    const pg = err as { code?: string };
    if (pg.code === "23505") {
      return {
        ok: false,
        error: "A pending reassignment already exists for this ticket",
        _conflict: true,
      } as InitiateReassignmentResult & { _conflict?: boolean };
    }
    throw err;
  }
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
 *
 * P2-D: uses a guarded UPDATE as the atomic claim to prevent a concurrent
 * accept-and-accept or accept-and-reject race. The UPDATE WHERE status='pending'
 * AND recipient=actorId is the lock; if it returns zero rows the row was already
 * resolved by another request and we return { ok: false, _stale: true }.
 */
export async function acceptReassignment(
  db: Db,
  reassignmentId: string,
  actorId: string
): Promise<ResolveReassignmentResult & { _stale?: boolean }> {
  // First fetch to check existence and recipient constraint (user-friendly errors)
  const rows = await db
    .select()
    .from(reassignments)
    .where(eq(reassignments.id, reassignmentId))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: `Reassignment ${reassignmentId} not found` };
  }

  const row = rows[0]!;

  if (row.recipient !== actorId) {
    return { ok: false, error: "Only the recipient may accept a reassignment" };
  }

  if (row.status !== "pending") {
    return { ok: false, error: `Reassignment is already ${row.status}` };
  }

  return await db.transaction(async (tx) => {
    // Fetch current assignee for audit (inside transaction for consistency)
    const ticketRows = await tx
      .select({ assignee: tickets.assignee })
      .from(tickets)
      .where(eq(tickets.id, row.ticketId))
      .limit(1);
    const prevAssignee = ticketRows[0]?.assignee ?? null;

    // Atomic claim: UPDATE only if still 'pending' and recipient matches.
    // If another request already claimed it, claimed.length === 0 → stale.
    const claimed = await tx
      .update(reassignments)
      .set({ status: "accepted", resolvedAt: new Date() })
      .where(
        and(
          eq(reassignments.id, reassignmentId),
          eq(reassignments.status, "pending"),
          eq(reassignments.recipient, actorId)
        )
      )
      .returning();

    if (claimed.length === 0) {
      return {
        ok: false,
        error: "Reassignment was already resolved by another request",
        _stale: true,
      };
    }

    const updatedRow = claimed[0]!;

    // Move the ticket assignee
    await tx
      .update(tickets)
      .set({ assignee: row.recipient, updatedAt: new Date() })
      .where(eq(tickets.id, row.ticketId));

    const undoToken = generateUndoToken();

    await appendAudit(tx, {
      ticketId: row.ticketId,
      actorId,
      event: "reassignment.accepted",
      before: { assignee: prevAssignee },
      after: { assignee: row.recipient, reassignmentId },
      undoToken,
    });

    // Notify proposer that the reassignment was accepted
    await createNotification(tx, {
      recipientId: row.proposer,
      kind: "reassignment-accepted",
      ticketId: row.ticketId,
      payload: { reassignmentId, recipient: row.recipient },
    });

    return { ok: true, reassignment: toDto(updatedRow), undoToken };
  });
}

/**
 * Reject a pending reassignment.
 * Only the recipient may reject. tickets.assignee unchanged.
 *
 * P2-D: uses a guarded UPDATE as the atomic claim — same pattern as accept.
 * Returns { _stale: true } when another request already resolved the row.
 */
export async function rejectReassignment(
  db: Db,
  reassignmentId: string,
  actorId: string
): Promise<ResolveReassignmentResult & { _stale?: boolean }> {
  // First fetch to check existence and recipient constraint
  const rows = await db
    .select()
    .from(reassignments)
    .where(eq(reassignments.id, reassignmentId))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: `Reassignment ${reassignmentId} not found` };
  }

  const row = rows[0]!;

  if (row.recipient !== actorId) {
    return { ok: false, error: "Only the recipient may reject a reassignment" };
  }

  if (row.status !== "pending") {
    return { ok: false, error: `Reassignment is already ${row.status}` };
  }

  return await db.transaction(async (tx) => {
    // Atomic claim: UPDATE only if still 'pending' and recipient matches.
    const claimed = await tx
      .update(reassignments)
      .set({ status: "rejected", resolvedAt: new Date() })
      .where(
        and(
          eq(reassignments.id, reassignmentId),
          eq(reassignments.status, "pending"),
          eq(reassignments.recipient, actorId)
        )
      )
      .returning();

    if (claimed.length === 0) {
      return {
        ok: false,
        error: "Reassignment was already resolved by another request",
        _stale: true,
      };
    }

    const updatedRow = claimed[0]!;
    const undoToken = generateUndoToken();

    await appendAudit(tx, {
      ticketId: row.ticketId,
      actorId,
      event: "reassignment.rejected",
      before: { reassignmentId, status: "pending" },
      after: { reassignmentId, status: "rejected" },
      undoToken,
    });

    // Notify proposer that the reassignment was rejected
    await createNotification(tx, {
      recipientId: row.proposer,
      kind: "reassignment-rejected",
      ticketId: row.ticketId,
      payload: { reassignmentId, recipient: row.recipient },
    });

    return { ok: true, reassignment: toDto(updatedRow), undoToken };
  });
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
