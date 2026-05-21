// dispatch — Kanban card component
// Ported from app.jsx Card function.

import React from "react";
import { Link } from "react-router-dom";
import { Avatar } from "../shell/Avatar";
import { fmtAge, fmtSla, slaClass } from "../shell/format";
import { HEALTH_LABEL } from "../lib/seed";
import type { Ticket } from "../lib/types";

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
}

export function Card({ ticket: t, focused = false, onFocus }: CardProps) {
  const sla = fmtSla(t.slaMin);
  const cls = slaClass(t);

  return (
    <Link
      className={`card ${focused ? "focused" : ""}`}
      to={`/t/${t.displayId}`}
      onClick={onFocus}
    >
      <div className="card-head">
        <div className="card-client">{t.clientName}</div>
        <div className="card-id mono">{t.displayId}</div>
      </div>
      <div className="card-preview">{t.preview}</div>
      <div className="card-foot">
        <Avatar engKey={t.assignee} />
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
