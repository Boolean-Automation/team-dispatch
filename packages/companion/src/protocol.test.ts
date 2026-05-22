/**
 * protocol.test.ts — the Phase 2 multi-PTY frame contract.
 *
 * Covers: frame schemas round-trip, malformed frames rejected, the
 * protocolVersion / Companion-version mismatch path, and the
 * max-frame-size / paste-size-cap bounds.
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

describe("client frame schemas (Phase 2 multi-PTY)", () => {
  it("round-trips a pty.open frame", () => {
    const frame = { t: "pty.open", ticket_id: "DSP-2901" };
    expect(ClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips a pty.write frame", () => {
    const frame = { t: "pty.write", pty_id: "01H8XGJWBWBAQ4XK1RY1Q1XKQM", data: "ls\n" };
    expect(ClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips a pty.resize frame", () => {
    const frame = {
      t: "pty.resize",
      pty_id: "01H8XGJWBWBAQ4XK1RY1Q1XKQM",
      cols: 132,
      rows: 40,
    };
    expect(ClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips a pty.close frame", () => {
    const frame = { t: "pty.close", pty_id: "01H8XGJWBWBAQ4XK1RY1Q1XKQM" };
    expect(ClientFrameSchema.parse(frame)).toEqual(frame);
  });

  it("rejects a pty.resize frame with non-positive dimensions", () => {
    expect(
      ClientFrameSchema.safeParse({
        t: "pty.resize",
        pty_id: "x",
        cols: 0,
        rows: 24,
      }).success
    ).toBe(false);
    expect(
      ClientFrameSchema.safeParse({
        t: "pty.resize",
        pty_id: "x",
        cols: -1,
        rows: 24,
      }).success
    ).toBe(false);
  });

  it("rejects pty.write missing pty_id", () => {
    expect(
      ClientFrameSchema.safeParse({ t: "pty.write", data: "ls\n" }).success
    ).toBe(false);
  });

  it("rejects pty.open with empty ticket_id", () => {
    expect(
      ClientFrameSchema.safeParse({ t: "pty.open", ticket_id: "" }).success
    ).toBe(false);
  });

  it("rejects an unknown frame type", () => {
    expect(
      ClientFrameSchema.safeParse({ t: "exec", cmd: "rm -rf /" }).success
    ).toBe(false);
  });

  it("rejects the dropped Spike #1 single-PTY data frame shape", () => {
    // Phase 2 supersedes Spike #1: { t: 'data', d: '...' } is gone.
    expect(ClientFrameSchema.safeParse({ t: "data", d: "ls\n" }).success).toBe(
      false
    );
  });
});

describe("server frame schemas", () => {
  it("round-trips a hello frame with capabilities + companion_started_at", () => {
    const frame = {
      t: "hello",
      protocolVersion: PROTOCOL_VERSION,
      companionVersion: COMPANION_VERSION,
      capabilities: ["multi-pty", "scrollback-restore"],
      companion_started_at: 1716345600000,
    };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips a pty.opened frame", () => {
    const frame = { t: "pty.opened", pty_id: "01H8XGJW" };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips a pty.data frame", () => {
    const frame = { t: "pty.data", pty_id: "01H8X", bytes: "hello\r\n" };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });

  it("round-trips a pty.exit frame with a string signal", () => {
    const frame = { t: "pty.exit", pty_id: "01H8X", code: 0, signal: null };
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
    const frame2 = { t: "pty.exit", pty_id: "01H8X", code: 1, signal: "SIGTERM" };
    expect(ServerFrameSchema.parse(frame2)).toEqual(frame2);
  });

  it("round-trips pty.error variants (with and without pty_id)", () => {
    const cap = { t: "pty.error", code: "cap-exceeded" };
    expect(ServerFrameSchema.parse(cap)).toEqual(cap);
    const auth = {
      t: "pty.error",
      code: "not-authed",
      pty_id: "01H8X",
      detail: "pty owned by different connection",
    };
    expect(ServerFrameSchema.parse(auth)).toEqual(auth);
  });

  it("rejects pty.error with an unknown code", () => {
    expect(
      ServerFrameSchema.safeParse({ t: "pty.error", code: "nonsense" }).success
    ).toBe(false);
  });
});

describe("parseClientFrame — inbound validation", () => {
  it("parses a valid pty.write frame", () => {
    const result = parseClientFrame(
      JSON.stringify({ t: "pty.write", pty_id: "x", data: "ls\n" })
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.frame).toEqual({ t: "pty.write", pty_id: "x", data: "ls\n" });
  });

  it("rejects non-JSON with code bad-frame", () => {
    const result = parseClientFrame("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad-frame");
  });

  it("rejects a schema-invalid frame with code bad-frame", () => {
    const result = parseClientFrame(JSON.stringify({ t: "pty.write" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad-frame");
  });

  it("rejects an inbound frame larger than MAX_FRAME_BYTES", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 1024);
    const result = parseClientFrame(
      JSON.stringify({ t: "pty.write", pty_id: "p", data: huge })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("frame-too-large");
  });

  it("rejects a pty.write whose payload exceeds the paste cap", () => {
    const bigPaste = "p".repeat(MAX_PASTE_BYTES + 1024);
    const result = parseClientFrame(
      JSON.stringify({ t: "pty.write", pty_id: "p", data: bigPaste })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("paste-too-large");
  });

  it("accepts a pty.write right at the paste cap", () => {
    const atCap = "p".repeat(MAX_PASTE_BYTES);
    const result = parseClientFrame(
      JSON.stringify({ t: "pty.write", pty_id: "p", data: atCap })
    );
    expect(result.ok).toBe(true);
  });
});

describe("protocol version negotiation", () => {
  it("accepts a client speaking the current protocol version (2)", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it("rejects a client speaking a different protocol version (mismatch state)", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION + 1)).toBe(false);
    expect(isProtocolCompatible(1)).toBe(false); // Spike #1 / Phase 1 client
    expect(isProtocolCompatible(0)).toBe(false);
  });
});
