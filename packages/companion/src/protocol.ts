/**
 * dispatch Companion — WebSocket frame protocol (headless-core contract).
 *
 * Phase 2 — multi-PTY contract. The Companion runs ONE WebSocket per browser
 * window (singleton). Each WS may own zero or more PTYs, identified by a
 * server-minted ULID `pty_id`. Every `pty.write` / `pty.resize` / `pty.close`
 * frame carries the `pty_id` so the bridge can authorize against the
 * connection-owned registry (Codex F2 — per-frame ownership check).
 *
 * All frames are JSON text frames. The frame `t` discriminator is the type tag.
 *
 *   client → server:
 *     { "t": "pty.open",   "ticket_id": "<string>" }
 *     { "t": "pty.write",  "pty_id": "<ulid>", "data": "<utf8>" }
 *     { "t": "pty.resize", "pty_id": "<ulid>", "cols": <int>, "rows": <int> }
 *     { "t": "pty.close",  "pty_id": "<ulid>" }
 *
 *   server → client:
 *     { "t": "hello",       "protocolVersion": <int>, "companionVersion": "<semver>",
 *                            "capabilities": [...], "companion_started_at": <epoch_ms> }
 *     { "t": "pty.opened",  "pty_id": "<ulid>" }
 *     { "t": "pty.data",    "pty_id": "<ulid>", "bytes": "<utf8>" }
 *     { "t": "pty.exit",    "pty_id": "<ulid>", "code": <int>, "signal": <string|null> }
 *     { "t": "pty.error",   "code": "<enum>", "pty_id"?: "<ulid>", "detail"?: "<string>" }
 *
 * Bounds:
 *   - PROTOCOL_VERSION — bumped on any breaking frame change. Phase 2 = 2.
 *   - MAX_FRAME_BYTES — a single inbound WS frame larger than this is rejected.
 *   - MAX_PASTE_BYTES — a single pty.write `data` payload larger than this is
 *     a paste-cap violation; rejected, not streamed unbounded into the PTY.
 */

import { z } from "zod";

/** Protocol version. Bumped to 2 for the Phase 2 multi-PTY contract. */
export const PROTOCOL_VERSION = 2;

/** Companion package version, surfaced in the hello handshake frame. */
export const COMPANION_VERSION = "0.0.0";

/** Max bytes for a single inbound WebSocket frame. Larger frames are rejected. */
export const MAX_FRAME_BYTES = 256 * 1024; // 256 KiB

/** Max bytes for a single pty.write `data` payload (paste cap). */
export const MAX_PASTE_BYTES = 64 * 1024; // 64 KiB

// ── Client → server frames ──────────────────────────────────────────────────

export const PtyOpenFrameSchema = z.object({
  t: z.literal("pty.open"),
  ticket_id: z.string().min(1),
});

export const PtyWriteFrameSchema = z.object({
  t: z.literal("pty.write"),
  pty_id: z.string().min(1),
  data: z.string(),
});

export const PtyResizeFrameSchema = z.object({
  t: z.literal("pty.resize"),
  pty_id: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const PtyCloseFrameSchema = z.object({
  t: z.literal("pty.close"),
  pty_id: z.string().min(1),
});

/** Any frame the browser may send to the Companion. */
export const ClientFrameSchema = z.discriminatedUnion("t", [
  PtyOpenFrameSchema,
  PtyWriteFrameSchema,
  PtyResizeFrameSchema,
  PtyCloseFrameSchema,
]);

// ── Server → client frames ──────────────────────────────────────────────────

/**
 * The Phase 2 handshake. `capabilities` drives feature-array negotiation;
 * `companion_started_at` is the epoch-ms at server boot — the client uses it to
 * detect a Companion restart (a new epoch invalidates all cached pty_ids).
 */
export const HelloFrameSchema = z.object({
  t: z.literal("hello"),
  protocolVersion: z.number().int(),
  companionVersion: z.string(),
  capabilities: z.array(z.string()),
  companion_started_at: z.number().int().nonnegative(),
});

export const PtyOpenedFrameSchema = z.object({
  t: z.literal("pty.opened"),
  pty_id: z.string().min(1),
});

export const PtyDataFrameSchema = z.object({
  t: z.literal("pty.data"),
  pty_id: z.string().min(1),
  bytes: z.string(),
});

export const PtyExitFrameSchema = z.object({
  t: z.literal("pty.exit"),
  pty_id: z.string().min(1),
  code: z.number().int(),
  signal: z.string().nullable(),
});

/** The closed set of `pty.error` codes the Companion may emit. */
export const PtyErrorCodeSchema = z.enum([
  "cap-exceeded",
  "spawn-failed",
  "not-authed",
  "pty-detached",
  "unknown-pty",
  "bad-frame",
  "frame-too-large",
  "paste-too-large",
]);

export const PtyErrorFrameSchema = z.object({
  t: z.literal("pty.error"),
  code: PtyErrorCodeSchema,
  pty_id: z.string().min(1).optional(),
  detail: z.string().optional(),
});

/** Any frame the Companion may send to the browser. */
export const ServerFrameSchema = z.discriminatedUnion("t", [
  HelloFrameSchema,
  PtyOpenedFrameSchema,
  PtyDataFrameSchema,
  PtyExitFrameSchema,
  PtyErrorFrameSchema,
]);

// ── Inferred types ──────────────────────────────────────────────────────────

export type PtyOpenFrame = z.infer<typeof PtyOpenFrameSchema>;
export type PtyWriteFrame = z.infer<typeof PtyWriteFrameSchema>;
export type PtyResizeFrame = z.infer<typeof PtyResizeFrameSchema>;
export type PtyCloseFrame = z.infer<typeof PtyCloseFrameSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export type HelloFrame = z.infer<typeof HelloFrameSchema>;
export type PtyOpenedFrame = z.infer<typeof PtyOpenedFrameSchema>;
export type PtyDataFrame = z.infer<typeof PtyDataFrameSchema>;
export type PtyExitFrame = z.infer<typeof PtyExitFrameSchema>;
export type PtyErrorCode = z.infer<typeof PtyErrorCodeSchema>;
export type PtyErrorFrame = z.infer<typeof PtyErrorFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// ── Parse helpers ────────────────────────────────────────────────────────────

export type ParseClientFrameResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: "bad-frame" | "frame-too-large" | "paste-too-large"; msg: string };

/**
 * Parse one raw inbound WS message into a validated ClientFrame.
 * Enforces MAX_FRAME_BYTES and the MAX_PASTE_BYTES paste cap before the frame
 * ever reaches the PTY. A negative result carries a structured error code so
 * the bridge can reply with a matching `pty.error` frame.
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
  if (frame.t === "pty.write" && Buffer.byteLength(frame.data, "utf8") > MAX_PASTE_BYTES) {
    return { ok: false, code: "paste-too-large", msg: "pty.write data exceeds MAX_PASTE_BYTES" };
  }

  return { ok: true, frame };
}

/**
 * Decide whether a web client advertising `clientProtocolVersion` can speak to
 * this Companion. A mismatch routes the web side into the `protocol-mismatch`
 * failure state — it does not silently half-work.
 */
export function isProtocolCompatible(clientProtocolVersion: number): boolean {
  return clientProtocolVersion === PROTOCOL_VERSION;
}
