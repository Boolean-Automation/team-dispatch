// dispatch — routing service
//
// Assigns a new Ticket to the Account's owning_se and sets status new → on-you.
// plan §Slice 4 / spec §3.5 / A14
//
// Routing rule:
//   - If the Account has an owning_se, set tickets.assignee = owning_se
//     and set status = 'on-you'.
//   - If there is no owning_se (unowned account or unknown-origin ticket with
//     no account), leave assignee null and status = 'new'.

import { eq } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { tickets, accounts } from "@dispatch/db";

export interface RouteTicketResult {
  assignee: string | null;
  status: "new" | "on-you";
}

/**
 * Route a newly created Ticket.
 *
 * Looks up the Account's owning_se and:
 *   - If found: sets assignee = owning_se, status = 'on-you'
 *   - If absent: leaves assignee null, status = 'new'
 *
 * Returns the resulting { assignee, status }.
 */
export async function routeTicket(
  db: Db,
  ticketId: string,
  accountId: string
): Promise<RouteTicketResult> {
  const acctRows = await db
    .select({ owningSe: accounts.owningSe })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  const owningSe = acctRows[0]?.owningSe ?? null;

  if (owningSe) {
    await db
      .update(tickets)
      .set({ assignee: owningSe, status: "on-you", updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));
    return { assignee: owningSe, status: "on-you" };
  }

  // No owning SE — leave as new/unassigned
  return { assignee: null, status: "new" };
}
