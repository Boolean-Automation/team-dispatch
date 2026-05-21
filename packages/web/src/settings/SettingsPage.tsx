// dispatch — Settings stub page (Phase 1: nav target only)
// Full Triggers / Team & OOO / Connections / General UI is deferred per surface-map §4.

import React from "react";
import { Rail } from "../shell/Rail";

export function SettingsPage() {
  return (
    <div className="app settings">
      <Rail current="settings" />
      <div className="main" style={{ display: "flex", flexDirection: "column" }}>
        {/* Topbar stub */}
        <div className="topbar">
          <div className="topbar-title">
            <span className="screen-title">Settings</span>
          </div>
        </div>
        {/* Content placeholder — full Settings surface is deferred */}
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
          Settings — coming in a later phase
        </div>
      </div>
    </div>
  );
}
