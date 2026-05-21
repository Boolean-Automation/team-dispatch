// dispatch — ReassignControl: initiate a ticket reassignment
//
// Phase-1 scope:
//   - Popover with a simple recipient ID input.
//   - Submits POST /api/tickets/:id/reassign.
//   - SE-initiated → pending (toast: "Reassignment requested").
//   - Admin-initiated → accepted (toast: "Ticket reassigned").
//   - Undoable via useUndoableMutation (A25).
//
// plan §Slice 7 / spec A26

import React, { useState, useRef, useEffect } from "react";
import { useUndoableMutation } from "../lib/use-undoable-mutation.js";
import { apiClient } from "../lib/api-client.js";
import Ic from "../shell/Ic";

interface ReassignControlProps {
  ticketId: string;
  isAdmin?: boolean;
  onReassigned?: (recipientId: string, status: "pending" | "accepted") => void;
}

export function ReassignControl({
  ticketId,
  isAdmin = false,
  onReassigned,
}: ReassignControlProps) {
  const [open, setOpen] = useState(false);
  const [recipientId, setRecipientId] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const toastLabel = isAdmin
    ? "Ticket reassigned"
    : "Reassignment requested — waiting for recipient";

  const reassignMutation = useUndoableMutation({
    mutationFn: (recipient: string) =>
      apiClient.post<{
        reassignment: { id: string; status: "pending" | "accepted" };
        undoToken: string;
      }>(`/api/tickets/${ticketId}/reassign`, { recipientId: recipient }),
    toastLabel,
    invalidateKeys: [["ticket", ticketId], ["tickets"]],
    onSuccess: (data, vars) => {
      onReassigned?.(vars as string, data.reassignment.status);
      setOpen(false);
      setRecipientId("");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recipientId.trim()) return;
    reassignMutation.mutate(recipientId.trim());
  }

  return (
    <div ref={ref} style={{ display: "inline-block", position: "relative" }}>
      <span
        className="subtle-link"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer" }}
      >
        <Ic.edit /> reassign
      </span>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            background: "var(--surface-2, #1e1e2e)",
            border: "1px solid var(--border, #2a2a3a)",
            borderRadius: 6,
            zIndex: 200,
            padding: 12,
            minWidth: 240,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <form onSubmit={handleSubmit}>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-3)",
                marginBottom: 6,
              }}
            >
              {isAdmin
                ? "Reassign to (immediate):"
                : "Request reassignment to:"}
            </div>
            <input
              type="text"
              placeholder="Clerk user id"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              style={{
                width: "100%",
                padding: "4px 8px",
                background: "var(--surface-1, #13131e)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "inherit",
                fontSize: 13,
                marginBottom: 8,
                boxSizing: "border-box",
              }}
              autoFocus
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={!recipientId.trim() || reassignMutation.isPending}
              style={{ width: "100%" }}
            >
              {isAdmin ? "Reassign" : "Request"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
