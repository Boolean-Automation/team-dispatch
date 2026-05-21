// dispatch — InternalThread: internal per-Ticket thread component
//
// Phase-1 scope:
//   - Lists existing internal thread messages for a Ticket.
//   - Composer for posting new internal messages.
//   - NO channel tag on messages (OQ-3 — dispatch-native only; no Slack sync).
//   - NEVER written to Slack (A21).
//   - Post is undoable via useUndoableMutation + undo toast (A25).
//
// Data: GET/POST /api/tickets/:id/internal-thread
//
// plan §Slice 7

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUndoableMutation } from "../lib/use-undoable-mutation.js";
import { apiClient } from "../lib/api-client.js";
import { Avatar } from "../shell/Avatar";

export interface InternalMessage {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  postedAt: string;
  createdAt: string;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface InternalThreadProps {
  ticketId: string;
  /** Current user's Clerk id — for attributing new messages */
  currentUserId?: string;
}

export function InternalThread({ ticketId, currentUserId }: InternalThreadProps) {
  const [draft, setDraft] = useState("");

  const { data: messages = [], isLoading } = useQuery<InternalMessage[]>({
    queryKey: ["internal-thread", ticketId],
    queryFn: () =>
      apiClient.get<InternalMessage[]>(
        `/api/tickets/${ticketId}/internal-thread`
      ),
    enabled: Boolean(ticketId),
    refetchInterval: 25_000,
  });

  const postMutation = useUndoableMutation({
    mutationFn: async (body: string) =>
      apiClient.post<{ message: InternalMessage; undoToken: string }>(
        `/api/tickets/${ticketId}/internal-thread`,
        { body }
      ),
    toastLabel: "Internal message sent",
    invalidateKeys: [["internal-thread", ticketId]],
  });

  function handleSend() {
    if (!draft.trim()) return;
    postMutation.mutate(draft.trim(), {
      onSuccess: () => setDraft(""),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  if (isLoading) {
    return (
      <div
        className="thread-scroll"
        style={{ color: "var(--text-3)", fontSize: 12, padding: "16px 0" }}
      >
        Loading…
      </div>
    );
  }

  return (
    <div className="thread-scroll" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {messages.length === 0 && (
        <div
          style={{
            color: "var(--text-3)",
            fontSize: 12,
            padding: "20px 0",
            textAlign: "center",
          }}
        >
          No internal messages yet. Start the thread below.
        </div>
      )}

      {messages.map((msg) => (
        <div key={msg.id} className="msg internal" style={{ padding: "10px 0" }}>
          <Avatar engKey={msg.authorId} />
          <div className="msg-body">
            <div className="msg-head">
              <span className="msg-from">{msg.authorId}</span>
              {/* OQ-3: NO channel tag — dispatch-native only */}
              <span className="msg-time mono">{fmtTime(msg.postedAt)}</span>
            </div>
            <div className="msg-text">{msg.body}</div>
          </div>
        </div>
      ))}

      {/* Internal thread composer */}
      <div
        className="composer"
        style={{ marginTop: "auto", borderTop: "1px solid var(--border)" }}
      >
        <div
          className="composer-head"
          style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 4 }}
        >
          Internal note — visible only in dispatch
        </div>
        <textarea
          className="compose-area"
          placeholder="Write an internal note…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          style={{ resize: "vertical" }}
        />
        <div className="compose-actions">
          <span style={{ flex: 1 }} />
          <button
            className="btn-outline"
            disabled={!draft.trim() || postMutation.isPending}
            onClick={handleSend}
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}
