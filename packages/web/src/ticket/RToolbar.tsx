// dispatch — RToolbar: right icon toolbar.
//
// Phase 2 / Slice 3: the Spike #1 "claude-code" (Ic.terminal) button has been
// retired — the terminal panel surface moved to bottom-slide-up + dock-right
// per visual spec §0/§11.3. RToolbar is back to its Phase-1 scope:
// Info + Activity wired, tertiary icons rendered but not wired.

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
