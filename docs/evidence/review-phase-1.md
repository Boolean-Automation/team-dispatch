# Adversarial Code Review — dispatch Phase 1

**Branch:** `build/dispatch-phase-1-slices-4-8`
**HEAD:** `b643c25`
**Commits reviewed:** 7 dev commits (Slices 4–8 + Codex remediation + Slice 7)
**Reviewer:** adversarial pass — find what's wrong, not what's right
**Date:** 2026-05-21

---

## Verdict: FIX-FIRST

1 P1 finding. The undo-service TOCTOU race can silently drop dispatch message records for sent Slack replies. Must be fixed before the prod send path is live.

---

## P1 Findings

### P1-1 — Undo-service TOCTOU: worker claims outbox row between status check and delete

**File:** `packages/core/src/services/undo-service.ts:239–259`

**Problem:**
The `message.created` undo path reads the outbox row status, then cancels it and deletes the message record in two separate statements with no transaction or lock:

```typescript
// line 239
const outboxRow = await getOutboxRowByMessageId(db, msgAfter.messageId);

if (!outboxRow || outboxRow.status === "pending" || outboxRow.status === "canceled") {
  await cancelOutboxRow(db, msgAfter.messageId);   // return value unchecked
  await db.delete(messages).where(eq(messages.id, msgAfter.messageId));
  // ... ticket status revert ...
}
```

The outbox worker runs every 30 s on a separate cron tick. Between the `getOutboxRowByMessageId` read (line 239) and the `cancelOutboxRow` call (line 243), the worker can execute `claimOutboxRow` — atomically moving the row from `pending` to `sent`. The `cancelOutboxRow` then operates on a row that is already `sent`, silently does nothing (return value is not checked), but `db.delete(messages)` still executes. Result: Slack receives and posts the message, the outbox row reads `sent`, but the dispatch `messages` row is deleted. The ticket thread now has a Slack post with no corresponding dispatch record — data integrity breach, unrevertable.

**Fix:**
Wrap the entire check-cancel-delete sequence in a `db.transaction()` and use `SELECT ... FOR UPDATE` on the outbox row inside the transaction. Alternatively, change `cancelOutboxRow` to return the updated row count and bail out of the delete if the cancel updated zero rows.

```typescript
await db.transaction(async (tx) => {
  const [outboxRow] = await tx
    .select()
    .from(slackOutbox)
    .where(eq(slackOutbox.messageId, msgAfter.messageId))
    .for("update")   // lock the row
    .limit(1);

  if (!outboxRow || outboxRow.status === "pending" || outboxRow.status === "canceled") {
    // Row is still ours — cancel it atomically
    const canceled = await tx
      .update(slackOutbox)
      .set({ status: "canceled" })
      .where(and(
        eq(slackOutbox.messageId, msgAfter.messageId),
        eq(slackOutbox.status, "pending")   // only cancel if still pending
      ))
      .returning({ id: slackOutbox.id });

    if (canceled.length === 0) return;  // worker beat us — do NOT delete

    await tx.delete(messages).where(eq(messages.id, msgAfter.messageId));
    // ticket status revert here ...
  }
});
```

---

## P2 Findings

### P2-1 — `markOutboxRowFailed` can reset a claimed `sent` row back to `pending`

**Files:**
- `packages/core/src/services/outbox-service.ts:169–193`
- `packages/api/src/jobs/outbox-worker.ts:101–109`

**Problem:**
The worker claims a row to `sent` before calling `postReply`. If `postReply` throws or returns `ok=false`, the worker calls `markOutboxRowFailed(db, row.id, errMsg)`. That function fetches current attempts (from the DB), increments, and sets `status = newAttempts >= MAX_ATTEMPTS ? "failed" : "pending"` with no `WHERE status = 'sent'` guard:

```typescript
// outbox-service.ts:184,188–193
const newStatus = newAttempts >= MAX_ATTEMPTS ? "failed" : "pending";
await db.update(slackOutbox)
  .set({ attempts: newAttempts, lastError: error, status: newStatus })
  .where(eq(slackOutbox.id, rowId));   // <-- no status guard
```

