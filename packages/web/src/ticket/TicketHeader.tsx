// dispatch — TicketHeader: ticket detail header bar
//
// Renders the back breadcrumb, ticket ID, title, status control,
// client/assignee/SLA meta row, Reinforcement button, and More button.
//
// Phase-1 scope:
//   NO .clock-grp clock/billable controls (Phase 3).
//   Status control wired to PATCH /api/tickets/:id/status (Slice 6).
//   Slice 7: ReassignControl + EffortBucketControl wired.
//
// Ported from ticket-detail.jsx TicketHeader (without clock-grp props).

import React, { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { Avatar } from "../shell/Avatar";
import Ic from "../shell/Ic";
import { ACCOUNTS, HEALTH_LABEL } from "../lib/seed";
import type { Ticket, TicketStatus } from "../lib/types";
import { apiClient } from "../lib/api-client";
import { ReassignControl } from "./ReassignControl";
import { EffortBucketControl } from "./EffortBucketControl";

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

// ── StatusDropdown ────────────────────────────────────────────────────────────

const STATUS_ORDER: TicketStatus[] = [
  "new",
  "on-you",
  "waiting-client",
  "follow-up-required",
  "follow-up-1-sent",
  "closeout",
  "closed",
  "complete",
];

interface StatusDropdownProps {
  ticketId: string;
  currentStatus: TicketStatus;
  onChanged?: (newStatus: TicketStatus) => void;
}

function StatusDropdown({ ticketId, currentStatus, onChanged }: StatusDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (status: TicketStatus) =>
      apiClient.patch(`/api/tickets/${ticketId}/status`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] });
      void queryClient.invalidateQueries({ queryKey: ["tickets"] });
    },
  });

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  function handleSelect(status: TicketStatus) {
    if (status === currentStatus) {
      setOpen(false);
      return;
    }
    mutation.mutate(status, {
      onSuccess: () => {
        onChanged?.(status);
        setOpen(false);
      },
    });
  }

  const statusLabel = STATUS_LABEL[currentStatus] ?? currentStatus;

  return (
    <div className="status-control" ref={ref} style={{ position: "relative", cursor: "pointer" }}
      onClick={() => setOpen((v) => !v)}
      title="Change status"
    >
      <span className="stat-dot"></span>
      {statusLabel}
      <Ic.chev />
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            background: "var(--surface-2, #1e1e2e)",
            border: "1px solid var(--border, #2a2a3a)",
            borderRadius: 6,
            minWidth: 180,
            zIndex: 100,
            padding: "4px 0",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {STATUS_ORDER.map((s) => (
            <div
              key={s}
              style={{
                padding: "6px 14px",
                cursor: "pointer",
                fontWeight: s === currentStatus ? 600 : 400,
                color: s === currentStatus ? "var(--accent, #6366f1)" : "inherit",
                fontSize: 13,
              }}
              onClick={() => handleSelect(s)}
            >
              {STATUS_LABEL[s] ?? s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TicketHeader ──────────────────────────────────────────────────────────────

interface TicketHeaderProps {
  ticket: Ticket;
  assigneeName?: string;
  isAdmin?: boolean;
}

export function TicketHeader({ ticket, assigneeName, isAdmin = false }: TicketHeaderProps) {
  const account = ACCOUNTS[ticket.accountId];
  const clientName = account?.displayName ?? ticket.clientName ?? ticket.accountId;
  const clientHealth = account?.health ?? ticket.clientHealth ?? "good";
  const healthLabel = HEALTH_LABEL[clientHealth] ?? clientHealth;
  const { label: slaLabel, color: slaColor } = slaDisplay(ticket);
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
        <StatusDropdown ticketId={ticket.id} currentStatus={ticket.status} />
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
          <ReassignControl ticketId={ticket.id} isAdmin={isAdmin} />
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
        <EffortBucketControl ticketId={ticket.id} currentBucket={ticket.effortBucket} />
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
