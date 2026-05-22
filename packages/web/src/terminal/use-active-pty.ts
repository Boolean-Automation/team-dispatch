// dispatch — useActivePty hook (Phase 2 / Slice 6).
//
// Spec §3.7 binding: the Companion's data layer is fully multi-PTY (S1
// contract); the UI in v1 renders exactly one terminal. This hook holds the
// list of live PTYs for a given ticket AND the "most recent active PTY"
// pointer. Newest pty.opened wins. If the active PTY exits, the pointer falls
// back to the next-most-recently-active PTY (or null if none).
//
// v1: the panel reads `activePtyId` and renders one `<Terminal>`.
// v1.5: the panel will read the full `ptyList` and render n `<Terminal>` —
// the pointer state already supports the flip. No re-architecture.
//
// Cap handling: when the Companion emits `pty.error { code: 'cap-exceeded' }`
// (S1 contract — 3 PTYs per ticket), the hook fires a user-facing info toast
// via the existing UndoToast surface. No state change — the cap-exceeded
// open never minted a pty_id.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TerminalTransport } from "../ticket/terminal-transport.js";
import type { ServerFrame } from "../ticket/companion-protocol.js";
import { fireInfoToast } from "../lib/use-undoable-mutation.js";

/** Registration function for inbound server frames. Returns unsubscribe. */
export type FrameSubscriber = (
  cb: (frame: ServerFrame) => void
) => () => void;

/** What the hook exposes. */
export interface UseActivePtyResult {
  /** The currently-rendered PTY id, or null when none is active. */
  activePtyId: string | null;
  /**
   * All live PTYs for this ticket. In v1 this is informational (the UI
   * renders only the active one); v1.5 will iterate to render per-PTY pills.
   */
  ptyList: readonly string[];
  /** Send a `pty.open` frame for this hook's ticket. */
  openPty: () => void;
  /** Send a `pty.close` frame for the given pty_id. */
  closePty: (pty_id: string) => void;
}

/** Message rendered by the info toast on cap-exceeded. */
export const CAP_EXCEEDED_MESSAGE =
  "You've hit the 3-PTY cap for this ticket. Close one to open a new one.";

/**
 * Maintain the per-ticket "most recent active PTY" pointer.
 *
 * @param ticketId — the ticket this hook is scoped to. Used as the
 *   `ticket_id` field on `pty.open` frames sent via `openPty()`.
 * @param transport — the multi-PTY transport for this ticket. Used to send
 *   client frames (`pty.open` / `pty.close`).
 * @param subscribeFrames — registration helper for inbound server frames.
 *   The TerminalTransport.connect() interface is single-handler, so the
 *   panel-level fan-out (useCompanion's `onFrame`) is the right seam.
 *   Returns an unsubscribe function.
 */
export function useActivePty(
  ticketId: string,
  transport: TerminalTransport,
  subscribeFrames: FrameSubscriber
): UseActivePtyResult {
  // State: the list of live pty_ids and the recency-ordered stack.
  // recencyOrder[recencyOrder.length - 1] is the most-recently-active PTY.
  // When the active PTY exits, we pop it; the new tail becomes the active
  // pointer. When a new pty.opened arrives we push to the back.
  const [ptyList, setPtyList] = useState<readonly string[]>([]);
  const [recencyOrder, setRecencyOrder] = useState<readonly string[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeFrames((frame: ServerFrame) => {
      if (frame.t === "pty.opened") {
        const pid = frame.pty_id;
        setPtyList((prev) =>
          prev.includes(pid) ? prev : [...prev, pid]
        );
        setRecencyOrder((prev) => {
          const without = prev.filter((id) => id !== pid);
          return [...without, pid];
        });
      } else if (frame.t === "pty.exit") {
        const pid = frame.pty_id;
        setPtyList((prev) => prev.filter((id) => id !== pid));
        setRecencyOrder((prev) => prev.filter((id) => id !== pid));
      } else if (frame.t === "pty.error" && frame.code === "cap-exceeded") {
        fireInfoToast(CAP_EXCEEDED_MESSAGE);
      }
    });
    return unsubscribe;
  }, [subscribeFrames]);

  const openPty = useCallback(() => {
    transport.send({ t: "pty.open", ticket_id: ticketId });
  }, [transport, ticketId]);

  const closePty = useCallback(
    (pty_id: string) => {
      transport.send({ t: "pty.close", pty_id });
    },
    [transport]
  );

  // The active pointer is the back of the recency stack (or null).
  const activePtyId = useMemo(() => {
    if (recencyOrder.length === 0) return null;
    return recencyOrder[recencyOrder.length - 1] ?? null;
  }, [recencyOrder]);

  return useMemo(
    () => ({ activePtyId, ptyList, openPty, closePty }),
    [activePtyId, ptyList, openPty, closePty]
  );
}
