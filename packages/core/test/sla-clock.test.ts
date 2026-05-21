// dispatch — sla-clock tests
//
// Tests:
//   1. isBusinessHours — true in window, false outside, false on weekends.
//   2. computeBusinessDuration — simple in-window span.
//   3. computeBusinessDuration — spans crossing overnight (non-business) gap.
//   4. computeBusinessDuration — spans crossing a weekend.
//   5. computeBusinessDuration — zero when both times are outside biz hours.
//   6. addBusinessMinutes — adds time within a day.
//   7. addBusinessMinutes — carries over to next day when window exhausted.
//   8. addBusinessMinutes — skips weekends.
//   9. hasExceededBusinessDays — true after 2+ biz days, false before.
//  10. getSlaState — paused, ok, warn, over.
//
// Business hours: 6am–5pm PT (America/Los_Angeles), Mon–Fri.
// Phase-1 holiday policy: US holidays count as business days (not modelled).

import { describe, it, expect } from "vitest";
import {
  isBusinessHours,
  computeBusinessDuration,
  addBusinessMinutes,
  hasExceededBusinessDays,
  getSlaState,
  BIZ_MINUTES_PER_DAY,
  TWO_BIZ_DAYS_MINUTES,
  THREE_BIZ_DAYS_MINUTES,
} from "../src/services/sla-clock.js";

// ── Helper: build a Date at a specific PT wall-clock time ─────────────────────
//
// We need deterministic test dates. We'll pin to a known Monday (PST = UTC-8)
// to avoid DST ambiguity in tests.
//
// 2024-01-08 is a Monday. PST offset = UTC-8.
//   8am PT on Mon Jan 8 2024 = 16:00 UTC
//   The Intl APIs handle DST automatically so we just need a stable weekday anchor.

function ptDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  // Construct a UTC Date that corresponds to the given PT wall-clock time.
  // We estimate: PST = UTC-8, PDT = UTC-7.
  // For simplicity in tests, we use known PST dates (Jan/Feb = PST).
  // PDT transitions in March/November — we avoid those months in these tests.
  const PST_OFFSET_HOURS = 8; // PST = UTC-8
  return new Date(Date.UTC(year, month - 1, day, hour + PST_OFFSET_HOURS, minute));
}

// ── isBusinessHours ─────────────────────────────────────────────────────────

describe("isBusinessHours", () => {
  it("returns true at 9am PT on a weekday", () => {
    // Mon Jan 8 2024, 9:00 PT = 17:00 UTC
    const dt = ptDate(2024, 1, 8, 9, 0);
    expect(isBusinessHours(dt)).toBe(true);
  });

  it("returns true at the biz window start (6:00am PT)", () => {
    const dt = ptDate(2024, 1, 8, 6, 0);
    expect(isBusinessHours(dt)).toBe(true);
  });

  it("returns false at exactly 5:00pm PT (end of window, exclusive)", () => {
    const dt = ptDate(2024, 1, 8, 17, 0);
    expect(isBusinessHours(dt)).toBe(false);
  });

  it("returns false at 5:59am PT (before window opens)", () => {
    const dt = ptDate(2024, 1, 8, 5, 59);
    expect(isBusinessHours(dt)).toBe(false);
  });

  it("returns false at midnight PT on a weekday", () => {
    const dt = ptDate(2024, 1, 8, 0, 0);
    expect(isBusinessHours(dt)).toBe(false);
  });

  it("returns false on Saturday", () => {
    // Sat Jan 6 2024
    const dt = ptDate(2024, 1, 6, 10, 0);
    expect(isBusinessHours(dt)).toBe(false);
  });

  it("returns false on Sunday", () => {
    // Sun Jan 7 2024
    const dt = ptDate(2024, 1, 7, 10, 0);
    expect(isBusinessHours(dt)).toBe(false);
  });

  it("returns true on a Friday at 4:59pm PT", () => {
    // Fri Jan 12 2024
    const dt = ptDate(2024, 1, 12, 16, 59);
    expect(isBusinessHours(dt)).toBe(true);
  });
});

// ── computeBusinessDuration ─────────────────────────────────────────────────