If `newAttempts < 3`, the row is set back to `pending`. `getDueOutboxRows` (which filters `status = 'pending'`) will re-pick it. On the next worker tick, the message is re-sent to Slack — a duplicate Slack post.

In the normal success path (`result.ok === true`) the row stays `sent`, so this only fires on Slack API errors. But Slack rate-limits (429) and transient errors are expected in production; all three retry attempts can produce duplicate posts.

**Fix:**
Add a status guard to `markOutboxRowFailed`:

```typescript
.where(and(
  eq(slackOutbox.id, rowId),
  eq(slackOutbox.status, "sent")   // only downgrade from sent
))
```

Or use a dedicated `retry-queued` status distinct from `pending` so `getDueOutboxRows` only selects rows that were never claimed.

---

### P2-2 — `contacts` unique indexes missing partial predicates in Drizzle schema

**File:** `packages/db/src/schema.ts:176–177`

**Problem:**
The Drizzle schema defines full (non-partial) unique indexes:

```typescript
emailUniq: uniqueIndex("contacts_email_uniq").on(t.email),
slackUserUniq: uniqueIndex("contacts_slack_user_uniq").on(t.slackUserId),
```

The SQL migrations (`drizzle/0000_*.sql`) correctly create partial indexes:

```sql
CREATE UNIQUE INDEX "contacts_email_uniq" ON "contacts" ("email") WHERE email IS NOT NULL;
CREATE UNIQUE INDEX "contacts_slack_user_uniq" ON "contacts" ("slack_user_id") WHERE slack_user_id IS NOT NULL;
```

The Drizzle schema is authoritative for `drizzle-kit generate`. Schema drift means the next `drizzle-kit generate` will emit a migration that drops the partial indexes and creates non-partial ones. A non-partial unique index on a nullable column causes an immediate constraint violation for every contact row where `email` or `slackUserId` is NULL (e.g., contacts discovered via channel-membership without an email on file).

Compare the `tickets.sourceDedup` index in the same file (lines 233–239) which correctly uses `.where(sql`${t.sourceEventTs} IS NOT NULL`)` — the same pattern must be applied here.

**Fix:**

```typescript
import { sql } from "drizzle-orm";

emailUniq: uniqueIndex("contacts_email_uniq")
  .on(t.email)
  .where(sql`${t.email} IS NOT NULL`),
slackUserUniq: uniqueIndex("contacts_slack_user_uniq")
  .on(t.slackUserId)
  .where(sql`${t.slackUserId} IS NOT NULL`),
```

---

### P2-3 — SLA timer uses `updatedAt` as silence proxy; effort bucket mutation resets the window

**File:** `packages/api/src/jobs/sla-timer.ts:69–72`

**Problem:**
The timer uses `ticket.updatedAt` as `silentSince` to measure the 2-business-day waiting-client silence window:

```typescript
// sla-timer.ts:69–72
// "Silent since" = when the ticket last moved to waiting-client.
// We use updatedAt as a proxy...
const silentSince = ticket.updatedAt;
if (!hasExceededBusinessDays(silentSince, 2, now)) continue;
```

`effort-service.ts` bumps `updatedAt` on any ticket when setting/changing the effort bucket (A7 compliance path). A SE can correctly set the effort bucket on a waiting-client ticket (e.g., adding `medium` bucket while waiting), and this silently resets the 2-day window. Depending on SE workflow patterns this can keep a ticket perpetually in `waiting-client` without the follow-up nudge firing.

Additionally, `computeSlaDeadline()` in `sla-clock.ts` is never called by the timer or any ticket mutation — the `sla_deadline` column in the `tickets` table is never stamped. If `sla_deadline` was intended to be the authoritative clock (it exists in the schema), the timer is reading the wrong field.

**Fix:**
Either (a) add a dedicated `waiting_client_since_at` timestamp column stamped only when a ticket transitions **into** `waiting-client`, and use that as `silentSince`; or (b) wire `computeSlaDeadline()` into `reply-service.ts` at the `waiting-client` transition and use the stored `sla_deadline` for the comparison. Option (b) also unlocks displaying the deadline in the UI.

