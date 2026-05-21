// dispatch — outbox-worker: polls pending slack_outbox rows and fires sends
//
// Runs on a node-cron schedule (every 5s by default). On each tick:
//   1. Reentrancy guard: if the previous tick is still running, skip.
//   2. For each pending due row: atomically claim it — UPDATE slack_outbox
//      SET status='sent', sent_at=now() WHERE id=? AND status='pending' RETURNING id.
//      Only if a row is returned does this worker own the send.
//   3. If postReply() fails after a successful claim, move row → 'failed'.
//
// Double-post protection (P1-E):
//   - Module-level `running` flag prevents overlapping cron ticks (reentrancy guard).
//   - Atomic DB claim: the claim UPDATE + status='sent' BEFORE the Slack call
//     ensures a concurrent worker (or a restart) that fetches the same 'pending'
//     row will find it already 'sent' and skip it.
//
// Residual at-least-once window: if the process crashes after Slack accepts the
// message but before the RETURNING row is committed, the row stays 'pending'
// and will be re-sent on the next tick. This is the standard durable-outbox
// at-least-once trade-off — tolerated for Phase 1 single-process Railway deployment.
//
// OQ-2 RESOLVED: postReply() in write-back.ts posts via per-SE Slack user tokens.
// A row whose SE has no configured token fails gracefully (row → 'failed').
//
// plan §Slice 5 / spec §3.7 / P1-E

import cron from "node-cron";
import type { Db } from "@dispatch/db";
import {
  getDueOutboxRows,
  markOutboxRowFailed,
  postReply,
  claimOutboxRow,
} from "@dispatch/core";
import type { PostReplyPayload } from "@dispatch/core";

// ── Reentrancy guard ──────────────────────────────────────────────────────────
//
// Prevents overlapping ticks: if a processDueRows call is still running when the
// next tick fires, the new tick is skipped. This is the in-process guard; the
// atomic DB claim below handles the cross-process case.

let running = false;

// ── Worker ────────────────────────────────────────────────────────────────────

async function processDueRows(db: Db): Promise<void> {
  if (running) {
    // Previous tick still in progress — skip this tick
    return;
  }
  running = true;

  try {
    let dueRows;
    try {
      dueRows = await getDueOutboxRows(db);
    } catch (err) {
      console.error("[outbox-worker] error fetching due rows:", err);
      return;
    }

    if (dueRows.length === 0) return;

    for (const row of dueRows) {
      // Atomically claim the row: UPDATE ... SET status='sent' WHERE status='pending'.
      // If another tick or worker already claimed it, claimOutboxRow returns null — skip.
      const claimed = await claimOutboxRow(db, row.id);
      if (!claimed) {
        // Row was claimed by a concurrent tick — skip to avoid double-post
        console.log(
          `[outbox-worker] row ${row.id} already claimed by another tick — skip`
        );
        continue;
      }

      const payload = row.payload as Record<string, unknown>;

      const sendPayload: PostReplyPayload = {
        channelId: row.channelId,
        text: typeof payload.text === "string" ? payload.text : "",
        threadTs:
          typeof payload.threadTs === "string" ? payload.threadTs : undefined,
        actorId: typeof payload.actorId === "string" ? payload.actorId : "",
        username:
          typeof payload.username === "string" ? payload.username : "dispatch",
        iconUrl:
          typeof payload.iconUrl === "string" ? payload.iconUrl : undefined,
      };

      try {
        // postReply() posts to Slack as the SE's user via their per-SE token (OQ-2).
        // Row is already marked 'sent' in the DB — if this call fails, we move it
        // back to 'failed' so it doesn't silently disappear.
        const result = await postReply(sendPayload);

        if (result.ok) {
          console.log(
            `[outbox-worker] row ${row.id} sent for message ${row.messageId}`
          );
        } else {
          // Slack rejected the send — mark failed
          await markOutboxRowFailed(db, row.id, result.error ?? "postReply returned ok=false");
          console.error(
            `[outbox-worker] row ${row.id} failed: ${result.error}`
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await markOutboxRowFailed(db, row.id, errMsg);
        console.error(`[outbox-worker] row ${row.id} threw:`, err);
      }
    }
  } finally {
    running = false;
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────

let _task: ReturnType<typeof cron.schedule> | null = null;

/**
 * Start the outbox worker cron job.
 * Polls every 5 seconds for pending outbox rows past their scheduled_at.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startOutboxWorker(db: Db): void {
  if (_task) return;

  _task = cron.schedule("*/5 * * * * *", () => {
    void processDueRows(db);
  });

  console.log("[outbox-worker] started (5s poll interval)");
}

/**
 * Stop the outbox worker. Used in tests and graceful shutdown.
 */
export function stopOutboxWorker(): void {
  if (_task) {
    _task.stop();
    _task = null;
    console.log("[outbox-worker] stopped");
  }
}