describe("computeBusinessDuration", () => {
  it("returns 0 when end <= start", () => {
    const start = ptDate(2024, 1, 8, 9, 0);
    const end = ptDate(2024, 1, 8, 8, 0);
    expect(computeBusinessDuration(start, end)).toBe(0);
  });

  it("simple in-window span: 9am to 11am = 120 minutes", () => {
    const start = ptDate(2024, 1, 8, 9, 0);
    const end = ptDate(2024, 1, 8, 11, 0);
    expect(computeBusinessDuration(start, end)).toBe(120);
  });

  it("whole business day: 6am to 5pm = 660 minutes", () => {
    const start = ptDate(2024, 1, 8, 6, 0);
    const end = ptDate(2024, 1, 8, 17, 0);
    expect(computeBusinessDuration(start, end)).toBe(BIZ_MINUTES_PER_DAY);
  });

  it("span crossing overnight gap counts only in-window minutes", () => {
    // Mon 3pm to Tue 9am:
    //   Mon 3pm–5pm = 120 min; overnight gap is NOT biz time; Tue 6am–9am = 180 min
    //   Total = 120 + 180 = 300 min
    const start = ptDate(2024, 1, 8, 15, 0); // Mon 3pm
    const end = ptDate(2024, 1, 9, 9, 0);    // Tue 9am
    const result = computeBusinessDuration(start, end);
    expect(result).toBe(300);
  });

  it("span crossing a weekend skips Saturday and Sunday", () => {
    // Fri Jan 12 3pm to Mon Jan 15 9am:
    //   Fri 3pm–5pm = 120 min; weekend = 0; Mon 6am–9am = 180 min
    //   Total = 300 min
    const start = ptDate(2024, 1, 12, 15, 0); // Fri 3pm
    const end = ptDate(2024, 1, 15, 9, 0);    // Mon 9am
    const result = computeBusinessDuration(start, end);
    expect(result).toBe(300);
  });

  it("two full business days = 1320 minutes", () => {
    const start = ptDate(2024, 1, 8, 6, 0);  // Mon 6am
    const end = ptDate(2024, 1, 9, 17, 0);   // Tue 5pm
    const result = computeBusinessDuration(start, end);
    expect(result).toBe(TWO_BIZ_DAYS_MINUTES);
  });

  it("three full business days = 1980 minutes", () => {
    const start = ptDate(2024, 1, 8, 6, 0);  // Mon 6am
    const end = ptDate(2024, 1, 10, 17, 0);  // Wed 5pm
    const result = computeBusinessDuration(start, end);
    expect(result).toBe(THREE_BIZ_DAYS_MINUTES);
  });

  it("span entirely outside business hours = 0", () => {
    // Mon 11pm to Tue 4am (both outside window)
    const start = ptDate(2024, 1, 8, 23, 0);
    const end = ptDate(2024, 1, 9, 4, 0);
    expect(computeBusinessDuration(start, end)).toBe(0);
  });
});

// ── addBusinessMinutes ──────────────────────────────────────────────────────

