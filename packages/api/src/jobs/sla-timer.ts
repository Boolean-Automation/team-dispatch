// dispatch — sla-timer: business-hours SLA escalation cron job
//
// Runs on a node-cron schedule (every 5 minutes). In business hours it runs
// TWO timer-driven advances (A18, FIX 4):
//
//   (1) waiting-client → follow-up-required
//       Ticket in 'waiting-client' silent for 2 business days.
//       "Silent" = no inbound message since the ticket entered waiting-client
//       (tracked via tickets.updated_at as a proxy — the last client reply
//        or outbound send is the last mutation; waiting-client is entered via
//        resolveTicket=true on reply, so updated_at is set at that moment).
//
//   (2) follow-up-1-sent → closeout
//       Ticket in 'follow-up-1-sent' silent for 3 business days counted
//       from tickets.follow_up_1_sent_at (NOT from follow-up-required entry).
//       The timer NEVER advances follow-up-required → follow-up-1-sent;
//       that transition requires the SE to send the first follow-up reply.
//
// On each advance the job raises a follow-up notification to the owning SE.
// The timer NEVER sends to a client or calls Slack write-back (ADR-006, A18).
//
// plan §Slice 6 / spec §5.3 / A18 / ADR-006

import cron from "node-cron";
import { eq, and, isNull } from "drizzle-orm";
import type { Db } from "@dispatch/db";
import { tickets } from "@dispatch/db";
import {
  isBusinessHours,
  hasExceededBusinessDays,
  createNotification,
  appendAudit,
} from "@dispatch/core";

// ── Advance logic ─────────────────────────────────────────────────────────────

/**
 * Run all timer-driven SLA advances. Called on each cron tick when in business
 * hours. Safe to call from tests with a real DB.
 */
export async function runSlaAdvances(db: Db, now: Date = new Date()): Promise<void> {
  // Only run during business hours (6am–5pm PT Mon–Fri)
  if (!isBusinessHours(now)) return;

  await advanceWaitingClient(db, now);
  await advanceFollowUp1Sent(db, now);
}

// ── Advance 1: waiting-client → follow-up-required (2 business days) ─────────

async function advanceWaitingClient(db: Db, now: Date): Promise<void> {
  // Fetch all non-dismissed tickets in 'waiting-client'
  const candidates = await db
    .select({
      id: tickets.id,
      assignee: tickets.assignee,
      updatedAt: tickets.updatedAt,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.status, "waiting-client"),
        isNull(tickets.dismissedAt)
      )
    );

  for (const ticket of candidates) {
    // "Silent since" = when the ticket last moved to waiting-client.
    // We use updatedAt as a proxy because sendReply sets updatedAt when
    // transitioning to waiting-client, and a client reply sets it again
    // (which would have moved it out of waiting-client via A16).
    const silentSince = ticket.updatedAt;

    if (!hasExceededBusinessDays(silentSince, 2, now)) continue;

    // Advance to follow-up-required — only emit audit/notify if the UPDATE
    // actually moved the row (P2-G: guard against concurrent/manual transitions)
    const advanced = await db
      .update(tickets)
      .set({ status: "follow-up-required", updatedAt: new Date() })
      .where(
        and(
          eq(tickets.id, ticket.id),
          eq(tickets.status, "waiting-client") // re-check to guard races
        )
      )
      .returning({ id: tickets.id });

    if (advanced.length === 0) continue; // another process already moved it

    // Audit log
    await appendAudit(db, {
      ticketId: ticket.id,
      actorId: null, // system/timer event
      event: "ticket.status_changed",
      before: { status: "waiting-client" },
      after: { status: "follow-up-required", reason: "timer-2bd" },
    });

    // Notify the owning SE
    if (ticket.assignee) {
      await createNotification(db, {
        recipientId: ticket.assignee,
        kind: "follow-up-required",
        ticketId: ticket.id,
        payload: { reason: "timer-2bd", advancedAt: now.toISOString() },
      });
    }

    console.log(
      `[sla-timer] waiting-client → follow-up-required: ticket ${ticket.id}`
    );
  }
}

// ── Advance 2: follow-up-1-sent → closeout (3 business days from follow_up_1_sent_at) ──

async function advanceFollowUp1Sent(db: Db, now: Date): Promise<void> {
  // Fetch all non-dismissed tickets in 'follow-up-1-sent' with a followUp1SentAt stamp
  const candidates = await db
    .select({
      id: tickets.id,
      assignee: tickets.assignee,
      followUp1SentAt: tickets.followUp1SentAt,
    })
    .from(tickets)
    .where(
      and(
        eq(tickets.status, "follow-up-1-sent"),
        isNull(tickets.dismissedAt)
      )
    );

  for (const ticket of candidates) {
    // The 3-business-day closeout timer counts from followUp1SentAt.
    // A ticket without followUp1SentAt is a data integrity issue — skip.
    if (!ticket.followUp1SentAt) {
      console.warn(
        `[sla-timer] follow-up-1-sent ticket ${ticket.id} has no follow_up_1_sent_at — skipping`
      );
      continue;
    }

    if (!hasExceededBusinessDays(ticket.followUp1SentAt, 3, now)) continue;

    // Advance to closeout — only emit audit/notify if the UPDATE actually moved
    // the row (P2-G: guard against concurrent/manual transitions)
    const advanced = await db
      .update(tickets)
      .set({ status: "closeout", updatedAt: new Date() })
      .where(
        and(
          eq(tickets.id, ticket.id),
          eq(tickets.status, "follow-up-1-sent") // re-check to guard races
        )
      )
      .returning({ id: tickets.id });

    if (advanced.length === 0) continue; // another process already moved it

    // Audit log
    await appendAudit(db, {
      ticketId: ticket.id,
      actorId: null,
      event: "ticket.status_changed",
      before: { status: "follow-up-1-sent" },
      after: {
        status: "closeout",
        reason: "timer-3bd",
        from: ticket.followUp1SentAt.toISOString(),
      },
    });

    // Notify the owning SE
    if (ticket.assignee) {
      await createNotification(db, {
        recipientId: ticket.assignee,
        kind: "closeout-required",
        ticketId: ticket.id,
        payload: {
          reason: "timer-3bd",
          followUp1SentAt: ticket.followUp1SentAt.toISOString(),
          advancedAt: now.toISOString(),
        },
      });
    }

    console.log(
      `[sla-timer] follow-up-1-sent → closeout: ticket ${ticket.id}`
    );
  }
}

// ── Start / stop ──────────────────────────────────────────────────────────────

let _task: ReturnType<typeof cron.schedule> | null = null;

/**
 * Start the SLA timer cron job.
 * Runs every 5 minutes. Only advances tickets during business hours (6am–5pm PT
 * Mon–Fri). Safe to call multiple times — subsequent calls are no-ops.
 */
export function startSlaTimer(db: Db): void {
  if (_task) return;

  _task = cron.schedule("*/5 * * * *", () => {
    void runSlaAdvances(db);
  });

  console.log("[sla-timer] started (5-min poll interval, business hours only)");
}

/**
 * Stop the SLA timer. Used in tests and graceful shutdown.
 */
export function stopSlaTimer(): void {
  if (_task) {
    _task.stop();
    _task = null;
    console.log("[sla-timer] stopped");
  }
}
