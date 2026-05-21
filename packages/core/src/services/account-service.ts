// dispatch — account-service
//
// All Account reads + highlights write go through here. No business logic in routes.
// Slice 3: list + get.
// Slice 5: updateAccountHighlights (human-curated highlights field, spec §3.3).

import { eq, sql } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { accounts } from "@dispatch/db";
import type { AccountDto, AccountSummary } from "../entities/account.js";
import { appendAudit } from "./audit-service.js";
import { generateUndoToken } from "./undo-service.js";

function toDto(row: typeof accounts.$inferSelect): AccountDto {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    emailDomains: row.emailDomains ?? [],
    slackChannelIds: row.slackChannelIds ?? [],
    owningSe: row.owningSe ?? null,
    health: row.health,
    highlights: row.highlights ?? null,
    highlightsSourcePath: row.highlightsSourcePath ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAccountSummary(
  row: typeof accounts.$inferSelect
): AccountSummary {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    health: row.health,
    owningSe: row.owningSe ?? null,
  };
}

export async function listAccounts(db: Db): Promise<AccountDto[]> {
  const rows = await db.select().from(accounts).orderBy(accounts.displayName);
  return rows.map(toDto);
}

export async function getAccount(
  db: Db,
  id: string
): Promise<AccountDto | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

export async function getAccountBySlug(
  db: Db,
  slug: string
): Promise<AccountDto | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.slug, slug))
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}

// ── Highlights edit (Slice 5) ─────────────────────────────────────────────────

export type UpdateHighlightsResult =
  | { ok: true; account: AccountDto; undoToken: string }
  | { ok: false };

/**
 * Update the human-curated highlights field on an Account.
 * Returns the updated AccountDto + an undoToken.
 * The highlights field is not stored in audit_log before/after detail — only
 * an 'account.highlights_updated' event is logged (spec §3.3).
 */
export async function updateAccountHighlights(
  db: Db,
  accountId: string,
  highlights: string,
  actorId: string
): Promise<UpdateHighlightsResult> {
  const existing = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (existing.length === 0) {
    return { ok: false };
  }

  const prevHighlights = existing[0]!.highlights;

  const updated = await db
    .update(accounts)
    .set({ highlights, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
    .returning();

  const undoToken = generateUndoToken();

  await appendAudit(db, {
    ticketId: null,
    actorId,
    event: "account.highlights_updated",
    before: { highlights: prevHighlights },
    after: { highlights },
    undoToken,
  });

  return { ok: true, account: toDto(updated[0]!), undoToken };
}

/** Find an Account by one of its registered Slack channel ids.
 *  Uses the Postgres array-contains operator (@>). */
export async function getAccountByChannelId(
  db: Db,
  channelId: string
): Promise<AccountDto | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(
      sql`${accounts.slackChannelIds} @> ARRAY[${channelId}]::text[]`
    )
    .limit(1);
  return rows[0] ? toDto(rows[0]) : null;
}
