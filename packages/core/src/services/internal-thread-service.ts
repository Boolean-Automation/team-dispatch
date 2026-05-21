// dispatch — internal-thread-service
//
// Per-Ticket internal discussion thread. Dispatch-native only — NEVER written
// to Slack (spec §3.8, A21). Messages render WITHOUT a channel tag (OQ-3).
//
// plan §Slice 7

import { eq, asc } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { internalThreadMessages, auditLog } from "@dispatch/db";
import type { InternalThreadMessage } from "@dispatch/db";
import { appendAudit } from "./audit-service.js";
import { generateUndoToken } from "./undo-service.js";

export interface InternalThreadMessageDto {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  postedAt: string;
  createdAt: string;
}

function toDto(row: InternalThreadMessage): InternalThreadMessageDto {
  return {
    id: row.id,
    ticketId: row.ticketId,
    authorId: row.authorId,
    body: row.body,
    postedAt: row.postedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/** List all internal thread messages for a ticket, oldest first. */
export async function listInternalThreadMessages(
  db: Db,
  ticketId: string
): Promise<InternalThreadMessageDto[]> {
  const rows = await db
    .select()
    .from(internalThreadMessages)
    .where(eq(internalThreadMessages.ticketId, ticketId))
    .orderBy(asc(internalThreadMessages.postedAt));
  return rows.map(toDto);
}

export interface PostInternalMessageResult {
  message: InternalThreadMessageDto;
  undoToken: string;
}

/** Post a message to a ticket's internal thread. Returns the message + undo token. */
export async function postInternalMessage(
  db: Db,
  ticketId: string,
  authorId: string,
  body: string
): Promise<PostInternalMessageResult> {
  if (!body || !body.trim()) {
    throw new Error("body is required");
  }

  const rows = await db
    .insert(internalThreadMessages)
    .values({
      ticketId,
      authorId,
      body: body.trim(),
    })
    .returning();

  const message = toDto(rows[0]!);
  const undoToken = generateUndoToken();

  // Audit — uses message.created event kind; internal flag in after.
  // The undo handler checks after.internalMessageId to delete the row.
  await appendAudit(db, {
    ticketId,
    actorId: authorId,
    event: "message.created",
    after: {
      internalMessageId: message.id,
      isInternal: true,
    },
    undoToken,
  });

  return { message, undoToken };
}

/**
 * Undo an internal thread message post — deletes the row.
 * Called by undo-service when event=message.created + after.isInternal=true.
 */
export async function deleteInternalMessage(
  db: Db,
  messageId: string
): Promise<void> {
  await db
    .delete(internalThreadMessages)
    .where(eq(internalThreadMessages.id, messageId));
}

/**
 * Look up an internal thread message by id (for undo verification).
 */
export async function getInternalMessage(
  db: Db,
  messageId: string
): Promise<InternalThreadMessage | null> {
  const rows = await db
    .select()
    .from(internalThreadMessages)
    .where(eq(internalThreadMessages.id, messageId))
    .limit(1);
  return rows[0] ?? null;
}