---

### P2-4 — No guard against multiple concurrent pending reassignments per ticket

**File:** `packages/core/src/services/reassignment-service.ts:84–94`

**Problem:**
`initiateReassignment` inserts a new reassignment row without checking for an existing `pending` row on the same ticket:

```typescript
// reassignment-service.ts:85–94
const insertedRows = await db
  .insert(reassignments)
  .values({
    ticketId,
    proposer: proposerId,
    recipient: recipientId,
    status: isAdmin ? "accepted" : "pending",
    ...
  })
  .returning();
```

There is no `WHERE NOT EXISTS (SELECT 1 FROM reassignments WHERE ticket_id = $1 AND status = 'pending')` guard, and no unique constraint in the schema on `(ticket_id, status='pending')`. A SE can spam the endpoint and create N pending reassignment rows for the same ticket. The `acceptReassignment` and `rejectReassignment` functions fetch by `reassignment.id`, so the extra rows pile up silently as orphaned `pending` rows. Accepting one does not close the others — the others remain `pending` and can be accepted by the same recipient multiple times (the accept path moves `assignee` unconditionally each time).

**Fix:**
Before inserting, check for an existing pending row and return an error if one exists:

```typescript
const existing = await db
  .select({ id: reassignments.id })
  .from(reassignments)
  .where(and(
    eq(reassignments.ticketId, ticketId),
    eq(reassignments.status, "pending")
  ))
  .limit(1);

if (existing.length > 0) {
  throw new DispatchError("reassignment-already-pending", 409);
}
```

Optionally add a partial unique index in the schema: `UNIQUE (ticket_id) WHERE status = 'pending'`.

---

## P3 Findings

### P3-1 — Unused `auditLog` import in `internal-thread-service.ts`

**File:** `packages/core/src/services/internal-thread-service.ts:10`

**Problem:**
`auditLog` is imported from `@dispatch/db` but never used. The file calls `appendAuditEntry` from `audit-service.ts` instead. Dead import causes a TypeScript strict-mode warning under `noUnusedLocals` and will fail `tsc --noEmit` if that flag is enabled.

**Fix:** Remove the `auditLog` import from line 10.

---

## Clean Areas (confirmed no issues)

| Area | Finding |
|---|---|
| MCP boundary | `packages/mcp` has no `@dispatch/core` or `@dispatch/db` imports — pure HTTP client |
| Web boundary | ESLint `no-restricted-imports` + `packages/web/package.json` deps both enforce the boundary |
| Route auth classes | Every route has exactly one `preHandler` from the four auth classes; no routes are unguarded |
| Machine credential (HS256) | `jwt.verify` with `algorithms: ['HS256']` + manual `aud`/`iss` checks; `mint-token.ts` mints `aud` as string so `!==` comparison is correct |
| Slack HMAC | `crypto.timingSafeEqual` with length pre-check; no timing oracle |
| Internal thread | No Slack write path; only writes to `internalThreadMessages` table |
| Reply-service transaction | `sendReply` wraps message insert + outbox insert + status update + audit in a single `db.transaction()` |
| Effort bucket guard | Service-layer guard + DB CHECK constraint (`0003_effort_bucket_check.sql`) both present and consistent |
| DST handling | `ptMidnight()` re-evaluated per loop iteration via `Intl.DateTimeFormat`; DST-safe |
| Reassignment auth | `row.recipient !== actorId` check in both accept and reject paths correctly prevents SE self-accept |
| Error handler | No stack trace leakage; sends `{ error, message, statusCode }` only |

---

## Summary

| Severity | Count |
|---|---|
| P1 | 1 |
| P2 | 4 |
| P3 | 1 |

**Verdict: fix-first.** Ship is blocked on P1-1 (undo TOCTOU). P2-1 (double-send on retry) should be fixed in the same pass since both touch the outbox. P2-2 (schema drift) must be fixed before the next `drizzle-kit generate` run. P2-3 and P2-4 are correctness gaps that can land in the same Slice 5/6 hardening pass.
