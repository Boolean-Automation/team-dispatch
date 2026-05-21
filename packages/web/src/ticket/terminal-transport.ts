// dispatch — TerminalTransport: the degradation seam (ADR-001 — binding).
//
// ADR-001's load-bearing invariant: the embedded terminal "must never
// hard-fail — must degrade to the server-side fallback." This interface IS
// that seam. `PanelTerminal` and `useCompanion` depend on `TerminalTransport`,
// NOT on the Companion WebSocket directly.
//
// Two implementations exist:
//   - `companion-ws-transport.ts`   — the real Companion WebSocket transport.
//   - `fallback-transport.stub.ts`  — a trivial no-op stub. The spike proves
//                                     `PanelTerminal` accepts this stub WITHOUT
//                                     modification — that is the whole proof:
//                                     Phase 2 can swap in a real server-side
//                                     fallback transport by replacing one file,
//                                     touching nothing in `PanelTerminal`.
//
// This is the SEAM only. No fallback engine, no Agent SDK, no Console org.

import type { ClientFrame, ServerFrame } from "./companion-protocol.js";

/** The full set of connection states the transport can report. */
export type ConnectionState =
  // Baseline lifecycle.
  | "idle"
  | "connecting"
  | "connected"
  // Failure taxonomy (spec A18 states a–h).
  | "not-detected" // (a)/(b) — no Companion / Companion offline
  | "claude-unusable" // (c) — Companion up, `claude` not installed / not logged in
  | "degraded" // the seam reached a defined fallback state (the stub resolves here)
  | "quota-limited" // (d) — `claude` rate-limited / quota hit
  | "version-mismatch" // (e) — Companion version the web app cannot speak to
  | "protocol-mismatch" // (f) — WS handshake protocolVersion mismatch
  | "mint-unavailable" // (g) — POST /api/companion/sessions is down
  | "local-permission-denied"; // (h) — token valid, PTY spawn refused

/** A snapshot of what the transport currently knows. */
export interface TransportStatus {
  state: ConnectionState;
  /** Live Companion session id once connected (8-hex, "5a82"-style). */
  sessionId?: string;
  /** A human-readable detail for the failure states. */
  detail?: string;
}

/** Callbacks the transport pushes into. */
export interface TransportHandlers {
  /** A server frame arrived (data / session-meta / error / exit). */
  onFrame: (frame: ServerFrame) => void;
  /** The connection status changed. */
  onStatus: (status: TransportStatus) => void;
}

/**
 * The stable seam `PanelTerminal` / `useCompanion` depend on. Any transport —
 * the real Companion WebSocket, or a future server-side fallback — implements
 * exactly this. The component never sees a `WebSocket` or a `ws://` URL.
 */
export interface TerminalTransport {
  /** Begin connecting. Wires the handlers; never throws — failures land in onStatus. */
  connect(handlers: TransportHandlers): void;
  /** Send a client frame (keystrokes / resize) toward the session. */
  send(frame: ClientFrame): void;
  /** Convenience: send a resize frame. */
  resize(cols: number, rows: number): void;
  /** Tear the transport down. Idempotent. */
  close(): void;
}
