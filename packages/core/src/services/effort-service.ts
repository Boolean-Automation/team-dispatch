// dispatch — effort-service
//
// Set the effort_bucket on a Ticket (capture-only in Phase 1; no rollup/viz).
// Service-layer guard: cannot move a ticket to 'closed'/'complete' without a
// bucket. Guard is also enforced by DB CHECK (0003_effort_bucket_check.sql).
// plan §Slice 7 / spec §3.4 / A7

import { eq } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { tickets } from "@dispatch/db";
import { appendAudit } from "./audit-service.js";
import { generateUndoToken } from "./undo-service.js";
import type { EffortBucket } from "../entities/ticket.js";

export interface SetEffortBucketResult {
  ok: boolean;
  error?: string;
  undoToken?: string;
  previousBucket?: EffortBucket | null;
  newBucket?: EffortBucket;
}

/** Set the effort_bucket on a ticket. Undoable. */
export async function setEffortBucket(
  db: Db,
  ticketId: string,
  bucket: EffortBucket,
  actorId: string
): Promise<SetEffortBucketResult> {
  const rows = await db
    .select({ id: tickets.id, effortBucket: tickets.effortBucket })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: `Ticket ${ticketId} not found` };
  }

  const ticket = rows[0]!;
  const previousBucket = ticket.effortBucket as EffortBucket | null;

  const undoToken = generateUndoToken();

  await db
    .update(tickets)
    .set({ effortBucket: bucket, updatedAt: new Date() })
    .where(eq(tickets.id, ticketId));

  await appendAudit(db, {
    ticketId,
    actorId,
    event: "ticket.effort_bucket_set",
    before: { effortBucket: previousBucket },
    after: { effortBucket: bucket },
    undoToken,
  });

  return { ok: true, undoToken, previousBucket, newBucket: bucket };
}