describe("addBusinessMinutes", () => {
  it("adds 60 minutes within a business day", () => {
    const start = ptDate(2024, 1, 8, 9, 0); // Mon 9am
    const result = addBusinessMinutes(start, 60);
    // Should be Mon 10am
    const expected = ptDate(2024, 1, 8, 10, 0);
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("carries over to next day when window is exhausted", () => {
    // Start: Mon 4pm. Add 120 minutes biz time.
    //   Mon 4pm–5pm = 60 min. Remaining: 60 min.
    //   Next biz: Tue 6am. Add 60 min → Tue 7am.
    const start = ptDate(2024, 1, 8, 16, 0); // Mon 4pm
    const result = addBusinessMinutes(start, 120);
    const expected = ptDate(2024, 1, 9, 7, 0); // Tue 7am
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("skips over a weekend", () => {
    // Start: Fri 4pm. Add 120 minutes.
    //   Fri 4pm–5pm = 60 min. Remaining: 60 min.
    //   Skip Sat+Sun. Next biz: Mon 6am. Add 60 min → Mon 7am.
    const start = ptDate(2024, 1, 12, 16, 0); // Fri 4pm
    const result = addBusinessMinutes(start, 120);
    const expected = ptDate(2024, 1, 15, 7, 0); // Mon 7am
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("adds 0 minutes returns the same time", () => {
    const start = ptDate(2024, 1, 8, 9, 0);
    const result = addBusinessMinutes(start, 0);
    expect(result.getTime()).toBe(start.getTime());
  });

  it("starting outside biz hours advances to next window start before counting", () => {
    // Start: Mon 3am (before window). Add 60 min.
    // First biz window: Mon 6am. Add 60 min → Mon 7am.
    const start = ptDate(2024, 1, 8, 3, 0);
    const result = addBusinessMinutes(start, 60);
    const expected = ptDate(2024, 1, 8, 7, 0);
    expect(result.getTime()).toBe(expected.getTime());
  });

  it("adds two full business days (1320 min) correctly", () => {
    const start = ptDate(2024, 1, 8, 6, 0); // Mon 6am
    const result = addBusinessMinutes(start, TWO_BIZ_DAYS_MINUTES);
    const expected = ptDate(2024, 1, 9, 17, 0); // Tue 5pm
    expect(result.getTime()).toBe(expected.getTime());
  });
});

// ── hasExceededBusinessDays ──────────────────────────────────────────────────

describe("hasExceededBusinessDays", () => {
  it("returns false when less than 2 biz days have elapsed", () => {
    // Ticket entered waiting-client at Mon 9am. Now = Mon 2pm (5 biz hours = 300 min < 1320)
    const since = ptDate(2024, 1, 8, 9, 0);
    const now = ptDate(2024, 1, 8, 14, 0);
    expect(hasExceededBusinessDays(since, 2, now)).toBe(false);
  });

  it("returns true after exactly 2 full biz days", () => {
    // Mon 6am → Tue 5pm = exactly 1320 biz minutes = 2 biz days
    const since = ptDate(2024, 1, 8, 6, 0);
    const now = ptDate(2024, 1, 9, 17, 0);
    expect(hasExceededBusinessDays(since, 2, now)).toBe(true);
  });

  it("returns true after more than 2 biz days", () => {
    const since = ptDate(2024, 1, 8, 6, 0);
    const now = ptDate(2024, 1, 10, 10, 0); // Wed 10am > 2 biz days
    expect(hasExceededBusinessDays(since, 2, now)).toBe(true);
  });

  it("returns false when less than 3 biz days have elapsed", () => {
    const since = ptDate(2024, 1, 8, 6, 0); // Mon 6am
    const now = ptDate(2024, 1, 9, 17, 0);  // Tue 5pm = exactly 2 biz days
    expect(hasExceededBusinessDays(since, 3, now)).toBe(false);
  });

  it("returns true after exactly 3 full biz days", () => {
    const since = ptDate(2024, 1, 8, 6, 0);  // Mon 6am
    const now = ptDate(2024, 1, 10, 17, 0);  // Wed 5pm = exactly 3 biz days
    expect(hasExceededBusinessDays(since, 3, now)).toBe(true);
  });

  it("correctly skips weekends when computing 2 biz days from Friday", () => {
    // Since: Fri 4pm. 2 biz days later = Fri 4pm + 60 min (rest of Fri) + Mon 6am + 21h = Mon/Tue
    // Fri 4pm → 5pm = 60 min. Need 1320 - 60 = 1260 more min.
    // Mon 6am → Tue 5pm = 660 + 600 = 1260 min → exactly done at Tue 11am
    // Actually: Fri 4pm–5pm=60min, Mon 6am-5pm=660min, Tue 6am-11am=300min → 60+660+300=1020 < 1320
    // Need Mon 6am-5pm=660 + Tue 6am-?
    // Mon = 660, remaining = 1320-60-660 = 600 min = 10h → Tue 6am + 10h = Tue 4pm
    const since = ptDate(2024, 1, 12, 16, 0); // Fri Jan 12 4pm
    const nowBefore = ptDate(2024, 1, 15, 15, 59); // Mon 3:59pm (not yet 2 biz days)
    expect(hasExceededBusinessDays(since, 2, nowBefore)).toBe(false);
    const nowAfter = ptDate(2024, 1, 16, 16, 1); // Tue 4:01pm (> 2 biz days from Fri 4pm)
    expect(hasExceededBusinessDays(since, 2, nowAfter)).toBe(true);
  });
});

// ── getSlaState ──────────────────────────────────────────────────────────────

describe("getSlaState", () => {
  const now = ptDate(2024, 1, 8, 10, 0); // Mon 10am

  it("returns paused when slaPaused=true", () => {
    expect(
      getSlaState({
        slaDeadline: new Date(now.getTime() + 3 * 60 * 60_000),
        slaPaused: true,
        now,
      })
    ).toBe("paused");
  });

  it("returns paused when slaDeadline is null", () => {
    expect(
      getSlaState({ slaDeadline: null, slaPaused: false, now })
    ).toBe("paused");
  });

  it("returns over when past deadline", () => {
    const pastDeadline = new Date(now.getTime() - 60_000); // 1 minute ago
    expect(
      getSlaState({ slaDeadline: pastDeadline, slaPaused: false, now })
    ).toBe("over");
  });

  it("returns warn when < 2 hours remain", () => {
    const soonDeadline = new Date(now.getTime() + 90 * 60_000); // 90 min from now
    expect(
      getSlaState({ slaDeadline: soonDeadline, slaPaused: false, now })
    ).toBe("warn");
  });

  it("returns ok when >= 2 hours remain", () => {
    const comfortableDeadline = new Date(now.getTime() + 3 * 60 * 60_000); // 3 hours
    expect(
      getSlaState({ slaDeadline: comfortableDeadline, slaPaused: false, now })
    ).toBe("ok");
  });

  it("returns warn at exactly 119 minutes remaining", () => {
    const warnDeadline = new Date(now.getTime() + 119 * 60_000);
    expect(
      getSlaState({ slaDeadline: warnDeadline, slaPaused: false, now })
    ).toBe("warn");
  });
});
