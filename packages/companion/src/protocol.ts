/**
 * dispatch Companion — WebSocket frame protocol (headless-core contract).
 *
 * This module is the single written-down definition of the Companion ↔ browser
 * channel. The web package re-declares these types locally in
 * `packages/web/src/ticket/companion-protocol.ts` (it must NOT import this
 * package — the lint boundary forbids a web→companion import). Any future
 * Companion MCP inherits this contract verbatim.
 *
 * All frames are JSON text frames. The frame `t` discriminator is the type tag.
 *
 *   client → server (browser → Companion):
 *     { "t": "data",   "d": "<utf8 keystrokes>" }
 *     { "t": "resize", "cols": <int>, "rows": <int> }
 *
 *   server → client (Companion → browser):
 *     { "t": "session-meta", "sessionId": "<8hex>", "cmd": "<argv>",
 *       "protocolVersion": <int>, "companionVersion": "<semver>" }
 *     { "t": "data",  "d": "<utf8 pty output>" }
 *     { "t": "error", "code": "<string>", "msg": "<string>" }
 *     { "t": "exit",  "exitCode": <int>, "signal": <int|null> }
 *
 * Bounds (Codex P2 — protocol versioning + bounds):
 *   - PROTOCOL_VERSION — bumped on any breaking frame change. The
 *     `session-meta` frame carries it; a web client that does not speak the
 *     advertised version resolves to the explicit `protocol-mismatch` state.
 *   - MAX_FRAME_BYTES — a single inbound WS frame larger than this is rejected
 *     (not piped into the PTY).
 *   - MAX_PASTE_BYTES — a single `data` frame's payload larger than this is a
 *     paste-cap violation; rejected, not streamed unbounded into the PTY.
 */

import { z } from "zod";

/** Protocol version. Bump on any breaking frame-shape change. */
export const PROTOCOL_VERSION = 1;

/** Companion package version, surfaced in the session-meta handshake frame. */
export const COMPANION_VERSION = "0.0.0";

/** Max bytes for a single inbound WebSocket frame. Larger frames are rejected. */
export const MAX_FRAME_BYTES = 256 * 1024; // 256 KiB

/** Max bytes for a single `data` frame payload (paste cap). */
export const MAX_PASTE_BYTES = 64 * 1024; // 64 KiB

// ── Client → server frames ──────────────────────────────────────────────────

export const DataFrameSchema = z.object({
  t: z.literal("data"),
  d: z.string(),
});

export const ResizeFrameSchema = z.object({
  t: z.literal("resize"),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** Any frame the browser may send to the Companion. */
export const ClientFrameSchema = z.discriminatedUnion("t", [
  DataFrameSchema,
  ResizeFrameSchema,
]);

// ── Server → client frames ──────────────────────────────────────────────────

export const SessionMetaFrameSchema = z.object({
  t: z.literal("session-meta"),
  sessionId: z.string(),
  cmd: z.string(),
  protocolVersion: z.number().int(),
  companionVersion: z.string(),
});

export const ErrorFrameSchema = z.object({
  t: z.literal("error"),
  code: z.string(),
  msg: z.string(),
});

export const ExitFrameSchema = z.object({
  t: z.literal("exit"),
  exitCode: z.number().int(),
  signal: z.number().int().nullable(),
});

/** Any frame the Companion may send to the browser. */
export const ServerFrameSchema = z.discriminatedUnion("t", [
  SessionMetaFrameSchema,
  DataFrameSchema,
  ErrorFrameSchema,
  ExitFrameSchema,
]);

// ── Inferred types ──────────────────────────────────────────────────────────

export type DataFrame = z.infer<typeof DataFrameSchema>;
export type ResizeFrame = z.infer<typeof ResizeFrameSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type SessionMetaFrame = z.infer<typeof SessionMetaFrameSchema>;
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;
export type ExitFrame = z.infer<typeof ExitFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// ── Parse helpers ────────────────────────────────────────────────────────────

export type ParseClientFrameResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: "bad-frame" | "frame-too-large" | "paste-too-large"; msg: string };

/**
 * Parse one raw inbound WS message into a validated ClientFrame.
 * Enforces MAX_FRAME_BYTES and the MAX_PASTE_BYTES paste cap before the frame
 * ever reaches the PTY. A negative result carries a structured error code so
 * the bridge can reply with a matching `error` frame.
 */
export function parseClientFrame(raw: string): ParseClientFrameResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
    return { ok: false, code: "frame-too-large", msg: "inbound frame exceeds MAX_FRAME_BYTES" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "bad-frame", msg: "frame is not valid JSON" };
  }

  const result = ClientFrameSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, code: "bad-frame", msg: "frame failed schema validation" };
  }

  const frame = result.data;
  if (frame.t === "data" && Buffer.byteLength(frame.d, "utf8") > MAX_PASTE_BYTES) {
    return { ok: false, code: "paste-too-large", msg: "data frame exceeds MAX_PASTE_BYTES" };
  }

  return { ok: true, frame };
}

/**
 * Decide whether a web client advertising `clientProtocolVersion` can speak to
 * this Companion. A mismatch routes the web side into the `protocol-mismatch`
 * failure state — it does not silently half-work (Codex P2 / A18 state f).
 */
export function isProtocolCompatible(clientProtocolVersion: number): boolean {
  return clientProtocolVersion === PROTOCOL_VERSION;
}
