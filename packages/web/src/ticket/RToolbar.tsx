// dispatch — RToolbar: right icon toolbar
//
// Phase-1 scope: Info + Activity icons are wired.
// Phase-2 terminal icon is OMITTED (not wired, not rendered per surface-map §3).
// Tertiary icons: linked ticket / files / more — rendered but not wired.
//
// Ported from ticket-detail.jsx RToolbar (without terminal item).

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

      {/* Phase 2 — terminal icon OMITTED (do not wire panel === "terminal") */}

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
