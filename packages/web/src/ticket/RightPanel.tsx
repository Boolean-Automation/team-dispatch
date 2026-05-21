// dispatch — RightPanel: right panel container
//
// Phase-1 scope: "info" and "activity" panel modes.
// Spike #1 adds the "terminal" mode — the embedded claude-code panel.
//
// Ported from ticket-detail.jsx RightPanel; the spike widens PanelMode and
// adds the PanelTerminal branch.

import React from "react";
import Ic from "../shell/Ic";
import { PanelInfo } from "./PanelInfo";
import { PanelActivity } from "./PanelActivity";
import { PanelTerminal } from "./PanelTerminal";
import type { ActivityItem } from "./PanelActivity";
import type { Ticket } from "../lib/types";

export type PanelMode = "info" | "activity" | "terminal";

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
  let title = "Ticket & client";
  if (mode === "activity") title = "Activity";
  else if (mode === "terminal") title = "claude-code";

  let sub: string = ticket.displayId;
  if (mode === "activity") sub = `${activityItems.length} events`;
  else if (mode === "terminal") sub = "claude-code";

  // In terminal mode the head is a live connection-state region (visual §2
  // a11y) — announce changes politely without stealing focus from the panel.
  const headProps =
    mode === "terminal"
      ? ({ role: "status", "aria-live": "polite" } as const)
      : {};

  return (
    <aside className="rpanel">
      <div className="rpanel-head" {...headProps}>
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
        {mode === "terminal" && <PanelTerminal ticket={ticket} />}
      </div>
    </aside>
  );
}
