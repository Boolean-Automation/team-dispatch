// dispatch — Kanban card component
// Ported from app.jsx Card function.
// Slice 4: adds dismiss affordance (undoable via POST /api/tickets/:id/dismiss).

import React from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../shell/Avatar.js";
import { fmtAge, fmtSla, slaClass } from "../shell/format.js";
import { HEALTH_LABEL } from "../lib/seed.js";
import type { Ticket } from "../lib/types.js";
import { useUndoableMutation } from "../lib/use-undoable-mutation.js";

interface TagProps {
  type: Ticket["type"];
}

function Tag({ type }: TagProps) {
  return <span className={`tag ${type}`}>{type.toUpperCase()}</span>;
}

interface CardProps {
  ticket: Ticket;
  focused?: boolean;
  onFocus?: () => void;
  onDismissed?: (ticketId: string) => void;
}

export function Card({ ticket: t, focused = false, onFocus, onDismissed }: CardProps) {
  const sla = fmtSla(t.slaMin);
  const cls = slaClass(t);

  const dismissMutation = useUndoableMutation<{ ok: boolean; undoToken: string }, string>({
    mutationFn: async (ticketId: string) => {
      const res = await fetch(`/api/tickets/${ticketId}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`Dismiss failed: ${res.status}`);
      return res.json() as Promise<{ ok: boolean; undoToken: string }>;
    },
    toastLabel: "Ticket dismissed",
    invalidateKeys: [["tickets"]],
    onSuccess: (_data, ticketId) => {
      onDismissed?.(ticketId);
    },
  });

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dismissMutation.mutate(t.id);
  };

  const reopenMutation = useUndoableMutation<{ ok: boolean; undoToken: string }, string>({
    mutationFn: async (ticketId: string) => {
      const res = await fetch(`/api/tickets/${ticketId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "on-you" }),
      });
      if (!res.ok) throw new Error(`Reopen failed: ${res.status}`);
      return res.json() as Promise<{ ok: boolean; undoToken: string }>;
    },
    toastLabel: "Ticket reopened",
    invalidateKeys: [["tickets"]],
  });

  const handleReopen = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    reopenMutation.mutate(t.id);
  };

  const isClosed = t.status === "closed";

  return (
    <Link
      className={`card ${focused ? "focused" : ""}`}
      to={`/t/${t.displayId}`}
      onClick={onFocus}
    >
      <div className="card-head">
        <div className="card-client">{t.clientName}</div>
        <div className="card-id mono">{t.displayId}</div>
        {isClosed ? (
          <button
            className="card-reopen"
            title="Reopen ticket"
            onClick={handleReopen}
            aria-label="Reopen ticket"
            disabled={reopenMutation.isPending}
            style={{
              marginLeft: "auto",
              fontSize: 11,
              background: "none",
              border: "1px solid var(--line, #3a3a3a)",
              borderRadius: 4,
              padding: "1px 6px",
              cursor: "pointer",
              color: "inherit",
            }}
          >
            Reopen
          </button>
        ) : (
          <button
            className="card-dismiss"
            title="Dismiss ticket"
            onClick={handleDismiss}
            aria-label="Dismiss ticket"
            style={{ marginLeft: "auto", opacity: 0.4, background: "none", border: "none", cursor: "pointer" }}
          >
            ×
          </button>
        )}
      </div>
      <div className="card-preview">{t.preview}</div>
      <div className="card-foot">
        <Avatar engKey={t.assignee} alt={t.clientName ?? "Contact avatar"} />
        <span className="age mono">{fmtAge(t.ageMin)}</span>
        {sla && (
          <span className={`sla mono ${cls}`}>
            {t.paused ? "paused" : sla}
          </span>
        )}
        <Tag type={t.type} />
        <span className={`health ${t.clientHealth}`}>
          <span className="h-dot" aria-hidden="true" />
          {HEALTH_LABEL[t.clientHealth] ?? t.clientHealth}
        </span>
      </div>
    </Link>
  );
}
