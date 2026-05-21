// dispatch — shared formatting helpers
// Ported verbatim from shell.jsx fmtAge / fmtSla / slaClass.

import type { Ticket } from "../lib/types";

export function fmtAge(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) {
    const rem = min - h * 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }
  const d = Math.floor(h / 24);
  const rh = h - d * 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export function fmtSla(min: number | null): string | null {
  if (min == null) return null;
  if (min < 0) {
    const a = Math.abs(min);
    if (a < 60) return `OVERDUE ${a}m`;
    const h = Math.floor(a / 60);
    const rm = a - h * 60;
    return rm ? `OVERDUE ${h}h ${rm}m` : `OVERDUE ${h}h`;
  }
  if (min < 60) return `${min}m left`;
  const h = Math.floor(min / 60);
  const rm = min - h * 60;
  return rm ? `${h}h ${rm}m left` : `${h}h left`;
}

export function slaClass(t: Pick<Ticket, "paused" | "slaMin">): string {
  if (t.paused) return "paused";
  if (t.slaMin == null) return "none";
  if (t.slaMin < 0) return "over";
  if (t.slaMin < 120) return "warn";
  return "";
}

/** Sort key for SLA urgency sort mode */
export function slaSortKey(t: Pick<Ticket, "paused" | "slaMin">): number {
  if (t.paused) return 1e9;
  if (t.slaMin == null) return 9e8;
  return t.slaMin;
}
