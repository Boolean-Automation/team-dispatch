// dispatch — reinforcement-service
//
// Reinforcement collaborator join: Ticket × Clerk user id.
// Adding a reinforcement puts the Ticket in the collaborator's "Shared Issues"
// view. tickets.assignee is never changed (A27).
// Both add and remove are undoable (A25).
//
// plan §Slice 7

import { eq, and } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { reinforcements, tickets } from "@dispatch/db";
import type { Reinforcement } from "@dispatch/db";
import { appendAudit } from "./audit-service.js";
import { generateUndoToken } from "./undo-service.js";
import { createNotification } from "./notification-service.js";

export interface ReinforcementDto {
  ticketId: string;
  collaborator: string;
  addedAt: string;
}

function toDto(row: Reinforcement): ReinforcementDto {
  return {
    ticketId: row.ticketId,
    collaborator: row.collaborator,
    addedAt: row.addedAt.toISOString(),
  };
}

export interface AddReinforcementResult {
  ok: boolean;
  error?: string;
  reinforcement?: ReinforcementDto;
  undoToken?: string;
}

/** Add a reinforcement collaborator to a ticket. Undoable. */
export async function addReinforcement(
  db: Db,
  ticketId: string,
  collaboratorId: string,
  actorId: string
): Promise<AddReinforcementResult> {
  // Verify the ticket exists
  const ticketRows = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (ticketRows.length === 0) {
    return { ok: false, error: `Ticket ${ticketId} not found` };
  }

  // Check for duplicates — idempotent on the unique index
  const existing = await db
    .select()
    .from(reinforcements)
    .where(
      and(
        eq(reinforcements.ticketId, ticketId),
        eq(reinforcements.collaborator, collaboratorId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return { ok: false, error: "Collaborator is already reinforcing this ticket" };
  }

  const inserted = await db
    .insert(reinforcements)
    .values({ ticketId, collaborator: collaboratorId })
    .returning();

  const dto = toDto(inserted[0]!);
  const undoToken = generateUndoToken();

  await appendAudit(db, {
    ticketId,
    actorId,
    event: "reinforcement.added",
    after: { collaborator: collaboratorId },
    undoToken,
  });

  // Notify the collaborator
  await createNotification(db, {
    recipientId: collaboratorId,
    kind: "reinforcement-added",
    ticketId,
    payload: { addedBy: actorId },
  });

  return { ok: true, reinforcement: dto, undoToken };
}

export interface RemoveReinforcementResult {
  ok: boolean;
  error?: string;
  undoToken?: string;
}

/** Remove a reinforcement collaborator from a ticket. Undoable. */
export async function removeReinforcement(
  db: Db,
  ticketId: string,
  collaboratorId: string,
  actorId: string
): Promise<RemoveReinforcementResult> {
  const existing = await db
    .select()
    .from(reinforcements)
    .where(
      and(
        eq(reinforcements.ticketId, ticketId),
        eq(reinforcements.collaborator, collaboratorId)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return { ok: false, error: "Reinforcement not found" };
  }

  await db
    .delete(reinforcements)
    .where(
      and(
        eq(reinforcements.ticketId, ticketId),
        eq(reinforcements.collaborator, collaboratorId)
      )
    );

  const undoToken = generateUndoToken();

  await appendAudit(db, {
    ticketId,
    actorId,
    event: "reinforcement.removed",
    before: { collaborator: collaboratorId },
    undoToken,
  });

  return { ok: true, undoToken };
}

/** List all reinforcement collaborators for a ticket. */
export async function listReinforcementsForTicket(
  db: Db,
  ticketId: string
): Promise<ReinforcementDto[]> {
  const rows = await db
    .select()
    .from(reinforcements)
    .where(eq(reinforcements.ticketId, ticketId));
  return rows.map(toDto);
}

/** List all tickets a collaborator is reinforced on (Shared Issues view). */
export async function listReinforcedTicketsForCollaborator(
  db: Db,
  collaboratorId: string
): Promise<string[]> {
  const rows = await db
    .select({ ticketId: reinforcements.ticketId })
    .from(reinforcements)
    .where(eq(reinforcements.collaborator, collaboratorId));
  return rows.map((r) => r.ticketId);
}
