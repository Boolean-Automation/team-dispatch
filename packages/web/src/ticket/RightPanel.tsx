// dispatch — RightPanel: right panel container.
//
// Phase 2 / Slice 3: the Spike #1 "terminal" branch has been retired
// (visual spec §0, §11.3; OQ-4). PanelMode narrows to `"info" | "activity"`.
// The terminal surface now lives in `TerminalPanel` at the bottom of the
// ticket route (default) or docked to the right edge per Settings.

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
  let title = "Ticket & client";
  if (mode === "activity") title = "Activity";

  let sub: string = ticket.displayId;
  if (mode === "activity") sub = `${activityItems.length} events`;

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
        {mode === "activity" && <PanelActivity items={activityItems} />}
      </div>
    </aside>
  );
}
