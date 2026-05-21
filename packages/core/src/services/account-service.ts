// dispatch — account-service: read-side service
//
// All Account reads go through here. No business logic in routes.
// Slice 3: list + get only.

import { eq, sql } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { accounts } from "@dispatch/db";
import type { AccountDto, AccountSummary } from "../entities/account.js";

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
