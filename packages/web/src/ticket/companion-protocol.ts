// dispatch — Companion WebSocket frame protocol (web-side re-declaration).
//
// Phase 2 — multi-PTY contract. These types MIRROR
// `packages/companion/src/protocol.ts`. They are DELIBERATELY re-declared
// here rather than imported: the lint boundary forbids `packages/web`
// importing `@dispatch/companion`. A copied ~50-line type file is the correct
// seam — the web app talks to the Companion only over the WebSocket, never
// via a cross-package import.
//
// If the Companion protocol changes, bump PROTOCOL_VERSION on both sides; a
// version the other side does not speak resolves to the `protocol-mismatch`
// connection state (it does not silently half-work).

/** Protocol version. Must match the Companion's PROTOCOL_VERSION. */
export const PROTOCOL_VERSION = 2;

/** Max bytes for a single outbound WebSocket frame. */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Max bytes for a single pty.write payload (paste cap). */
export const MAX_PASTE_BYTES = 64 * 1024;

// ── Client → server frames (browser → Companion) ─────────────────────────────

export interface PtyOpenFrame {
  t: "pty.open";
  ticket_id: string;
  /**
   * P1-2 fix (gate-review.md): client-minted correlation id. The Companion
   * echoes this on the matching `pty.opened` or `pty.error` so the client
   * routes the response to the exact pending-open it correlates with. Without
   * this, three parallel opens + one error in the middle would either hang
   * forever or reject the wrong promise.
   */
  request_id?: string;
}

export interface PtyWriteFrame {
  t: "pty.write";
  pty_id: string;
  data: string;
}

export interface PtyResizeFrame {
  t: "pty.resize";
  pty_id: string;
  cols: number;
  rows: number;
}

export interface PtyCloseFrame {
  t: "pty.close";
  pty_id: string;
}

export type ClientFrame =
  | PtyOpenFrame
  | PtyWriteFrame
  | PtyResizeFrame
  | PtyCloseFrame;

// ── Server → client frames (Companion → browser) ─────────────────────────────

export interface HelloFrame {
  t: "hello";
  protocolVersion: number;
  companionVersion: string;
  capabilities: string[];
  /** epoch_ms — restart of the Companion changes this; cached pty_ids dead. */
  companion_started_at: number;
}

export interface PtyOpenedFrame {
  t: "pty.opened";
  pty_id: string;
  /** P1-2: echo of the client's request_id (null when none was supplied). */
  request_id?: string | null;
}

export interface PtyDataFrame {
  t: "pty.data";
  pty_id: string;
  /** UTF-8 string — raw PTY stdout/stderr bytes encoded as text. */
  bytes: string;
}

export interface PtyExitFrame {
  t: "pty.exit";
  pty_id: string;
  code: number;
  signal: string | null;
}

/** Closed set of pty.error codes the Companion may emit. */
export type PtyErrorCode =
  | "cap-exceeded"
  | "spawn-failed"
  | "not-authed"
  | "pty-detached"
  | "unknown-pty"
  | "bad-frame"
  | "frame-too-large"
  | "paste-too-large";

export interface PtyErrorFrame {
  t: "pty.error";
  code: PtyErrorCode;
  pty_id?: string;
  detail?: string;
  /**
   * P1-2: when present, this error is the failure-response to a specific
   * client `pty.open`. The client routes it to the matching pending-open and
   * rejects only that promise. When `null`/absent, the error is a "broadcast"
   * (bad-frame, frame-too-large, unknown-pty for a non-open frame) and the
   * client surfaces it via a global toast rather than rejecting any pending.
   */
  request_id?: string | null;
}

export type ServerFrame =
  | HelloFrame
  | PtyOpenedFrame
  | PtyDataFrame
  | PtyExitFrame
  | PtyErrorFrame;

// ── Parse helper ─────────────────────────────────────────────────────────────

/** Parse a raw inbound WS message string into a typed ServerFrame, or null. */
export function parseServerFrame(raw: string): ServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as { t?: unknown };
  if (
    frame.t === "hello" ||
    frame.t === "pty.opened" ||
    frame.t === "pty.data" ||
    frame.t === "pty.exit" ||
    frame.t === "pty.error"
  ) {
    return parsed as ServerFrame;
  }
  return null;
}

/** Whether a Companion's advertised protocolVersion is one this web app speaks. */
export function isProtocolCompatible(companionProtocolVersion: number): boolean {
  return companionProtocolVersion === PROTOCOL_VERSION;
}

/**
 * Intersect a server's capability advertisements with what this web client
 * speaks. The intersection drives feature activation (e.g. Unicode11Addon
 * loads only when both sides advertise `unicode11`).
 */
export function intersectCapabilities(
  serverCaps: readonly string[],
  clientCaps: readonly string[]
): string[] {
  const serverSet = new Set(serverCaps);
  return clientCaps.filter((c) => serverSet.has(c));
}

/** The capabilities this web client advertises. */
export const CLIENT_CAPABILITIES = [
  "unicode11",
  "weblinks",
  "search",
  "serialize",
  "ligatures",
];
