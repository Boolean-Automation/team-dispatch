// dispatch — TicketStrip: left ticket list sidebar on the ticket detail screen
//
// Renders the "On you · N" / "Up next · N" sections with strip items.
// Ported from ticket-detail.jsx TicketStrip / StripItem.
// Phase-1 scope: renders from seed data (SEED_TICKETS). Slice 7 will wire live data.

import React from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../shell/Avatar";
import { SEED_TICKETS, ACCOUNTS, HEALTH_LABEL } from "../lib/seed";
import type { Ticket } from "../lib/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAge(ageMin: number): string {
  if (ageMin < 60) return `${ageMin}m`;
  const h = Math.floor(ageMin / 60);
  const m = ageMin % 60;
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtSla(slaMin: number | null): string | null {
  if (slaMin == null) return null;
  const abs = Math.abs(slaMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const fmt = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return slaMin < 0 ? `-${fmt}` : fmt;
}

function slaClass(t: Ticket): string {
  if (t.paused) return "paused";
  if (t.slaMin == null) return "";
  if (t.slaMin < 0) return "over";
  if (t.slaMin < 120) return "warn";
  return "";
}

// ── StripItem ─────────────────────────────────────────────────────────────────

interface StripItemProps {
  t: Ticket;
  activeDisplayId?: string;
}

function StripItem({ t, activeDisplayId }: StripItemProps) {
  const account = ACCOUNTS[t.accountId];
  const clientName = account?.displayName ?? t.clientName ?? t.accountId;
  const sla = fmtSla(t.slaMin);
  const isActive = t.displayId === activeDisplayId;

  return (
    <Link
      to={`/t/${t.displayId}`}
      className={`tlist-item ${isActive ? "active" : ""}`}
    >
      <Avatar engKey={t.assignee} />
      <div className="ti-meta">
        <div className="ti-row">
          <span className="ti-client">{clientName}</span>
          <span className="ti-id mono">{t.displayId.replace("DSP-", "")}</span>
        </div>
        <div className="ti-preview">{t.preview}</div>
        <div className="ti-foot">
          <span>{fmtAge(t.ageMin)}</span>
          <span className={`ti-sla ${slaClass(t)}`}>
            {t.paused ? "paused" : sla ?? t.status}
          </span>
        </div>
      </div>
    </Link>
  );
}

// ── TicketStrip ───────────────────────────────────────────────────────────────

interface TicketStripProps {
  /** The displayId of the currently open ticket (for active highlight) */
  activeDisplayId?: string;
}

export function TicketStrip({ activeDisplayId }: TicketStripProps) {
  const onYou = SEED_TICKETS.filter((t) => t.status === "on-you");
  const next = SEED_TICKETS.filter(
    (t) =>
      t.status !== "on-you" &&
      t.status !== "waiting-client" &&
      t.status !== "closed" &&
      t.status !== "complete"
  ).slice(0, 5); // show a reasonable number of "up next"

  return (
    <div className="tlist">
      <div className="tlist-head">
        <span className="label">On you · {onYou.length}</span>
        <span className="count mono">7/16</span>
      </div>
      <div className="tlist-scroll">
        {onYou.map((t) => (
          <StripItem key={t.id} t={t} activeDisplayId={activeDisplayId} />
        ))}
        <div
          className="tlist-head"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <span className="label">Up next · {next.length}</span>
          <span className="count mono"></span>
        </div>
        {next.map((t) => (
          <StripItem key={t.id} t={t} activeDisplayId={activeDisplayId} />
        ))}
      </div>
    </div>
  );
}
