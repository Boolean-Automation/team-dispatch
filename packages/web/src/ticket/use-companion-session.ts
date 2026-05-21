// dispatch — useCompanion: the Companion connection hook.
//
// CRITICAL — the degradation seam (ADR-001, plan risk #6): this hook depends
// on a `TerminalTransport` INTERFACE, never on a `WebSocket` or the
// `companion-ws-transport` concrete class directly. It is constructed with the
// real `CompanionWsTransport` by default, and the spike proves it accepts the
// `FallbackTransportStub` UNCHANGED. All failure states route THROUGH the
// transport seam — none into a dead end.
//
// On no-Companion, or a failed/malformed handshake (the port-squat case), the
// hook resolves cleanly to `not-detected` — it does NOT hang or throw
// (ACs A14, A12c).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalTransport,
  TransportStatus,
} from "./terminal-transport.js";
import type { ClientFrame, ServerFrame } from "./companion-protocol.js";
import { CompanionWsTransport } from "./companion-ws-transport.js";

export interface UseCompanionOptions {
  /** The ticket the session is for. */
  ticketId: string;
  /** The dispatch web app origin (audience binding). */
  origin?: string;
  /**
   * The transport to use. Defaults to the real `CompanionWsTransport`.
   * The spike substitutes `FallbackTransportStub` here to prove the seam —
   * the hook and `PanelTerminal` accept it with no change.
   */
  transport?: TerminalTransport;
  /** When false, the hook stays idle and opens no transport. */
  enabled?: boolean;
}

export interface UseCompanionResult {
  /** The current connection status (state + sessionId + detail). */
  status: TransportStatus;
  /** Send a client frame (keystrokes) toward the session. */
  send: (frame: ClientFrame) => void;
  /** Resize the PTY. */
  resize: (cols: number, rows: number) => void;
  /** Subscribe to inbound server frames (xterm.js writes from these). */
  onFrame: (cb: (frame: ServerFrame) => void) => () => void;
  /** Re-run discovery + connect — the Retry button (A14). */
  retry: () => void;
}

export function useCompanion(opts: UseCompanionOptions): UseCompanionResult {
  const { ticketId, enabled = true } = opts;
  const origin = opts.origin ?? window.location.origin;

  const [status, setStatus] = useState<TransportStatus>({ state: "idle" });
  const [retryNonce, setRetryNonce] = useState(0);

  // Frame subscribers — xterm.js subscribes here to write PTY output.
  const frameSubscribers = useRef(new Set<(frame: ServerFrame) => void>());
  const transportRef = useRef<TerminalTransport | null>(null);

  // A caller-supplied transport is a stable reference for the spike's seam
  // proof; the default real transport is rebuilt per (ticket, retry).
  const injectedTransport = opts.transport;

  useEffect(() => {
    if (!enabled) {
      setStatus({ state: "idle" });
      return;
    }

    const transport: TerminalTransport =
      injectedTransport ?? new CompanionWsTransport({ ticketId, origin });
    transportRef.current = transport;

    transport.connect({
      onStatus: (s) => setStatus(s),
      onFrame: (frame) => {
        for (const cb of frameSubscribers.current) cb(frame);
      },
    });

    return () => {
      transport.close();
      transportRef.current = null;
    };
    // retryNonce is intentionally a dep — bumping it rebuilds the transport.
  }, [enabled, ticketId, origin, injectedTransport, retryNonce]);

  const send = useCallback((frame: ClientFrame) => {
    transportRef.current?.send(frame);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    transportRef.current?.resize(cols, rows);
  }, []);

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
    () => ({ status, send, resize, onFrame, retry }),
    [status, send, resize, onFrame, retry]
  );
}
