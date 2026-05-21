// dispatch — message-service: read-side service
//
// All Message reads go through here.

import { asc, eq } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { messages } from "@dispatch/db";
import type { MessageDto } from "../entities/message.js";

function toDto(row: typeof messages.$inferSelect): MessageDto {
  return {
    id: row.id,
    ticketId: row.ticketId,
    direction: row.direction,
    authorKind: row.authorKind,
    authorRef: row.authorRef,
    body: row.body,
    slackTs: row.slackTs ?? null,
    postedAt: row.postedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMessagesByTicket(
  db: Db,
  ticketId: string
): Promise<MessageDto[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.ticketId, ticketId))
    .orderBy(asc(messages.postedAt));
  return rows.map(toDto);
}

export async function getMessage(
  db: Db,
  id: string
): Promise<MessageDto | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}
