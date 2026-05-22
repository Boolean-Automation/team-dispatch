// dispatch — Phase 2 / Codex post-qa P2 fix.
//
// Integration test for the Companion-restart scrollback rekey-forward + muted
// marker. Pre-fix, `scrollbackStore.rekeyForward` existed but was called only
// from its own unit test; production code never wired it into the epoch-flip
// handler, so the old scrollback stayed orphaned under the dead pty_id and
// the SE saw an empty buffer + no marker.
//
// This test drives `useCompanion` against a hand-rolled mock TerminalTransport
// so we can:
//   1. Seed scrollback under the OLD (ticket_id, pty_id) pair.
//   2. Simulate the first connect → pty.open → pty.opened cycle for the old
//      id, so `prevActivePtyIdRef` captures it.
//   3. Simulate WS close + reconnect with a NEW `companion_started_at` epoch.
//   4. Simulate `pty.opened` for the NEW pty_id (driving the rekey).
//   5. Assert: the old scrollback is now under the new key, the old key is
//      empty, and the muted marker is the tail of the new buffer.
//
// Determinism: fake-indexeddb gives a real IDB; the mock transport drives all
// timing; no real wall-clock or WebSocket. Use act() to flush React renders.

import "fake-indexeddb/auto";
import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

import { useCompanion } from "./use-companion-session.js";
import type {
  TerminalTransport,
  TransportHandlers,
  PtyFrame,
} from "./terminal-transport.js";
import type {
  ClientFrame,
  ServerFrame,
  PtyOpenedFrame,
} from "./companion-protocol.js";
import { scrollbackStore } from "../terminal/scrollback-store.js";

// ── Mock transport ────────────────────────────────────────────────────────────
//
// Drives the seam by exposing `emitStatus(status)` and `emitFrame(frame)`. The
// `openPty` promise resolves when the test calls `resolveOpenPty(pty_id)` —
// matching the real CompanionWsTransport's invariant that resolution happens
// when the `pty.opened` frame arrives.

