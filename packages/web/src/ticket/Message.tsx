// dispatch — Message: a single chat message row in the thread
//
// Renders client messages, SE/engineer messages, and internal-thread messages.
// Phase-1 scope: internal-thread messages render WITHOUT the channel tag (OQ-3).
// Ported from ticket-detail.jsx Message + Event components.

import React from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  kind: "msg";
  who: "client" | "eng";
  from: string;
  role: string;
  time: string;
  src?: string; // Slack source tag for chat messages
  channel?: string; // channel for internal-thread — NOT shown in Phase 1 (OQ-3)
  text: string;
}

export interface DayDivider {
  kind: "day";
  label: string;
}

export interface SystemEvent {
  kind: "event";
  text: string;
  time: string;
}

export type ThreadItem = ChatMessage | DayDivider | SystemEvent;

// ── Event row ─────────────────────────────────────────────────────────────────

export function Event({ m }: { m: SystemEvent }) {
  return (
    <div className="event">
      <span>{m.text}</span>
      <span className="e-meta">· {m.time}</span>
    </div>
  );
}

// ── Message row ───────────────────────────────────────────────────────────────

interface MessageProps {
  m: ChatMessage;
  /** True for internal-thread messages — applies .msg.internal styling */
  internal?: boolean;
}

export function Message({ m, internal }: MessageProps) {
  const isClient = m.who === "client";
  const avatarColor = isClient ? "#60A5FA" : "#34D399";
  const initials = m.from ? m.from.charAt(0).toUpperCase() : "?";

  return (
    <div className={`msg ${internal ? "internal" : ""}`}>
      <div className="who">
        <span
          className="avatar"
          style={{ background: avatarColor, width: 26, height: 26, fontSize: 11 }}
        >
          {initials}
        </span>
      </div>
      <div className="body">
        <div className="msg-head">
          <span className="msg-name">{m.from}</span>
          <span className={`msg-role ${isClient ? "client" : "eng"}`}>
            {m.role}
          </span>
          <span className="msg-time mono">{m.time}</span>
          {/* OQ-3: internal-thread channel tag NOT shown in Phase 1 */}
          {!internal && m.src && (
            <span className="msg-src">via {m.src}</span>
          )}
        </div>
        <div className="msg-text">{m.text}</div>
      </div>
    </div>
  );
}
