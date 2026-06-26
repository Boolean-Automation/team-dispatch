// dispatch — engineer-service: read the internal_users registry.
//
// internal_users is the authoritative engineer identity store (Clerk id ↔
// human label ↔ Slack id). The hand-create assignee picker and the API-side
// validation of an admin's chosen assignee both source from here, NOT from the
// web seed ENGINEERS fixture (which is keyed by short keys, not Clerk ids).

import { asc } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { internalUsers } from "@dispatch/db";

export interface EngineerSummary {
  /** Clerk user id — the value stored in tickets.assignee / accounts.owning_se. */
  clerkId: string;
  /** Human-readable label, e.g. "Rensy". Falls back to the clerk id when unset. */
  label: string;
  slackId: string | null;
}

/** List every internal user (engineer), ordered by label for a stable picker. */
export async function listEngineers(db: Db): Promise<EngineerSummary[]> {
  const rows = await db
    .select({
      clerkId: internalUsers.clerkId,
      label: internalUsers.label,
      slackId: internalUsers.slackId,
    })
    .from(internalUsers)
    .orderBy(asc(internalUsers.label));

  return rows.map((r) => ({
    clerkId: r.clerkId,
    label: r.label ?? r.clerkId,
    slackId: r.slackId,
  }));
}

/** True when the given Clerk id belongs to a known internal user. */
export async function isKnownEngineer(
  db: Db,
  clerkId: string
): Promise<boolean> {
  const list = await listEngineers(db);
  return list.some((e) => e.clerkId === clerkId);
}
