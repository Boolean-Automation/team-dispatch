// dispatch — Companion WebSocket frame protocol (web-side re-declaration).
//
// These types MIRROR `packages/companion/src/protocol.ts`. They are
// DELIBERATELY re-declared here rather than imported: the lint boundary
// forbids `packages/web` importing `@dispatch/companion`. A copied ~30-line
// type file is the correct seam — the web app talks to the Companion only
// over the WebSocket, never via a cross-package import.
//
// If the Companion protocol changes, bump PROTOCOL_VERSION on both sides; a
// version the other side does not speak resolves to the `protocol-mismatch`
// connection state (it does not silently half-work).

/** Protocol version. Must match the Companion's PROTOCOL_VERSION. */
export const PROTOCOL_VERSION = 1;

/** Max bytes for a single outbound WebSocket frame. */
export const MAX_FRAME_BYTES = 256 * 1024;

/** Max bytes for a single `data` frame payload (paste cap). */
export const MAX_PASTE_BYTES = 64 * 1024;

// ── Client → server frames (browser → Companion) ─────────────────────────────

export interface DataFrame {
  t: "data";
  d: string;
}

export interface ResizeFrame {
  t: "resize";
  cols: number;
  rows: number;
}

export type ClientFrame = DataFrame | ResizeFrame;

// ── Server → client frames (Companion → browser) ─────────────────────────────

export interface SessionMetaFrame {
  t: "session-meta";
  sessionId: string;
  cmd: string;
  protocolVersion: number;
  companionVersion: string;
}

export interface ErrorFrame {
  t: "error";
  code: string;
  msg: string;
}

export interface ExitFrame {
  t: "exit";
  exitCode: number;
  signal: number | null;
}

export type ServerFrame = SessionMetaFrame | DataFrame | ErrorFrame | ExitFrame;

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
    frame.t === "data" ||
    frame.t === "session-meta" ||
    frame.t === "error" ||
    frame.t === "exit"
  ) {
    return parsed as ServerFrame;
  }
  return null;
}

/** Whether a Companion's advertised protocolVersion is one this web app speaks. */
export function isProtocolCompatible(companionProtocolVersion: number): boolean {
  return companionProtocolVersion === PROTOCOL_VERSION;
}
