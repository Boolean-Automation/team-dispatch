// dispatch — Analytics stub page (Phase 1: nav target only)
// Full charts / metrics are deferred to Phase 4 per surface-map §5.
// Phase 1 records raw response-time + resolution-time timestamps so Phase 4 has data;
// no rendering happens here.

import React from "react";
import { Rail } from "../shell/Rail";

export function AnalyticsPage() {
  return (
    <div className="app analytics">
      <Rail current="analytics" />
      <div className="main" style={{ display: "flex", flexDirection: "column" }}>
        {/* Topbar stub */}
        <div className="topbar">
          <div className="topbar-title">
            <span className="screen-title">Analytics</span>
          </div>
        </div>
        {/* Content placeholder — full Analytics surface is Phase 4 */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-3)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            letterSpacing: "0.04em",
          }}
        >
          Analytics — coming in Phase 4
        </div>
      </div>
    </div>
  );
}
