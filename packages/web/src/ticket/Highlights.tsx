// dispatch — Highlights: Account Highlights box
//
// Packet §ADR Code-level floors #12:
//   Component contract: { content, sourcePath, editedAt } | null
//   null → component returns null (section absent from DOM — NOT a placeholder)
//   "No highlights yet" string is DELETED from this codebase per the packet ADR.
//
// Server-side truncation at 500 chars (word-boundary + "…") is enforced by
// sync-highlights-from-knowledge.ts. Do NOT use CSS line-clamp here —
// it breaks copy-paste and screen readers (packet ADR §Code-level floors #8).
//
// Phase-1 scope: read highlights from account.highlights; Edit affordance
// calls PATCH /api/accounts/:id/highlights.

import React, { useState } from "react";
import Ic from "../shell/Ic";

export interface HighlightsData {
  /** Highlights text (already truncated at 500 chars server-side) */
  content: string;
  /** Source path label (e.g. "clients/roll-call-painting/profile.md") */
  sourcePath?: string;
  /** Last edited display string (e.g. "4d ago" or "May 24") */
  editedAt?: string;
}

interface HighlightsProps {
  /**
   * Highlights data from the server, or null when there is no content.
   * null → the component returns null (section is absent from DOM).
   * "No highlights yet" text is NEVER rendered.
   */
  highlights: HighlightsData | null;
  /** Called when the user saves a highlights edit */
  onSave?: (text: string) => void;
}

export function Highlights({ highlights, onSave }: HighlightsProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(highlights?.content ?? "");

  // null → absent from DOM per packet contract
  if (!highlights && !editing) return null;

  function handleEdit() {
    setDraft(highlights?.content ?? "");
    setEditing(true);
  }

  function handleSave() {
    onSave?.(draft);
    setEditing(false);
  }

  function handleCancel() {
    setDraft(highlights?.content ?? "");
    setEditing(false);
  }

  const { content = "", sourcePath, editedAt } = highlights ?? {};

  return (
    <div className="highlights">
      <div className="highlights-head">
        <span className="pin">Account highlights</span>
        <span className="spacer"></span>
        {!editing && (
          <button className="edit" onClick={handleEdit}>
            <Ic.edit /> Edit
          </button>
        )}
        {editing && (
          <>
            <button className="edit" onClick={handleSave}>
              Save
            </button>
            <button
              className="edit"
              onClick={handleCancel}
              style={{ marginLeft: 4 }}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {editing ? (
        <textarea
          className="highlights-body"
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text)",
            fontSize: 12.5,
            lineHeight: 1.6,
            padding: "6px 8px",
            resize: "vertical",
            width: "100%",
            minHeight: 80,
          }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
      ) : (
        <div className="highlights-body">{content}</div>
      )}

      {(sourcePath || editedAt) && (
        <div className="highlights-foot">
          {sourcePath && (
            <span
              className="mono"
              title={sourcePath}
              style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}
            >
              {sourcePath.split("/").slice(-2).join(" / ")}
            </span>
          )}
          {sourcePath && editedAt && <span>·</span>}
          {editedAt && <span>Edited {editedAt}</span>}
        </div>
      )}
    </div>
  );
}
