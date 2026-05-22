// dispatch — TerminalTransport: Phase 2 multi-PTY seam.
//
// The degradation seam (ADR-001) is preserved: failures route THROUGH the
// transport into defined connection states; the Terminal component depends
// only on this interface, never on the WebSocket directly.
//
// Phase 2 upgrade: the transport is now multi-PTY. The web side keeps ONE
// WebSocket per browser window (singleton hoisted via popout-bridge) and
// each PTY is identified by a server-minted ULID `pty_id`. The transport
// exposes:
//   - `subscribe(pty_id, listener)` — for Terminal component to listen to
//     per-PTY frames (pty.data / pty.exit).
//   - `send(frame)` — emit a typed ClientFrame (pty.open/write/resize/close).
//   - `openPty(ticketId)` — promise-based helper that emits pty.open and
//     resolves with the pty_id once pty.opened arrives.
//   - The existing status surface (`onStatus`, `connect`, `close`, `retry`).
//
// The Phase 1 single-PTY callers are upgraded in lock-step.

import type { ClientFrame, ServerFrame } from "./companion-protocol.js";
import type { TerminalFrame } from "../terminal/transport-contract.js";

/** The full set of connection states the transport can report. */
export type ConnectionState =
  // Baseline lifecycle.
  | "idle"
  | "connecting"
  | "connected"
  // Failure taxonomy (visual spec §7).
  | "not-detected" // Companion not running / unreachable
  | "shell-unavailable" // Companion online but couldn't spawn the login shell
  | "claude-unusable" // (legacy) — kept for backwards-compat with old branches
  | "degraded" // the seam reached a defined fallback state
  | "quota-limited"
  | "version-mismatch"
  | "protocol-mismatch"
  | "mint-unavailable"
  | "local-permission-denied";

/** A snapshot of what the transport currently knows. */
export interface TransportStatus {
  state: ConnectionState;
  /** Live Companion session id once connected. */
  sessionId?: string;
  /** A human-readable detail for the failure states. */
  detail?: string;
  /** The intersected capability set after handshake (empty before). */
  capabilities?: string[];
  /** epoch_ms when the Companion booted — used to detect restart. */
  companionStartedAt?: number;
}

/** A per-PTY frame the Terminal component subscribes to. */
export type PtyFrame = TerminalFrame;

/** Callbacks the transport pushes into. */
export interface TransportHandlers {
  /** A server frame arrived (typed Phase 2 frame). */
  onFrame: (frame: ServerFrame) => void;
  /** The connection status changed. */
  onStatus: (status: TransportStatus) => void;
}

/**
 * The stable seam the panel + popout depend on. The real
 * `CompanionWsTransport` and any future server-side fallback both implement
 * exactly this. The component never sees a `WebSocket` or a `ws://` URL.
 */
export interface TerminalTransport {
  /** Begin connecting. Wires the handlers; never throws — failures land in onStatus. */
  connect(handlers: TransportHandlers): void;
  /** Send a typed Phase 2 client frame. */
  send(frame: ClientFrame): void;
  /**
   * Open a new PTY for `ticketId`. Resolves with the server-minted `pty_id`
   * once `pty.opened` arrives. Rejects (or resolves the previously-opened id)
   * on transport teardown — implementations document their behavior.
   */
  openPty(ticketId: string): Promise<string>;
  /**
   * Subscribe to per-PTY frames (pty.data / pty.exit). Returns an unsubscribe.
   * Multiple subscribers for the same pty_id are supported (the popout shares
   * the opener's subscription via this hook).
   */
  subscribe(pty_id: string, listener: (frame: PtyFrame) => void): () => void;
  /** Write text to a PTY (Phase 2 shape: pty.write { pty_id, data }). */
  write(pty_id: string, data: string): void;
  /** Resize a PTY. */
  resize(pty_id: string, cols: number, rows: number): void;
  /** Close a PTY (Phase 2 shape: pty.close). */
  closePty(pty_id: string): void;
  /** Tear the transport down. Idempotent. Closes the WebSocket. */
  close(): void;
}
