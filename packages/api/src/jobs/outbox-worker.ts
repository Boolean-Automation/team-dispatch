// dispatch — outbox-worker: polls pending slack_outbox rows and fires sends
//
// Runs on a node-cron schedule (every 5s by default). On each tick:
//   1. Fetch pending rows whose scheduled_at has passed.
//   2. For each row: call postReply() — posts to Slack as the SE's user.
//   3. Move the row to 'sent' or 'failed' depending on the result.
//
// Idempotency: markOutboxRowSent() only transitions rows still in 'pending'
// status — a concurrent worker restart cannot double-post.
//
// OQ-2 RESOLVED: postReply() in write-back.ts posts via per-SE Slack user
// tokens. A row whose SE has no configured token fails gracefully (the row
// moves to 'failed' with a clear last_error) — the worker never crashes.
//
// plan §Slice 5 / spec §3.7

import cron from "node-cron";
import type { Db } from "@dispatch/db";
import {
  getDueOutboxRows,
  markOutboxRowSent,
  markOutboxRowFailed,
  postReply,
} from "@dispatch/core";
import type { PostReplyPayload } from "@dispatch/core";

// ── Worker ────────────────────────────────────────────────────────────────────

async function processDueRows(db: Db): Promise<void> {
  let dueRows;
  try {
    dueRows = await getDueOutboxRows(db);
  } catch (err) {
    console.error("[outbox-worker] error fetching due rows:", err);
    return;
  }

  if (dueRows.length === 0) return;

  for (const row of dueRows) {
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
      // postReply() posts to Slack as the SE's user via their per-SE token
      // (OQ-2). A missing token returns ok=false → the row moves to 'failed'.
      const result = await postReply(sendPayload);

      if (result.ok) {
        const moved = await markOutboxRowSent(db, row.id, result.ts);
        if (!moved) {
          // Row was already moved by another worker — skip (idempotency guard)
          console.log(
            `[outbox-worker] row ${row.id} already processed by another worker`
          );
        } else {
          console.log(
            `[outbox-worker] row ${row.id} sent for message ${row.messageId}`
          );
        }
      } else {
        await markOutboxRowFailed(
          db,
          row.id,
          result.error ?? "postReply returned ok=false"
        );
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
