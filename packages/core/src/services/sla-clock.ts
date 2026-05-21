// dispatch — sla-clock: business-hours arithmetic for SLA timer
//
// Business hours: 6am–5pm PT (America/Los_Angeles), Monday–Friday.
// The SLA clock PAUSES outside those hours and on weekends.
//
// PHASE-1 HOLIDAY POLICY: US public holidays are NOT modelled.
// A holiday counts as a business day in Phase 1. This is a stated,
// accepted Phase-1 omission — holiday support is deferred to a later phase.
// (Source: plan §Slice 6 §Holiday policy)
//
// Key operations:
//   computeBusinessDuration(start, end) → minutes of business time elapsed
//   addBusinessMinutes(from, minutes) → Date when that many business minutes pass
//   isBusinessHours(dt) → boolean
//   getSlaState(ticket) → 'warn' | 'over' | 'paused' | 'ok'
//
// plan §Slice 6 / spec §5.3 / A18

// ── Constants ─────────────────────────────────────────────────────────────────

/** Business day window in hours (6am–5pm PT). 11 hours = 660 minutes per day. */
export const BIZ_START_HOUR = 6;   // 06:00 PT
export const BIZ_END_HOUR = 17;    // 17:00 PT
export const BIZ_MINUTES_PER_DAY = (BIZ_END_HOUR - BIZ_START_HOUR) * 60; // 660

/** 2 and 3 business days in minutes */
export const TWO_BIZ_DAYS_MINUTES = 2 * BIZ_MINUTES_PER_DAY;   // 1320
export const THREE_BIZ_DAYS_MINUTES = 3 * BIZ_MINUTES_PER_DAY; // 1980

// ── PT offset helper ──────────────────────────────────────────────────────────
//
// We work in PT (America/Los_Angeles). JS Date is always UTC internally.
// We derive the PT wall-clock time by using Intl.DateTimeFormat with the
// correct timezone. This handles PST/PDT automatically.

function ptParts(dt: Date): {
  year: number;
  month: number;   // 1–12
  day: number;     // 1–31
  hour: number;    // 0–23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday, 6 = Saturday
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = fmt.formatToParts(dt);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";

  // weekday: Sun=0, Mon=1, ..., Sat=6
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekdayStr = get("weekday");
  const weekday = weekdayNames.indexOf(weekdayStr);

  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    weekday: weekday >= 0 ? weekday : 0,
  };
}

