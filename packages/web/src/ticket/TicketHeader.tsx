// dispatch — TicketHeader: ticket detail header bar
//
// Renders the back breadcrumb, ticket ID, title, status control,
// client/assignee/SLA meta row, Reinforcement button, and More button.
//
// Phase-1 scope:
//   NO .clock-grp clock/billable controls (Phase 3).
//   Status control is display-only in Phase 1 (status mutation Slice 6).
//
// Ported from ticket-detail.jsx TicketHeader (without clock-grp props).

import React from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../shell/Avatar";
import Ic from "../shell/Ic";
import { ACCOUNTS, HEALTH_LABEL } from "../lib/seed";
import type { Ticket } from "../lib/types";

// ── Status label map ──────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  new: "New",
  "on-you": "On You",
  "waiting-client": "Waiting on Client",
  "follow-up-required": "Follow-up Required",
  "follow-up-1-sent": "Follow-up 1 Sent",
  closeout: "Closeout",
  closed: "Closed",
  complete: "Complete",
};

// ── SLA helpers ───────────────────────────────────────────────────────────────

function slaDisplay(
  t: Ticket
): { label: string; color: string } {
  if (t.paused || t.slaMin == null) {
    return { label: "SLA paused", color: "var(--text-3)" };
  }
  const abs = Math.abs(t.slaMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (t.slaMin < 0) {
    return { label: `${timeStr} overdue`, color: "var(--red, #EF4444)" };
  }
  if (t.slaMin < 120) {
    return { label: `${timeStr} left`, color: "var(--amber)" };
  }
  return { label: `${timeStr} left`, color: "var(--emerald)" };
}

// ── TicketHeader ──────────────────────────────────────────────────────────────

interface TicketHeaderProps {
  ticket: Ticket;
  assigneeName?: string;
}

export function TicketHeader({ ticket, assigneeName }: TicketHeaderProps) {
  const account = ACCOUNTS[ticket.accountId];
  const clientName = account?.displayName ?? ticket.clientName ?? ticket.accountId;
  const clientHealth = account?.health ?? ticket.clientHealth ?? "good";
  const healthLabel = HEALTH_LABEL[clientHealth] ?? clientHealth;
  const { label: slaLabel, color: slaColor } = slaDisplay(ticket);
  const statusLabel = STATUS_LABEL[ticket.status] ?? ticket.status;
  const displayAssigneeName = assigneeName ?? ticket.assignee ?? "Unassigned";

  return (
    <div className="t-header">
      <div className="h-top">
        <Link className="t-back" to="/">
          <Ic.chevLeft /> Issues
        </Link>
        <span className="t-divider"></span>
        <span className="t-id mono">{ticket.displayId}</span>
        <span className="t-divider"></span>
        <h1 className="t-title">
          {ticket.preview ?? `Ticket ${ticket.displayId}`}
        </h1>
        <span style={{ flex: 1 }}></span>
        <div className="status-control">
          <span className="stat-dot"></span>
          {statusLabel}
          <Ic.chev />
        </div>
      </div>

      <div className="t-meta">
        <div className="meta-grp">
          <span className="lbl">Client</span>
          <span>{clientName}</span>
          <span className={`health ${clientHealth}`} style={{ marginLeft: 2 }}>
            <span className="h-dot"></span>
            {healthLabel}
          </span>
        </div>
        <span className="t-divider"></span>
        <div className="meta-grp">
          <span className="lbl">Assignee</span>
          <Avatar engKey={ticket.assignee} />
          <span>{displayAssigneeName}</span>
          <span className="subtle-link">
            <Ic.edit /> reassign
          </span>
        </div>
        <span className="t-divider"></span>
        <div className="meta-grp">
          <span className="lbl">SLA</span>
          <span className="mono" style={{ color: slaColor }}>
            ● {slaLabel}
          </span>
        </div>
        <span style={{ flex: 1 }}></span>
        {/* Phase 3 clock-grp OMITTED per surface-map §3 */}
        <button className="btn-outline" title="Add reinforcement">
          <Ic.plus /> Reinforcement
        </button>
        <button className="btn-ghost" title="More">
          <Ic.dots />
        </button>
      </div>
    </div>
  );
}
