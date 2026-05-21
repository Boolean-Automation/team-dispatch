// dispatch — Highlights: Account Highlights box
//
// Renders the human-curated account highlights text with edit button.
// Phase-1 scope: read from account.highlights, Edit affordance calls
// PATCH /api/accounts/:id/highlights.
//
// Ported from ticket-detail.jsx Highlights component.

import React, { useState } from "react";
import Ic from "../shell/Ic";

interface HighlightsProps {
  /** Current highlights text — null means not set */
  highlights: string | null;
  /** Source path label (e.g. boolean-knowledge/clients/prorise.md) */
  sourcePath?: string;
  /** Last edited display string (e.g. "4d ago by Celine") */
  lastEdited?: string;
  /** Called when the user saves a highlights edit */
  onSave?: (text: string) => void;
}

export function Highlights({
  highlights,
  sourcePath,
  lastEdited,
  onSave,
}: HighlightsProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(highlights ?? "");

  function handleEdit() {
    setDraft(highlights ?? "");
    setEditing(true);
  }

  function handleSave() {
    onSave?.(draft);
    setEditing(false);
  }

  function handleCancel() {
    setDraft(highlights ?? "");
    setEditing(false);
  }

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
        <div className="highlights-body">
          {highlights ? (
            highlights
          ) : (
            <span style={{ color: "var(--text-3)", fontStyle: "italic" }}>
              No highlights yet. Click Edit to add account context.
            </span>
          )}
        </div>
      )}

      {(sourcePath || lastEdited) && (
        <div className="highlights-foot">
          {sourcePath && <span>{sourcePath}</span>}
          {sourcePath && lastEdited && <span>·</span>}
          {lastEdited && <span>Edited {lastEdited}</span>}
        </div>
      )}
    </div>
  );
}
