// dispatch — TicketTabs: Chat / Internal thread / Linked tab bar
//
// Phase-1 scope: all three tabs are built; internal-thread messages render
// WITHOUT the channel tag (OQ-3 resolution — no Slack sync in Phase 1).
// Slice 7: InternalThread component wired when tab === 'internal'.
// Ported from ticket-detail.jsx Tabs.

import React from "react";
import Ic from "../shell/Ic";

export type TicketTab = "chat" | "internal" | "linked";

interface TicketTabsProps {
  value: TicketTab;
  onChange: (tab: TicketTab) => void;
  channelName?: string;
  chatBadge?: number;
  internalBadge?: number;
  linkedCount?: number;
}

export function TicketTabs({
  value,
  onChange,
  channelName = "#channel",
  chatBadge,
  internalBadge,
  linkedCount = 0,
}: TicketTabsProps) {
  return (
    <div className="t-tabs">
      <button
        className={`tab ${value === "chat" ? "active" : ""}`}
        onClick={() => onChange("chat")}
      >
        Chat
        <span className="src-tag slack">{channelName}</span>
        {chatBadge != null && chatBadge > 0 && (
          <span className="badge">{chatBadge}</span>
        )}
      </button>

      <button
        className={`tab ${value === "internal" ? "active" : ""}`}
        onClick={() => onChange("internal")}
      >
        Internal thread
        {/* OQ-3: no channel tag in Phase 1 — internal thread is dispatch-native only */}
        {internalBadge != null && internalBadge > 0 && (
          <span className="badge">{internalBadge}</span>
        )}
      </button>

      <button
        className={`tab ${value === "linked" ? "active" : ""}`}
        onClick={() => onChange("linked")}
      >
        Linked
        <span className="sub mono">· {linkedCount}</span>
      </button>

      <span style={{ flex: 1 }}></span>
      <button className="tab-add" onClick={() => onChange("internal")}>
        <Ic.plus /> Internal thread
      </button>
    </div>
  );
}
