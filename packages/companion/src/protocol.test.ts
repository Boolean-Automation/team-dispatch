/**
 * protocol.test.ts — the WebSocket frame contract.
 *
 * Covers: frame schemas round-trip, malformed frames rejected, the
 * protocolVersion / Companion-version mismatch path, and the max-frame-size /
 * paste-size-cap bounds (Codex P2; spec §4.5, A18 states e/f).
 */

import { describe, it, expect } from "vitest";
import {
  ClientFrameSchema,
  ServerFrameSchema,
  parseClientFrame,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  COMPANION_VERSION,
  MAX_FRAME_BYTES,
  MAX_PASTE_BYTES,
} from "./protocol.js";

describe("client frame schemas", () => {
  it("round-trips a data frame", () => {
    const frame = { t: "data", d: "hello\r\n" };
    const parsed = ClientFrameSchema.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("round-trips a resize frame", () => {
    const frame = { t: "resize", cols: 132, rows: 40 };
    const parsed = ClientFrameSchema.parse(frame);
    expect(parsed).toEqual(frame);
  });

  it("rejects a resize frame with non-positive dimensions", () => {
    expect(ClientFrameSchema.safeParse({ t: "resize", cols: 0, rows: 24 }).success).toBe(
      false
    );
    expect(
      ClientFrameSchema.safeParse({ t: "resize", cols: -1, rows: 24 }).success
    ).toBe(false);
  });

  it("rejects an unknown frame type", () => {
    expect(ClientFrameSchema.safeParse({ t: "exec", cmd: "rm -rf /" }).success).toBe(
      false
    );
  });
});

describe("server frame schemas", () => {
  it("round-trips a session-meta handshake frame with version fields", () => {
    const frame = {
      t: "session-meta",
      sessionId: "5a82f001",
      cmd: "claude",
      protocolVersion: PROTOCOL_VERSION,
      companionVersion: COMPANION_VERSION,
    };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips an exit frame with a null signal", () => {
    const frame = { t: "exit", exitCode: 0, signal: null };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips an error frame", () => {
    const frame = { t: "error", code: "bad-frame", msg: "not JSON" };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });
});

describe("parseClientFrame — inbound validation", () => {
  it("parses a valid data frame", () => {
    const result = parseClientFrame(JSON.stringify({ t: "data", d: "ls\n" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame).toEqual({ t: "data", d: "ls\n" });
  });

  it("rejects non-JSON with code bad-frame", () => {
    const result = parseClientFrame("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad-frame");
  });

  it("rejects a schema-invalid frame with code bad-frame", () => {
    const result = parseClientFrame(JSON.stringify({ t: "data" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad-frame");
  });

  it("rejects an inbound frame larger than MAX_FRAME_BYTES", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1024);
    const result = parseClientFrame(JSON.stringify({ t: "data", d: huge }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("frame-too-large");
  });

  it("rejects a data frame whose payload exceeds the paste cap", () => {
    // Big enough to trip the paste cap but small enough to stay under the
    // (larger) overall frame-size cap.
    const bigPaste = "p".repeat(MAX_PASTE_BYTES + 1024);
    const result = parseClientFrame(JSON.stringify({ t: "data", d: bigPaste }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("paste-too-large");
  });

  it("accepts a data frame right at the paste cap", () => {
    const atCap = "p".repeat(MAX_PASTE_BYTES);
    const result = parseClientFrame(JSON.stringify({ t: "data", d: atCap }));
    expect(result.ok).toBe(true);
  });
});

describe("protocol version negotiation", () => {
  it("accepts a client speaking the current protocol version", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects a client speaking a different protocol version (mismatch state)", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolCompatible(0)).toBe(false);
  });
});
