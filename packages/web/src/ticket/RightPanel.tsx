// dispatch — RightPanel: right panel container
//
// Phase-1 scope: "info" and "activity" panel modes.
// Phase-2 terminal panel is NOT built (surface-map §3).
//
// Ported from ticket-detail.jsx RightPanel (without terminal mode).

import React from "react";
import Ic from "../shell/Ic";
import { PanelInfo } from "./PanelInfo";
import { PanelActivity } from "./PanelActivity";
import type { ActivityItem } from "./PanelActivity";
import type { Ticket } from "../lib/types";

export type PanelMode = "info" | "activity";

interface RightPanelProps {
  mode: PanelMode;
  ticket: Ticket;
  assigneeName?: string;
  activityItems?: ActivityItem[];
}

export function RightPanel({
  mode,
  ticket,
  assigneeName,
  activityItems = [],
}: RightPanelProps) {
  const title = mode === "activity" ? "Activity" : "Ticket & client";
  const sub = mode === "activity"
    ? `${activityItems.length} events`
    : ticket.displayId;

  return (
    <aside className="rpanel">
      <div className="rpanel-head">
        <span className="title">{title}</span>
        <span className="sub">{sub}</span>
        <span className="spacer"></span>
        <button
          className="btn-ghost"
          style={{ padding: "2px 6px", height: 24 }}
        >
          <Ic.dots />
        </button>
      </div>
      <div className="rpanel-body">
        {mode === "info" && (
          <PanelInfo ticket={ticket} assigneeName={assigneeName} />
        )}
        {mode === "activity" && (
          <PanelActivity items={activityItems} />
        )}
      </div>
    </aside>
  );
}
