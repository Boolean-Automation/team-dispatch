// dispatch — useCompanion: the Companion connection hook (Phase 2 / Slice 3).
//
// CRITICAL — the degradation seam (ADR-001): this hook depends on a
// `TerminalTransport` INTERFACE, never on a `WebSocket` or the concrete
// `CompanionWsTransport` class directly. It accepts the `FallbackTransportStub`
// UNCHANGED. All failure states route THROUGH the transport seam.
//
// Phase 2 multi-PTY upgrade:
//   - The hook opens ONE PTY per ticket on connect, stores the pty_id as
//     `activePtyId`, and exposes per-PTY helpers (`send`, `resize`, `close`).
//   - On Companion restart (epoch change), the existing pty_id is treated as
//     dead and a fresh `pty.open` is issued (Phase 2 no-resume binding).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalTransport,
  TransportStatus,
} from "./terminal-transport.js";
import type { ClientFrame, ServerFrame } from "./companion-protocol.js";
import {
  CompanionWsTransport,
  type CompanionSessionMeta,
} from "./companion-ws-transport.js";
import { scrollbackStore } from "../terminal/scrollback-store.js";

/**
 * Codex post-qa P2 fix — muted marker written into the rekeyed scrollback
 * AFTER the old chunks are copied forward to the new pty_id. When `Terminal`
 * mounts against the new pty_id and `getRecent` returns the chunk stream,
 * this line is the last thing in the buffer, so the SE sees:
 *   ...prior shell output...
 *   [Previous shell ended when Companion restarted; new shell started.]
 *   $ (new prompt)
 * Dim-italic SGR (`\x1b[2m`) so xterm renders it visually distinct from real
 * shell output. Resets via `\x1b[0m` before the newline.
 */
const RESTART_MARKER =
  "\x1b[2m[Previous shell ended when Companion restarted; new shell started.]\x1b[0m\r\n";

export interface UseCompanionOptions {
  /** The ticket the session is for. */
  ticketId: string;
  /** The dispatch web app origin (audience binding). */
  origin?: string;
  /** Ticket metadata for the context-injection preamble. */
  meta?: CompanionSessionMeta;
  /** Inject a transport (default: real `CompanionWsTransport`). */
  transport?: TerminalTransport;
  /** When false, the hook stays idle and opens no transport. */
  enabled?: boolean;
}

export interface UseCompanionResult {
  /** The current connection status (state + sessionId + detail + caps). */
  status: TransportStatus;
  /** The current active PTY id for this ticket — null before pty.opened. */
  activePtyId: string | null;
  /** The transport. Exposed so consumers can wire `Terminal` directly. */
  transport: TerminalTransport;
  /** Send a typed client frame. */
  send: (frame: ClientFrame) => void;
  /** Resize the PTY (by pty_id). */
  resize: (cols: number, rows: number) => void;
  /** Subscribe to any inbound server frame. */
  onFrame: (cb: (frame: ServerFrame) => void) => () => void;
  /** Re-run discovery + connect (Retry button). */
  retry: () => void;
}

