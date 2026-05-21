// dispatch — PanelActivity: Activity log right panel
//
// Reads audit_log entries for the ticket via GET /api/tickets/:id/activity.
// Phase-1: renders from the API response when available, falls back to placeholder.
// Ported from ticket-detail.jsx PanelActivity.

import React from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActivityItem {
  id: string;
  event: string;
  actorId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dotClass(event: string): string {
  if (event.includes("created")) return "create";
  if (event.includes("status")) return "status";
  if (event.includes("assigned")) return "assign";
  if (event.includes("highlights")) return "alert";
  if (event.includes("message")) return "";
  return "";
}

function eventLabel(item: ActivityItem): string {
  const after = item.after as Record<string, unknown> | null;
  const before = item.before as Record<string, unknown> | null;
  switch (item.event) {
    case "ticket.created":
      return "Ticket created";
    case "ticket.status_changed":
      return `Status → ${String(after?.status ?? "").replace(/-/g, " ")}`;
    case "ticket.assigned":
      return `Assigned to ${String(after?.assignee ?? "unknown")}`;
    case "ticket.dismissed":
      return "Ticket dismissed";
    case "message.created":
      return after?.direction === "outbound" ? "Reply sent" : "Message received";
    case "account.highlights_updated":
      return "Account highlights updated";
    default:
      return item.event;
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ── PanelActivity ─────────────────────────────────────────────────────────────

interface PanelActivityProps {
  items: ActivityItem[];
}

export function PanelActivity({ items }: PanelActivityProps) {
  if (items.length === 0) {
    return (
      <div className="alog">
        <div
          style={{
            padding: "20px",
            color: "var(--text-3)",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          No activity yet.
        </div>
      </div>
    );
  }

  return (
    <div className="alog">
      {items.map((item) => (
        <div key={item.id} className="alog-item">
          <span className={`a-dot ${dotClass(item.event)}`}></span>
          <span>{eventLabel(item)}</span>
          <span className="a-time">{fmtTime(item.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
