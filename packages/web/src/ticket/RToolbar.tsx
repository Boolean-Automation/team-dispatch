// dispatch — RToolbar: right icon toolbar
//
// Phase-1 scope: Info + Activity icons are wired.
// Spike #1 wires the third button — claude-code (Ic.terminal) — between Info
// and Activity, matching the surface-map toolbar order.
// Tertiary icons: linked ticket / files / more — rendered but not wired.
//
// Ported from ticket-detail.jsx RToolbar.

import React from "react";
import Ic from "../shell/Ic";
import type { PanelMode } from "./RightPanel";

interface RToolbarProps {
  mode: PanelMode;
  setMode: (mode: PanelMode) => void;
}

export function RToolbar({ mode, setMode }: RToolbarProps) {
  return (
    <div className="r-toolbar">
      <button
        className={`r-tb ${mode === "info" ? "active" : ""}`}
        title="Ticket & client info"
        onClick={() => setMode("info")}
      >
        <Ic.info />
      </button>

      <button
        className={`r-tb ${mode === "terminal" ? "active" : ""}`}
        title="claude-code"
        onClick={() => setMode("terminal")}
      >
        <Ic.terminal />
      </button>

      <button
        className={`r-tb ${mode === "activity" ? "active" : ""}`}
        title="Activity log"
        onClick={() => setMode("activity")}
      >
        <Ic.clock />
      </button>

      <span className="r-tb-spacer"></span>

      <button className="r-tb" title="Linked ticket">
        <Ic.link />
      </button>
      <button className="r-tb" title="Files">
        <Ic.paperclip />
      </button>
      <button className="r-tb" title="More">
        <Ic.dots />
      </button>
    </div>
  );
}
