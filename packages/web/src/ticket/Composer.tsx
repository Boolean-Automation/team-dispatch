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
  /** Display name of the primary contact to address (full name preferred) */
  senderDisplayName?: string | null;
  /** First name fallback */
  senderFirstName?: string | null;
  /** Handle fallback (e.g. Slack handle) */
  senderHandle?: string | null;
  /** Slack channel name for the "in #channel" label */
  channelName?: string;
  /** Called when the SE presses send (body, resolve) */
  onSend?: (body: string, resolve: boolean) => void;
  /** True while the send is in progress */
  sending?: boolean;
  /** When true, composer is disabled (ticket closed or complete) */
  disabled?: boolean;
}

export function Composer({
  ticketId: _ticketId,
  senderDisplayName,
  senderFirstName,
  senderHandle,
  channelName = "#channel",
  onSend,
  sending = false,
  disabled = false,
}: ComposerProps) {
  // Fallback chain: senderDisplayName ?? senderFirstName ?? senderHandle ?? "the client"
  const toName =
    senderDisplayName ??
    senderFirstName ??
    senderHandle ??
    "the client";

  const isDisabled = disabled || sending;
  const [body, setBody] = useState("");

  const handleSend = useCallback(
    (resolve: boolean) => {
      const trimmed = body.trim();
      if (!trimmed || isDisabled) return;
      onSend?.(trimmed, resolve);
      setBody("");
    },
    [body, isDisabled, onSend]
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSend(true); // ⌘+Enter → Send & resolve
    }
  }

  return (
    <div className="composer" aria-disabled={isDisabled || undefined}>
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
          placeholder={`Reply to ${toName}… (Shift+Enter for newline, ⌘+Enter to send)`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          aria-disabled={isDisabled || undefined}
        />
      </div>

      <div className="composer-foot">
        <button className="compose-act" title="Attach" disabled={isDisabled}>
          <Ic.paperclip />
        </button>
        <button className="compose-act" title="Mention" disabled={isDisabled}>
          <span className="mono" style={{ fontSize: 12 }}>
            @
          </span>
        </button>
        <button className="compose-act" title="Snippet" disabled={isDisabled}>
          <Ic.book />
        </button>
        <span className="compose-spacer"></span>
        <span className="compose-hint">⌘ + ↵ to send</span>
        <button
          className="btn-outline"
          onClick={() => handleSend(false)}
          disabled={isDisabled || !body.trim()}
          aria-disabled={isDisabled || undefined}
        >
          Send &amp; keep open
        </button>
        <button
          className="btn-primary"
          onClick={() => handleSend(true)}
          disabled={isDisabled || !body.trim()}
          aria-disabled={isDisabled || undefined}
        >
          <Ic.send /> Send &amp; resolve
        </button>
      </div>
    </div>
  );
}
