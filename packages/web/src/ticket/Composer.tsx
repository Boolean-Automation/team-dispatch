// dispatch — Composer: reply composer at the bottom of the ticket detail center
//
// Phase-1 scope: human-text-only. No AI draft button. No email reply toggle.
// Sends via POST /api/tickets/:id/messages using useUndoableMutation.
//
// Ported from ticket-detail.jsx Composer.

import React, { useState, useCallback } from "react";
import Ic from "../shell/Ic";

interface ComposerProps {
  /** Ticket id (UUID) for the API call */
  ticketId: string;
  /** Display name of the primary contact to address */
  toName?: string;
  /** Slack channel name for the "in #channel" label */
  channelName?: string;
  /** Called when the SE presses send (body, resolve) */
  onSend?: (body: string, resolve: boolean) => void;
  /** True while the send is in progress */
  sending?: boolean;
}

export function Composer({
  ticketId: _ticketId,
  toName = "client",
  channelName = "#channel",
  onSend,
  sending = false,
}: ComposerProps) {
  const [body, setBody] = useState("");

  const handleSend = useCallback(
    (resolve: boolean) => {
      const trimmed = body.trim();
      if (!trimmed || sending) return;
      onSend?.(trimmed, resolve);
      setBody("");
    },
    [body, sending, onSend]
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend(true); // ⌘+Enter → Send & resolve
    }
  }

  return (
    <div className="composer">
      <div className="composer-head">
        <span className="to">
          Reply to <b>{toName}</b> in
        </span>
        <span className="ch-tag"># {channelName.replace("#", "")}</span>
        <span style={{ flex: 1 }}></span>
        {/* Phase 2: email reply toggle omitted */}
      </div>

      <div className="composer-box">
        <textarea
          placeholder="Reply to client… (Shift+Enter for newline, ⌘+Enter to send)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
        />
      </div>

      <div className="composer-foot">
        <button className="compose-act" title="Attach">
          <Ic.paperclip />
        </button>
        <button className="compose-act" title="Mention">
          <span className="mono" style={{ fontSize: 12 }}>
            @
          </span>
        </button>
        <button className="compose-act" title="Snippet">
          <Ic.book />
        </button>
        <span className="compose-spacer"></span>
        <span className="compose-hint">⌘ + ↵ to send</span>
        <button
          className="btn-outline"
          onClick={() => handleSend(false)}
          disabled={sending || !body.trim()}
        >
          Send &amp; keep open
        </button>
        <button
          className="btn-primary"
          onClick={() => handleSend(true)}
          disabled={sending || !body.trim()}
        >
          <Ic.send /> Send &amp; resolve
        </button>
      </div>
    </div>
  );
}