class MockTransport implements TerminalTransport {
  handlers: TransportHandlers | undefined;
  private pendingOpen:
    | { resolve: (pid: string) => void; reject: (err: Error) => void }
    | null = null;
  private subs = new Map<string, Set<(f: PtyFrame) => void>>();
  sentFrames: ClientFrame[] = [];

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.handlers.onStatus({ state: "idle" });
  }

  send(frame: ClientFrame): void {
    this.sentFrames.push(frame);
  }

  openPty(_ticketId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pendingOpen = { resolve, reject };
    });
  }

  subscribe(pty_id: string, listener: (f: PtyFrame) => void): () => void {
    let set = this.subs.get(pty_id);
    if (!set) {
      set = new Set();
      this.subs.set(pty_id, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  write(_pty_id: string, _data: string): void {
    /* test-only — no-op */
  }

  resize(_pty_id: string, _cols: number, _rows: number): void {
    /* test-only — no-op */
  }

  closePty(_pty_id: string): void {
    /* test-only — no-op */
  }

  close(): void {
    /* test-only — no-op */
  }

  // ── Test driver hooks ────────────────────────────────────────────────────────

  emitStatus(status: {
    state:
      | "idle"
      | "connecting"
      | "connected"
      | "not-detected"
      | "shell-unavailable"
      | "claude-unusable"
      | "degraded"
      | "quota-limited"
      | "version-mismatch"
      | "protocol-mismatch"
      | "mint-unavailable"
      | "local-permission-denied";
    companionStartedAt?: number;
  }): void {
    this.handlers?.onStatus(status);
  }

  emitFrame(frame: ServerFrame): void {
    this.handlers?.onFrame(frame);
  }

  /**
   * Resolve the pending `openPty(...)` promise. Mirrors the real transport's
   * invariant: the promise resolves when `pty.opened` arrives — but in tests
   * we also separately emit `pty.opened` so subscribers see the frame too.
   */
  resolveOpenPty(pty_id: string): void {
    const p = this.pendingOpen;
    this.pendingOpen = null;
    p?.resolve(pty_id);
  }
}

// ── Test harness component ────────────────────────────────────────────────────

interface HarnessProps {
  ticketId: string;
  transport: TerminalTransport;
  onActivePtyId?: (id: string | null) => void;
}

function Harness({
  ticketId,
  transport,
  onActivePtyId,
}: HarnessProps): React.ReactElement | null {
  const companion = useCompanion({ ticketId, transport });
  React.useEffect(() => {
    onActivePtyId?.(companion.activePtyId);
  }, [companion.activePtyId, onActivePtyId]);
  return null;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesOf(s: string): Uint8Array {
  return enc.encode(s);
}

function decode(buf: Uint8Array): string {
  return dec.decode(buf);
}

/**
 * Flush microtasks until a condition holds, with a bounded retry loop. We
 * don't use real timers — fake-indexeddb resolves synchronously enough that
 * a small loop of `await Promise.resolve()` drains every queued task.
 */
async function flushAsync(): Promise<void> {
  // fake-indexeddb operations resolve quickly but each IDB transaction stage
  // (open cursor, continue, put, delete, commit) adds a few microtasks. Drain
  // generously — overshooting is cheap, under-shooting hangs the buffer mid-
  // rekey when the test assertion runs against a partial commit.
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
  }
}

/**
 * Wait until `getRecent(ticketId, ptyId)` contains the given substring (or
 * the deadline expires). Returns the final decoded buffer so the test can
 * assert against it. The bounded loop is deterministic — no real clock.
 */
async function waitForBufferContains(
  ticketId: string,
  ptyId: string,
  needle: string,
  maxIterations = 500
): Promise<string> {
  for (let i = 0; i < maxIterations; i++) {
    const buf = decode(await scrollbackStore.getRecent(ticketId, ptyId));
    if (buf.includes(needle)) return buf;
    await Promise.resolve();
  }
  // Final read for the assertion's diff output.
  return decode(await scrollbackStore.getRecent(ticketId, ptyId));
}

const RESTART_MARKER_TEXT =
  "[Previous shell ended when Companion restarted; new shell started.]";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useCompanion — Companion-restart scrollback rekey-forward + marker", () => {
  beforeEach(async () => {
    await scrollbackStore.__forTest.reset();
  });

  it("rekeys old scrollback to the new pty_id and appends the muted marker", async () => {
    const ticketId = "DSP-1";
    const oldPtyId = "pty-old-id";
    const newPtyId = "pty-new-id";

    // Seed scrollback under (DSP-1, pty-old-id) — pretend the user typed a
    // few commands before the Companion crashed.
    await scrollbackStore.append(ticketId, oldPtyId, bytesOf("$ ls\r\n"));
    await scrollbackStore.append(
      ticketId,
      oldPtyId,
      bytesOf("file-1 file-2 file-3\r\n")
    );
    await scrollbackStore.append(ticketId, oldPtyId, bytesOf("$ "));

    // Sanity: old key has the seeded bytes; new key is empty.
    expect(decode(await scrollbackStore.getRecent(ticketId, oldPtyId))).toBe(
      "$ ls\r\nfile-1 file-2 file-3\r\n$ "
    );
    expect(
      (await scrollbackStore.getRecent(ticketId, newPtyId)).length
    ).toBe(0);

    const transport = new MockTransport();
    let observedActivePtyId: string | null = null;

    render(
      <Harness
        ticketId={ticketId}
        transport={transport}
        onActivePtyId={(id) => {
          observedActivePtyId = id;
        }}
      />
    );

    // The hook's connect() ran during mount; emit the first `connected` with
    // the OLD epoch so the hook captures it as `lastEpoch` and opens its
    // first PTY.
    await act(async () => {
      transport.emitStatus({
        state: "connected",
        companionStartedAt: 1_000,
      });
      await flushAsync();
    });

    // `openPty(...)` is now pending. Emit `pty.opened` for the old pty_id
    // (no pending rekey on this first epoch — frame forwards immediately),
    // then resolve the promise to mark the open complete.
    await act(async () => {
      const openedOld: PtyOpenedFrame = {
        t: "pty.opened",
        pty_id: oldPtyId,
      };
      transport.emitFrame(openedOld);
      transport.resolveOpenPty(oldPtyId);
      await flushAsync();
    });

    expect(observedActivePtyId).toBe(oldPtyId);

    // Now: Companion restart. New epoch arrives. The hook fires another
    // openPty() and arms `pendingRekey = { oldPtyId }`.
    await act(async () => {
      transport.emitStatus({
        state: "connected",
        companionStartedAt: 2_000,
      });
      await flushAsync();
    });

    // `activePtyId` should have been reset to null (cached pty_ids are dead).
    expect(observedActivePtyId).toBe(null);

    // Emit `pty.opened` for the new id. The onFrame interceptor should:
    //   1. Detect pendingRekey is set.
    //   2. Run rekeyForward(DSP-1, pty-old-id, pty-new-id).
    //   3. Append RESTART_MARKER bytes under (DSP-1, pty-new-id).
    //   4. Then forward the frame to subscribers (allowing useActivePty etc.
    //      to flip).
    // Resolve the openPty promise AFTER emitFrame returns — matches the real
    // transport's ordering (resolve happens inside dispatchPtyFrame too,
    // before handlers.onFrame fires, but the .then microtask runs after the
    // current handler).
    await act(async () => {
      const openedNew: PtyOpenedFrame = {
        t: "pty.opened",
        pty_id: newPtyId,
      };
      transport.emitFrame(openedNew);
      transport.resolveOpenPty(newPtyId);
      await flushAsync();
    });

    // ── Assertions ───────────────────────────────────────────────────────────

    // 1. Old scrollback now lives under the NEW pty_id. Wait for the marker
    // to appear — the rekey + append run inside an async IIFE in the hook
    // and complete on the microtask queue; we poll until committed (bounded).
    const newBuf = await waitForBufferContains(
      ticketId,
      newPtyId,
      RESTART_MARKER_TEXT
    );
    expect(newBuf).toContain("$ ls\r\n");
    expect(newBuf).toContain("file-1 file-2 file-3");

    // 2. The muted marker is at the tail of the new buffer.
    expect(newBuf).toContain(RESTART_MARKER_TEXT);
    expect(newBuf.endsWith("\r\n")).toBe(true);
    // Marker carries the dim-italic SGR (\x1b[2m) and reset (\x1b[0m).
    expect(newBuf).toContain("\x1b[2m");
    expect(newBuf).toContain("\x1b[0m");
    // Marker must come AFTER the seeded scrollback bytes.
    const lsIndex = newBuf.indexOf("$ ls");
    const markerIndex = newBuf.indexOf(RESTART_MARKER_TEXT);
    expect(markerIndex).toBeGreaterThan(lsIndex);

    // 3. Old key is empty (rekey copy-then-delete semantics).
    const oldBuf = await scrollbackStore.getRecent(ticketId, oldPtyId);
    expect(oldBuf.length).toBe(0);

    // 4. The hook's activePtyId flipped to the new id — useActivePty would
    //    see the frame as well, so the Terminal mount can proceed.
    expect(observedActivePtyId).toBe(newPtyId);
  });

  it("does NOT rekey on the first epoch (fresh connection, no prior pty)", async () => {
    const ticketId = "DSP-2";
    const firstPtyId = "pty-first";

    const transport = new MockTransport();

    render(<Harness ticketId={ticketId} transport={transport} />);

    await act(async () => {
      transport.emitStatus({
        state: "connected",
        companionStartedAt: 5_000,
      });
      await flushAsync();
    });

    // No pending rekey: the frame forwards normally, no IDB write happens.
    await act(async () => {
      const opened: PtyOpenedFrame = {
        t: "pty.opened",
        pty_id: firstPtyId,
      };
      transport.emitFrame(opened);
      transport.resolveOpenPty(firstPtyId);
      await flushAsync();
    });

    // The buffer under the first pty_id is empty — no marker, no copy from
    // a (non-existent) prior pty.
    const buf = await scrollbackStore.getRecent(ticketId, firstPtyId);
    expect(buf.length).toBe(0);
  });
});
