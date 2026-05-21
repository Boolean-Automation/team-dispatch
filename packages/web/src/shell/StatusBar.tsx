// dispatch — StatusBar component
// Shows live indicator, ticket counts, business-hours label, last-sync time.
// lastSyncAt is wired to TanStack Query's dataUpdatedAt (plan §Slice 1 strategy).

import React from "react";

interface StatusBarProps {
  totalCount: number;
  onYouCount: number;
  unassignedCount: number;
  /** TanStack Query dataUpdatedAt (ms epoch) — determines last-sync label */
  dataUpdatedAt?: number;
}

function fmtLastSync(updatedAt: number | undefined): string {
  if (!updatedAt) return "—";
  const diffMs = Date.now() - updatedAt;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `last sync ${secs}s`;
  const min = Math.floor(secs / 60);
  return `last sync ${min}m`;
}

export function StatusBar({
  totalCount,
  onYouCount,
  unassignedCount,
  dataUpdatedAt,
}: StatusBarProps) {
  return (
    <div className="statusbar">
      <span className="mono ok">live</span>
      <span>
        {totalCount} tickets · {onYouCount} on you · {unassignedCount} unassigned
      </span>
      <span style={{ flex: 1 }} />
      <span>business-hours clock · 06:00–17:00 PT</span>
      <span>·</span>
      <span>{fmtLastSync(dataUpdatedAt)}</span>
    </div>
  );
}
