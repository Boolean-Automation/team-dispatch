// dispatch — ticket-service: read-side service
//
// All Ticket reads go through here. Joins accounts for board card shapes.
// Slice 3: list (with filter/sort) + get.

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { accounts, messages, tickets } from "@dispatch/db";
import type { TicketCard, TicketDto, TicketListQuery } from "../entities/ticket.js";

function toDto(row: typeof tickets.$inferSelect): TicketDto {
  return {
    id: row.id,
    displayId: row.displayId,
    accountId: row.accountId,
    status: row.status,
    type: row.type,
    assignee: row.assignee ?? null,
    effortBucket: row.effortBucket ?? null,
    sourceKind: row.sourceKind,
    sourceChannelId: row.sourceChannelId ?? null,
    sourceEventTs: row.sourceEventTs ?? null,
    originClass: row.originClass,
    openedAt: row.openedAt.toISOString(),
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    followUp1SentAt: row.followUp1SentAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    slaDeadline: row.slaDeadline?.toISOString() ?? null,
    slaPaused: row.slaPaused,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Build the board card shape — joins account + first message for preview. */
async function toCard(
  db: Db,
  row: typeof tickets.$inferSelect,
  accountRow: typeof accounts.$inferSelect | null
): Promise<TicketCard> {
  // Fetch first message for preview
  const firstMsg = await db
    .select()
    .from(messages)
    .where(eq(messages.ticketId, row.id))
    .orderBy(asc(messages.postedAt))
    .limit(1);

  const preview = firstMsg[0]?.body?.slice(0, 160) ?? "(no message)";

  const now = Date.now();
  const ageMin = Math.floor((now - row.openedAt.getTime()) / (1000 * 60));

  let slaMin: number | null = null;
  if (row.slaDeadline) {
    slaMin = Math.round((row.slaDeadline.getTime() - now) / (1000 * 60));
  }

  return {
    ...toDto(row),
    clientName: accountRow?.displayName ?? "Unknown",
    clientHealth: accountRow?.health ?? "good",
    preview,
    ageMin,
    slaMin,
    paused: row.slaPaused,
  };
}

export async function listTickets(
  db: Db,
  query: Partial<TicketListQuery>
): Promise<TicketCard[]> {
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;

  const conditions = [];

  if (query.status) {
    conditions.push(eq(tickets.status, query.status));
  }
  if (query.assignee === "unassigned") {
    conditions.push(isNull(tickets.assignee));
  } else if (query.assignee) {
    conditions.push(eq(tickets.assignee, query.assignee));
  }
  if (query.accountId) {
    conditions.push(eq(tickets.accountId, query.accountId));
  }
  if (query.type) {
    conditions.push(eq(tickets.type, query.type));
  }
  if (query.originClass) {
    conditions.push(eq(tickets.originClass, query.originClass));
  }

  // Exclude dismissed tickets from the board by default
  conditions.push(isNull(tickets.dismissedAt));

  // Sort expression
  const orderBy =
    query.sort === "age-desc"
      ? desc(tickets.openedAt)
      : query.sort === "age-asc"
      ? asc(tickets.openedAt)
      : query.sort === "client"
      ? asc(tickets.accountId) // post-sorted by clientName below
      : sql`CASE WHEN ${tickets.slaDeadline} IS NULL THEN 1 ELSE 0 END, ${tickets.slaDeadline} ASC`;

  const rows = await db
    .select()
    .from(tickets)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  // Fetch accounts in batch for the join
  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  let accountRows: (typeof accounts.$inferSelect)[] = [];
  if (accountIds.length > 0) {
    accountRows = await db
      .select()
      .from(accounts)
      .where(
        sql`${accounts.id} = ANY(ARRAY[${sql.join(
          accountIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )}])`
      );
  }

  const accountMap = new Map<string, typeof accounts.$inferSelect>(
    accountRows.map((a) => [a.id, a])
  );

  const cards = await Promise.all(
    rows.map((row) => toCard(db, row, accountMap.get(row.accountId) ?? null))
  );

  // Post-sort by client name if requested
  if (query.sort === "client") {
    cards.sort((a, b) => a.clientName.localeCompare(b.clientName));
  }

  return cards;
}

export async function getTicket(db: Db, id: string): Promise<TicketDto | null> {
  const rows = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, id))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export async function getTicketByDisplayId(
  db: Db,
  displayId: string
): Promise<TicketDto | null> {
  const rows = await db
    .select()
    .from(tickets)
    .where(eq(tickets.displayId, displayId))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}
