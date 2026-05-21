// dispatch — EffortBucketControl: capture the effort bucket on a ticket
//
// Phase-1 scope:
//   - Dropdown to set effort_bucket: client-specific / platform-shared / one-time-build.
//   - Submits PATCH /api/tickets/:id/effort-bucket.
//   - Undoable via useUndoableMutation (A25).
//   - A closed/complete ticket without a bucket is blocked by the service layer
//     and DB CHECK — this control is the capture point.
//   - Capture only; no rollup or visualization (Phase 3).
//
// plan §Slice 7 / spec A7

import React, { useState, useRef, useEffect } from "react";
import { useUndoableMutation } from "../lib/use-undoable-mutation.js";
import { apiClient } from "../lib/api-client.js";
import Ic from "../shell/Ic";
import type { EffortBucket } from "../lib/types";

const BUCKET_LABELS: Record<NonNullable<EffortBucket>, string> = {
  "client-specific": "Client-specific",
  "platform-shared": "Platform-shared",
  "one-time-build": "One-time build",
};

const BUCKET_ORDER: NonNullable<EffortBucket>[] = [
  "client-specific",
  "platform-shared",
  "one-time-build",
];

interface EffortBucketControlProps {
  ticketId: string;
  currentBucket: EffortBucket;
  onChanged?: (bucket: EffortBucket) => void;
}

export function EffortBucketControl({
  ticketId,
  currentBucket,
  onChanged,
}: EffortBucketControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const setBucketMutation = useUndoableMutation({
    mutationFn: (bucket: NonNullable<EffortBucket>) =>
      apiClient.patch<{ ok: boolean; undoToken: string; newBucket: EffortBucket }>(
        `/api/tickets/${ticketId}/effort-bucket`,
        { effortBucket: bucket }
      ),
    toastLabel: "Effort bucket set",
    invalidateKeys: [["ticket", ticketId]],
    onSuccess: (_data, vars) => {
      onChanged?.(vars as NonNullable<EffortBucket>);
      setOpen(false);
    },
  });

  const currentLabel = currentBucket
    ? BUCKET_LABELS[currentBucket]
    : "Set effort bucket";

  return (
    <span
      ref={ref}
      style={{ position: "relative", display: "inline-block" }}
    >
      <span
        className={`tag ${currentBucket ? "effort-set" : "effort-unset"}`}
        style={{
          cursor: "pointer",
          padding: "2px 7px",
          fontSize: 11,
          borderRadius: 4,
          background: currentBucket
            ? "var(--accent-muted, rgba(99,102,241,0.15))"
            : "var(--surface-2, #1e1e2e)",
          border: `1px solid ${currentBucket ? "var(--accent, #6366f1)" : "var(--border)"}`,
          color: currentBucket ? "var(--accent, #6366f1)" : "var(--text-3)",
          userSelect: "none",
        }}
        onClick={() => setOpen((v) => !v)}
        title={currentBucket ? `Effort: ${currentLabel}` : "Set effort bucket (required to close)"}
      >
        {currentLabel}
        <Ic.chev />
      </span>

      {open && (
        <span
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            background: "var(--surface-2, #1e1e2e)",
            border: "1px solid var(--border, #2a2a3a)",
            borderRadius: 6,
            zIndex: 200,
            padding: "4px 0",
            minWidth: 170,
            display: "block",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {BUCKET_ORDER.map((bucket) => (
            <span
              key={bucket}
              style={{
                display: "block",
                padding: "6px 14px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: bucket === currentBucket ? 600 : 400,
                color:
                  bucket === currentBucket
                    ? "var(--accent, #6366f1)"
                    : "inherit",
              }}
              onClick={() => {
                if (bucket !== currentBucket) {
                  setBucketMutation.mutate(bucket);
                } else {
                  setOpen(false);
                }
              }}
            >
              {BUCKET_LABELS[bucket]}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