/** Returns a Date representing midnight (00:00:00.000) PT for the given date. */
function ptMidnight(dt: Date): Date {
  const p = ptParts(dt);
  // Build an ISO string at midnight PT then parse back to UTC
  // We use Temporal-free approach: construct the local time string and adjust.
  // Simple approach: subtract the fractional day from the PT offset calculation.
  // More robust: use Date.UTC with the PT offset baked in.

  // Build a fake "local" datetime string and parse it using a known trick:
  // The PT offset is variable (PST = UTC-8, PDT = UTC-7).
  // We determine the offset from the actual Date at that time.
  const localStr = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T00:00:00`;

  // Construct a Date from the local midnight string:
  // We need the UTC equivalent of midnight PT on this calendar date.
  // Strategy: shift dt to midnight by computing the PT hour/min offset from dt.
  const dtUtcMs = dt.getTime();

  // Compute how far into the PT day we are:
  const minutesIntoPtDay =
    p.hour * 60 + p.minute + p.second / 60;

  // Midnight PT = dtUtcMs - minutesIntoPtDay * 60000
  const midnightUtcMs = dtUtcMs - minutesIntoPtDay * 60_000 - (p.second % 1) * 1000;
  const midnightDate = new Date(Math.round(midnightUtcMs / 60_000) * 60_000);

  // Verify and adjust (handles sub-minute rounding edge cases)
  const check = ptParts(midnightDate);
  if (check.hour !== 0 || check.minute !== 0) {
    // Minor rounding artifact — nudge to exact midnight
    const correctionMs = (check.hour * 60 + check.minute) * 60_000;
    return new Date(midnightDate.getTime() - correctionMs);
  }

  // Suppress unused variable warning for localStr
  void localStr;

  return midnightDate;
}

/** Returns the Date for BIZ_START_HOUR:00 PT on the given calendar day. */
function ptBizStart(dayMidnightPt: Date): Date {
  return new Date(dayMidnightPt.getTime() + BIZ_START_HOUR * 60 * 60_000);
}

/** Returns the Date for BIZ_END_HOUR:00 PT on the given calendar day. */
function ptBizEnd(dayMidnightPt: Date): Date {
  return new Date(dayMidnightPt.getTime() + BIZ_END_HOUR * 60 * 60_000);
}

// ── isBusinessHours ────────────────────────────────────────────────────────────

/**
 * Returns true if the given Date falls within business hours:
 * 6am–5pm PT, Monday–Friday (no holiday exclusions in Phase 1).
 */
export function isBusinessHours(dt: Date): boolean {
  const p = ptParts(dt);
  // 0 = Sunday, 6 = Saturday
  if (p.weekday === 0 || p.weekday === 6) return false;
  const minuteOfDay = p.hour * 60 + p.minute;
  const startMinute = BIZ_START_HOUR * 60;
  const endMinute = BIZ_END_HOUR * 60;
  return minuteOfDay >= startMinute && minuteOfDay < endMinute;
}

// ── computeBusinessDuration ────────────────────────────────────────────────────

/**
 * Compute the number of business minutes that elapsed between start and end.
 * Minutes outside business hours (6am–5pm PT Mon–Fri) do not count.
 *
 * Returns 0 if end <= start or if the entire span falls outside business hours.
 */
export function computeBusinessDuration(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;

  let totalBizMinutes = 0;
  let cursor = new Date(start.getTime());

  // Walk forward in chunks. We advance by 1-minute granularity is too slow
  // for large spans; instead walk day-by-day.
  const MAX_DAYS = 365 * 2; // safety cap
  let dayCount = 0;

  while (cursor.getTime() < end.getTime() && dayCount < MAX_DAYS) {
    const p = ptParts(cursor);
    const isWeekend = p.weekday === 0 || p.weekday === 6;

    if (isWeekend) {
      // Skip to the start of the next calendar day in PT
      const midnight = ptMidnight(cursor);
      const nextDayMidnight = new Date(midnight.getTime() + 24 * 60 * 60_000);
      cursor = nextDayMidnight;
      dayCount++;
      continue;
    }

    // Business day: compute the biz window for this PT day
    const midnight = ptMidnight(cursor);
    const dayBizStart = ptBizStart(midnight);
    const dayBizEnd = ptBizEnd(midnight);
    const dayEnd = new Date(midnight.getTime() + 24 * 60 * 60_000); // next midnight

    // Clamp cursor and end to this day's biz window
    const windowStart = cursor.getTime() < dayBizStart.getTime() ? dayBizStart : cursor;
    const windowEnd =
      end.getTime() < dayBizEnd.getTime() ? end : dayBizEnd;

    if (windowStart.getTime() < windowEnd.getTime()) {
      const bizMs = windowEnd.getTime() - windowStart.getTime();
      totalBizMinutes += bizMs / 60_000;
    }

    // Advance cursor to next day's midnight
    cursor = dayEnd;
    dayCount++;
  }

  return Math.floor(totalBizMinutes);
}

// ── addBusinessMinutes ─────────────────────────────────────────────────────────

/**
 * Given a start Date, return the Date that is `minutes` business minutes later.
 * Skips time outside business hours (6am–5pm PT Mon–Fri).
 *
 * If start falls outside business hours, the clock begins at the next biz window.
 */
export function addBusinessMinutes(start: Date, minutes: number): Date {
  if (minutes <= 0) return new Date(start.getTime());

  let remaining = minutes;
  let cursor = new Date(start.getTime());

  const MAX_DAYS = 365 * 2;
  let dayCount = 0;

  while (remaining > 0 && dayCount < MAX_DAYS) {
    const p = ptParts(cursor);
    const isWeekend = p.weekday === 0 || p.weekday === 6;

    if (isWeekend) {
      const midnight = ptMidnight(cursor);
      const nextDayMidnight = new Date(midnight.getTime() + 24 * 60 * 60_000);
      cursor = nextDayMidnight;
      dayCount++;
      continue;
    }

    const midnight = ptMidnight(cursor);
    const dayBizStart = ptBizStart(midnight);
    const dayBizEnd = ptBizEnd(midnight);

    // If cursor is before the biz window, jump to start of biz window
    if (cursor.getTime() < dayBizStart.getTime()) {
      cursor = dayBizStart;
    }

    // If cursor is past the biz window, skip to next day
    if (cursor.getTime() >= dayBizEnd.getTime()) {
      const nextDayMidnight = new Date(midnight.getTime() + 24 * 60 * 60_000);
      cursor = nextDayMidnight;
      dayCount++;
      continue;
    }

    // How many biz minutes remain in this day's window?
    const bizMinutesLeftToday =
      (dayBizEnd.getTime() - cursor.getTime()) / 60_000;

    if (remaining <= bizMinutesLeftToday) {
      // Finish within this day's window
      cursor = new Date(cursor.getTime() + remaining * 60_000);
      remaining = 0;
    } else {
      // Consume the rest of today and continue to next day
      remaining -= bizMinutesLeftToday;
      const nextDayMidnight = new Date(midnight.getTime() + 24 * 60 * 60_000);
      cursor = nextDayMidnight;
      dayCount++;
    }
  }

  return cursor;
}

// ── computeSlaDeadline ─────────────────────────────────────────────────────────

/**
 * Compute the SLA deadline given a start date and the number of business minutes
 * allowed. Used to stamp tickets.sla_deadline when a ticket enters a timed state.
 */
export function computeSlaDeadline(start: Date, bizMinutes: number): Date {
  return addBusinessMinutes(start, bizMinutes);
}

// ── SLA card states ────────────────────────────────────────────────────────────

export type SlaState = "ok" | "warn" | "over" | "paused";

/**
 * Compute the SLA display state for a ticket card.
 *
 * @param slaDeadline  The ticket's sla_deadline (nullable).
 * @param slaPaused    The ticket's sla_paused flag.
 * @param now          The current time (defaults to Date.now()).
 */
export function getSlaState(opts: {
  slaDeadline: Date | null;
  slaPaused: boolean;
  now?: Date;
}): SlaState {
  const now = opts.now ?? new Date();

  if (opts.slaPaused) return "paused";
  if (!opts.slaDeadline) return "paused";

  const minsRemaining =
    (opts.slaDeadline.getTime() - now.getTime()) / 60_000;

  if (minsRemaining < 0) return "over";
  if (minsRemaining < 120) return "warn"; // < 2 hours
  return "ok";
}

// ── hasExceededBusinessDays ────────────────────────────────────────────────────

/**
 * Returns true if at least `bizDays` business days have elapsed since `since`.
 * Used by the SLA timer to decide when to advance ticket status.
 */
export function hasExceededBusinessDays(
  since: Date,
  bizDays: number,
  now: Date = new Date()
): boolean {
  const targetMinutes = bizDays * BIZ_MINUTES_PER_DAY;
  const elapsed = computeBusinessDuration(since, now);
  return elapsed >= targetMinutes;
}
