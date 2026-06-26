// dispatch — Kanban column component
// Ported from app.jsx Column function.

import React from "react";
import Ic from "../shell/Ic";
import { Card } from "./Card";
import type { Ticket } from "../lib/types";
import { openNewTicket } from "../lib/new-ticket-bus";

interface ColumnStatus {
  key: string;
  name: string;
}

interface ColumnProps {
  status: ColumnStatus;
  tickets: Ticket[];
  focusedId: string | null;
  onFocus: (id: string) => void;
}

export function Column({ status, tickets, focusedId, onFocus }: ColumnProps) {
  return (
    <div className="col" data-status={status.key}>
      <div className="col-head">
        <span className="name">{status.name}</span>
        <span className="count mono">{tickets.length}</span>
        <span className="spacer" />
        <button
          className="head-act"
          title="Add ticket"
          aria-label="Add ticket"
          onClick={() => openNewTicket()}
        >
          <Ic.plus />
        </button>
        <button className="head-act" title="More">
          <Ic.dots />
        </button>
      </div>
      <div className="col-list">
        {tickets.map((t) => (
          <Card
            key={t.id}
            ticket={t}
            focused={focusedId === t.id}
            onFocus={() => onFocus(t.id)}
          />
        ))}
      </div>
    </div>
  );
}
