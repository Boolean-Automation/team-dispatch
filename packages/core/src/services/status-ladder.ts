// dispatch — status-ladder: the full 7-state ticket status ladder + complete
//
// The canonical ladder (spec §5.2):
//   New → On You → Waiting on Client → Follow-up Required →
//   Follow-up 1 Sent → Closeout → Closed
//   + Complete (manual promotion, off-ladder)
//
// Allowed transitions:
//   new → on-you                       (routing on ticket creation)
//   on-you → waiting-client            (SE sends reply, A15)
//   waiting-client → on-you            (client reply while waiting, A16)
//   waiting-client → follow-up-required (2 business days silent, A18 timer)
//   follow-up-required → follow-up-1-sent (SE sends first follow-up, FIX 4)
//   follow-up-1-sent → closeout        (3 business days from follow_up_1_sent_at, A18 timer)
//   closeout → closed                  (manual — SE closes out)
//   closed → on-you                    (client replies on closed ticket, A17 reopen)
//   any → complete                     (manual promotion off-ladder, A19)
//
// plan §Slice 6 / spec §5.2 / A15–A19

import type { TicketStatus } from "../entities/ticket.js";

// ── Transition map ─────────────────────────────────────────────────────────────
//
// Keys are "from" states; values are the set of allowed "to" states.
// 'complete' is the manual promotion target — allowed FROM any non-terminal state.

const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  new: ["on-you", "complete"],
  "on-you": ["waiting-client", "closed", "complete"],
  "waiting-client": ["on-you", "follow-up-required", "complete"],
  "follow-up-required": ["follow-up-1-sent", "on-you", "complete"],
  "follow-up-1-sent": ["closeout", "on-you", "complete"],
  closeout: ["closed", "on-you", "complete"],
  closed: ["on-you", "complete"],
  complete: [],
};

// ── Context types ─────────────────────────────────────────────────────────────

/**
 * The context driving a transition — used to validate the reason is coherent
 * with the target status.
 */
export type TransitionReason =
  | "se-reply"              // SE sent a reply (A15 / FIX 4)
  | "client-reply"          // Client replied (A16 / A17)
  | "timer-2bd"             // 2-business-day silence timer (A18)
  | "timer-3bd"             // 3-business-day silence timer (A18)
  | "manual"                // Manual SE action (A19 complete / closeout)
  | "routing"               // Ticket routing on creation (A14)
  | "undo";                 // Undo revert (any → previous)

export interface TransitionResult {
  ok: boolean;
  error?: string;
  /** The target status when ok=true. */
  toStatus?: TicketStatus;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate whether a status transition is allowed.
 *
 * Returns ok=true if the transition is valid, ok=false with an error message
 * otherwise. Does NOT mutate the database — use `applyStatusTransition` for that.
 */
export function validateTransition(
  fromStatus: TicketStatus,
  toStatus: TicketStatus,
  _reason?: TransitionReason
): TransitionResult {
  if (fromStatus === toStatus) {
    return { ok: false, error: `Ticket is already in status '${toStatus}'` };
  }

  const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    return {
      ok: false,
      error: `Transition '${fromStatus}' → '${toStatus}' is not allowed. Allowed targets: [${allowed.join(", ") || "none"}]`,
    };
  }

  return { ok: true, toStatus };
}

// ── Reply-driven transition rules ─────────────────────────────────────────────

/**
 * Given a ticket's current status, compute the target status when an SE sends a
 * reply with resolveTicket=true ("Send & resolve").
 *
 * - on-you → waiting-client (A15)
 * - follow-up-required → follow-up-1-sent (FIX 4 — the SE's first follow-up)
 * - Any other status: no transition (null = status unchanged)
 *
 * A reply NEVER moves a ticket to 'closed' — that is the terminal timer state.
 * 'closed' / 'complete' are reached via the timer ladder or manual promotion.
 */
export function resolveReplyTransition(
  fromStatus: TicketStatus
): TicketStatus | null {
  switch (fromStatus) {
    case "on-you":
      return "waiting-client"; // A15
    case "follow-up-required":
      return "follow-up-1-sent"; // FIX 4 — first follow-up sent
    default:
      return null; // no status change for other statuses
  }
}

/**
 * Given a ticket's current status, compute the target status when a client
 * sends an inbound reply (A16 / A17).
 *
 * - waiting-client → on-you (A16)
 * - closed → on-you (A17 reopen)
 * - Any other status: no transition (null)
 */
export function resolveClientReplyTransition(
  fromStatus: TicketStatus
): TicketStatus | null {
  switch (fromStatus) {
    case "waiting-client":
      return "on-you"; // A16
    case "closed":
      return "on-you"; // A17 reopen
    default:
      return null;
  }
}

// ── Timer-driven transition rules ─────────────────────────────────────────────

/**
 * For the 2-business-day silence timer:
 * waiting-client → follow-up-required (A18, first advance)
 */
export function resolveTimer2bdTransition(
  fromStatus: TicketStatus
): TicketStatus | null {
  if (fromStatus === "waiting-client") return "follow-up-required";
  return null;
}

/**
 * For the 3-business-day silence timer (counted from follow_up_1_sent_at):
 * follow-up-1-sent → closeout (A18, second advance)
 *
 * NOTE: The timer never advances follow-up-required → follow-up-1-sent.
 * That transition requires the SE to send the first follow-up reply (FIX 4).
 */
export function resolveTimer3bdTransition(
  fromStatus: TicketStatus
): TicketStatus | null {
  if (fromStatus === "follow-up-1-sent") return "closeout";
  return null;
}
