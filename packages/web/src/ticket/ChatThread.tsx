// dispatch — ChatThread: the scrollable message thread
//
// Renders chat messages, internal thread messages, and linked ticket stubs.
// Phase-1 scope: messages come from the API (GET /api/tickets/:id/messages)
// with fixture fallback for dev. Internal-thread renders without channel tag (OQ-3).
//
// Ported from ticket-detail.jsx Thread component.

import React from "react";
import Ic from "../shell/Ic";
import { Message, Event } from "./Message";
import type { ThreadItem } from "./Message";
import type { Ticket } from "../lib/types";

// ── Linked row ────────────────────────────────────────────────────────────────

function LinkedRow({
  id,
  clientName,
  title,
  status,
}: {
  id: string;
  clientName: string;
  title: string;
  status: string;
}) {
  return (
    <a href="#" className="tlist-item" style={{ borderBottom: "1px solid var(--border)" }}>
      <span
        className="avatar unassigned"
        style={{ background: "var(--raised)", color: "var(--text-2)" }}
      >
        <Ic.link />
      </span>
      <div className="ti-meta">
        <div className="ti-row">
          <span className="ti-client">{clientName}</span>
          <span className="ti-id mono">{id}</span>
        </div>
        <div className="ti-preview">{title}</div>
        <div className="ti-foot">
          <span>{status}</span>
        </div>
      </div>
    </a>
  );
}

// ── ChatThread ────────────────────────────────────────────────────────────────

interface ChatThreadProps {
  tab: "chat" | "internal" | "linked";
  chatItems: ThreadItem[];
  internalItems: ThreadItem[];
}

export function ChatThread({ tab, chatItems, internalItems }: ChatThreadProps) {
  if (tab === "internal") {
    return (
      <div className="thread-scroll">
        <div className="day-rule">
          {/* OQ-3: "synced from Slack" label omitted in Phase 1 — dispatch-native only */}
          <span>Internal thread</span>
        </div>
        {internalItems.map((item, i) => {
          if (item.kind === "msg") {
            return <Message key={i} m={item} internal />;
          }
          return null;
        })}
        {internalItems.length === 0 && (
          <div
            style={{
              padding: "32px 20px",
              color: "var(--text-3)",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            No internal thread messages yet.
          </div>
        )}
      </div>
    );
  }

  if (tab === "linked") {
    return (
      <div className="thread-scroll" style={{ color: "var(--text-2)" }}>
        <div className="day-rule">
          <span>Linked tickets</span>
        </div>
        {/* Phase-1: static placeholder linked tickets */}
        <LinkedRow
          id="DSP-2841"
          clientName="Funky Painting"
          title="Recurring revenue + invoice fire conflict"
          status="Closeout"
        />
        <LinkedRow
          id="DSP-2620"
          clientName="Highfill Painting"
          title="HubSpot property rename broke 3 workflows"
          status="Closed"
        />
      </div>
    );
  }

  // Default: chat tab
  return (
    <div className="thread-scroll">
      {chatItems.map((item, i) => {
        if (item.kind === "day") {
          return (
            <div key={i} className="day-rule">
              <span>{item.label}</span>
            </div>
          );
        }
        if (item.kind === "event") {
          return <Event key={i} m={item} />;
        }
        return <Message key={i} m={item} />;
      })}
      {chatItems.length === 0 && (
        <div
          style={{
            padding: "32px 20px",
            color: "var(--text-3)",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          No messages yet.
        </div>
      )}
    </div>
  );
}