export function useCompanion(opts: UseCompanionOptions): UseCompanionResult {
  const { ticketId, enabled = true } = opts;
  const origin = opts.origin ?? window.location.origin;
  const metaStatus = opts.meta?.status;
  const metaClientSlug = opts.meta?.clientSlug;
  const metaTitle = opts.meta?.title;

  const [status, setStatus] = useState<TransportStatus>({ state: "idle" });
  const [activePtyId, setActivePtyId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const frameSubscribers = useRef(new Set<(frame: ServerFrame) => void>());
  const transportRef = useRef<TerminalTransport | null>(null);

  // Codex post-qa P2 fix — track the most-recently-active pty_id for this
  // (hook instance, ticket). Captured AFTER each successful pty.open so the
  // NEXT epoch flip can rekey scrollback forward from old → new. Initialized
  // null so the first epoch (lastEpoch === undefined path) is a no-op rekey
  // (there is no old pty to copy from).
  const prevActivePtyIdRef = useRef<string | null>(null);

  const injectedTransport = opts.transport;

  // Build (or reuse) a transport whose lifetime is tied to (ticket, retry).
  const transport = useMemo<TerminalTransport>(() => {
    return (
      injectedTransport ??
      new CompanionWsTransport({
        ticketId,
        origin,
        meta: {
          status: metaStatus,
          clientSlug: metaClientSlug,
          title: metaTitle,
        },
      })
    );
    // retryNonce is intentionally a dep — bumping it rebuilds the transport.
  }, [
    enabled,
    ticketId,
    origin,
    metaStatus,
    metaClientSlug,
    metaTitle,
    injectedTransport,
    retryNonce,
  ]);

  useEffect(() => {
    if (!enabled) {
      setStatus({ state: "idle" });
      return;
    }
    transportRef.current = transport;

    let cancelled = false;
    let lastEpoch: number | undefined;

    // Codex post-qa P2 fix — Companion-restart rekey-forward state.
    //
    // When the epoch flips, `pendingRekey` captures the dead pty_id from the
    // prior epoch. The very next `pty.opened` frame is intercepted in onFrame:
    // we rekey scrollback forward (old → new), append the muted marker, and
    // ONLY THEN forward the frame to subscribers (`useActivePty`). That
    // ordering guarantees `useActivePty.activePtyId` doesn't flip — and the
    // Terminal doesn't re-mount + call `getRecent` — until the rekeyed bytes
    // are committed to IDB. Subscribers see a slightly delayed but ordered
    // frame stream.
    let pendingRekey: { oldPtyId: string } | null = null;

    transport.connect({
      onStatus: (s) => {
        if (cancelled) return;
        setStatus(s);
        // On first `connected`, open a PTY. On Companion-restart (epoch change),
        // re-open: Phase 2 no-resume binding.
        if (s.state === "connected") {
          const epoch = s.companionStartedAt;
          if (epoch !== undefined && epoch !== lastEpoch) {
            const isFirstEpoch = lastEpoch === undefined;
            // First epoch is a fresh connection, not a restart — no prior pty
            // to copy scrollback from. Only set pendingRekey when we actually
            // saw a previous epoch AND we have a captured prev pty_id.
            const prevForRekey =
              isFirstEpoch ? null : prevActivePtyIdRef.current;
            pendingRekey =
              prevForRekey !== null ? { oldPtyId: prevForRekey } : null;
            lastEpoch = epoch;
            setActivePtyId(null);
            transport
              .openPty(ticketId)
              .then((pid) => {
                if (cancelled) return;
                // Capture the freshly-minted pid for the NEXT epoch flip.
                prevActivePtyIdRef.current = pid;
                // The rekey-then-forward happens in onFrame (synchronously
                // when the pty.opened frame arrives). By the time this .then
                // resolves, the rekey is done — see onFrame below.
                setActivePtyId(pid);
              })
              .catch(() => {
                /* surfaced via onStatus */
              });
          }
        }
      },
      onFrame: (frame) => {
        // Intercept the first `pty.opened` for this ticket AFTER an epoch
        // flip: rekey scrollback forward, append the muted marker, THEN
        // forward the frame to subscribers so useActivePty's activePtyId
        // flips only when the Terminal can safely read the rekeyed buffer.
        if (pendingRekey !== null && frame.t === "pty.opened") {
          const oldPtyId = pendingRekey.oldPtyId;
          const newPtyId = frame.pty_id;
          pendingRekey = null;
          // Fire-and-await: subscribers see the frame only after the IDB
          // writes commit. IDB failure is non-fatal — the live shell still
          // works without rekeyed scrollback.
          void (async () => {
            if (oldPtyId !== newPtyId) {
              try {
                await scrollbackStore.rekeyForward(
                  ticketId,
                  oldPtyId,
                  newPtyId
                );
                await scrollbackStore.append(
                  ticketId,
                  newPtyId,
                  new TextEncoder().encode(RESTART_MARKER)
                );
              } catch {
                /* IDB failure — proceed without rekey */
              }
            }
            if (cancelled) return;
            for (const cb of frameSubscribers.current) cb(frame);
          })();
          return;
        }
        for (const cb of frameSubscribers.current) cb(frame);
      },
    });

    return () => {
      cancelled = true;
      // Close the PTY explicitly on unmount so the Companion sweeps it.
      if (activePtyId) {
        try {
          transport.closePty(activePtyId);
        } catch {
          /* already torn down */
        }
      }
      transport.close();
      transportRef.current = null;
    };
    // activePtyId only references the latest by closure; we don't want it as
    // a dep here (we'd tear down on every pty.opened).
  }, [transport, enabled, ticketId]);

  const send = useCallback((frame: ClientFrame) => {
    transportRef.current?.send(frame);
  }, []);

  const resize = useCallback(
    (cols: number, rows: number) => {
      if (!activePtyId) return;
      transportRef.current?.resize(activePtyId, cols, rows);
    },
    [activePtyId]
  );

  const onFrame = useCallback((cb: (frame: ServerFrame) => void) => {
    frameSubscribers.current.add(cb);
    return () => {
      frameSubscribers.current.delete(cb);
    };
  }, []);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return useMemo(
    () => ({
      status,
      activePtyId,
      transport,
      send,
      resize,
      onFrame,
      retry,
    }),
    [status, activePtyId, transport, send, resize, onFrame, retry]
  );
}
