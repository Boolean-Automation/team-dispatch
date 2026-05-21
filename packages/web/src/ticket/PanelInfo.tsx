// dispatch — PanelInfo: Ticket & client info right panel
//
// Phase-1 scope: all fields built. Effort section renders layout with
// placeholder/zero values (Phase 3 clock-in writes the data).
// Ported from ticket-detail.jsx PanelInfo.

import React from "react";
import { Avatar } from "../shell/Avatar";
import Ic from "../shell/Ic";
import { ACCOUNTS, HEALTH_LABEL } from "../lib/seed";
import type { Ticket } from "../lib/types";

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

const TYPE_TAG_CLASS: Record<string, string> = {
  question: "question",
  reply: "reply",
  thanks: "thanks",
  ooo: "ooo",
  other: "other",
};

function fmtSla(t: Ticket): { label: string; color: string } {
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
  return { label: `${timeStr} left · of 6h`, color: "var(--amber)" };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

interface PanelInfoProps {
  ticket: Ticket;
  assigneeName?: string;
}

export function PanelInfo({ ticket, assigneeName }: PanelInfoProps) {
  const account = ACCOUNTS[ticket.accountId];
  const clientName = account?.displayName ?? ticket.clientName ?? ticket.accountId;
  const clientHealth = account?.health ?? ticket.clientHealth ?? "good";
  const statusLabel = STATUS_LABEL[ticket.status] ?? ticket.status;
  const { label: slaLabel, color: slaColor } = fmtSla(ticket);
  const typeClass = TYPE_TAG_CLASS[ticket.type] ?? "other";
  const displayAssigneeName = assigneeName ?? ticket.assignee ?? "Unassigned";

  return (
    <>
      {/* ── Ticket section ─────────────────────────────────────────────────── */}
      <div className="rp-section">
        <div className="head">
          <span>Ticket</span>
        </div>
        <div className="rp-row">
          <span className="k">Status</span>
          <span className="v">
            <span
              className="status-control"
              style={{ padding: "2px 8px", fontSize: 11.5 }}
            >
              <span className="stat-dot"></span> {statusLabel} <Ic.chev />
            </span>
          </span>
        </div>
        <div className="rp-row">
          <span className="k">Assignee</span>
          <span className="v">
            <span className="editable">
              <Avatar engKey={ticket.assignee} /> {displayAssigneeName}{" "}
              <Ic.chev />
            </span>
          </span>
        </div>
        <div className="rp-row">
          <span className="k">Collaborators</span>
          <span className="v">
            <span className="subtle-link" style={{ marginLeft: 0 }}>
              + add
            </span>
          </span>
        </div>
        <div className="rp-row">
          <span className="k">SLA</span>
          <span className="v mono" style={{ color: slaColor }}>
            {slaLabel}
          </span>
        </div>
        <div className="rp-row">
          <span className="k">Source</span>
          <span className="v">
            {ticket.sourceChannelId ? (
              <span className="msg-channel">{ticket.sourceChannelId}</span>
            ) : (
              <span style={{ color: "var(--text-3)" }}>—</span>
            )}
          </span>
        </div>
        <div className="rp-row">
          <span className="k">Type</span>
          <span className="v">
            <span className={`tag ${typeClass}`}>
              {ticket.type.toUpperCase()}
            </span>
          </span>
        </div>
        <div className="rp-row">
          <span className="k">Opened</span>
          <span className="v mono">{fmtDate(ticket.openedAt)}</span>
        </div>
      </div>

      {/* ── Effort section (Phase-1: layout only, zero data until Phase 3) ─── */}
      <div className="rp-section">
        <div className="head">
          <span>Effort</span>
        </div>
        <div className="effort">
          <div className="effort-row">
            <span>
              <span className="num">0h</span>{" "}
              <span className="lbl">logged</span>
            </span>
            <span className="lbl">est. —</span>
          </div>
          <div className="effort-bar">
            <div className="effort-fill" style={{ width: "0%" }}></div>
          </div>
          <div className="effort-foot">
            <span>0h billable</span>
            <span>·</span>
            <span>0h internal</span>
            <span>·</span>
            <span>0 sessions</span>
          </div>
        </div>
      </div>

      {/* ── Client facts section ──────────────────────────────────────────── */}
      <div className="rp-section">
        <div className="head">
          <span>{clientName}</span>
        </div>
        <div className="fact">
          <span className="fk">Health</span>
          <span
            className="fv"
            style={{
              color:
                clientHealth === "crit"
                  ? "var(--red, #EF4444)"
                  : clientHealth === "risk"
                  ? "var(--amber)"
                  : "var(--emerald)",
            }}
          >
            {HEALTH_LABEL[clientHealth] ?? clientHealth}
          </span>
        </div>
        <div className="fact">
          <span className="fk">Source</span>
          <span className="fv">{ticket.sourceKind}</span>
        </div>
      </div>

      {/* ── Actions section ──────────────────────────────────────────────── */}
      <div className="rp-section">
        <div className="head">
          <span>Actions</span>
        </div>
        <div className="actions-grid">
          <button className="btn-outline">
            <Ic.user /> Reassign
          </button>
          <button className="btn-outline">
            <Ic.plus /> Reinforcement
          </button>
          <button className="btn-outline">
            <Ic.link /> Link ticket
          </button>
          <button className="btn-outline">
            <Ic.calendar /> Snooze
          </button>
        </div>
      </div>
    </>
  );
}
