// dispatch — Ticket Detail page (Slice 1: route placeholder)
// Full detail surface (strip, header, tabs, thread, composer, right panel) builds in Slice 5.
// This placeholder satisfies the /t/:displayId route so navigation works.

import React from "react";
import { useParams, Link } from "react-router-dom";
import { Rail } from "../shell/Rail";
import Ic from "../shell/Ic";

export function TicketDetailPage() {
  const { displayId } = useParams<{ displayId: string }>();

  return (
    <div className="app detail">
      <Rail current="issues" />
      <div className="main" style={{ display: "flex", flexDirection: "column" }}>
        <div className="topbar">
          <div className="topbar-title">
            <Link to="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-3)", fontSize: 12 }}>
              <Ic.chevLeft />
              Issues
            </Link>
            <span className="mono" style={{ fontSize: 12, color: "var(--text-3)", marginLeft: 8 }}>
              {displayId}
            </span>
          </div>
        </div>
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
          Ticket detail — builds in Slice 5
        </div>
      </div>
    </div>
  );
}
