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

    transport.connect({
      onStatus: (s) => {
        if (cancelled) return;
        setStatus(s);
        // On first `connected`, open a PTY. On Companion-restart (epoch change),
        // re-open: Phase 2 no-resume binding.
        if (s.state === "connected") {
          const epoch = s.companionStartedAt;
          if (epoch !== undefined && epoch !== lastEpoch) {
            lastEpoch = epoch;
            setActivePtyId(null);
            transport
              .openPty(ticketId)
              .then((pid) => {
                if (!cancelled) setActivePtyId(pid);
              })
              .catch(() => {
                /* surfaced via onStatus */
              });
          }
        }
      },
      onFrame: (frame) => {
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
