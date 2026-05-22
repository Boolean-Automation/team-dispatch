// dispatch — Phase 2 / Codex post-qa P2 fix (+ R2-P2 followup).
//
// Integration test for the Companion-restart scrollback rekey-forward + muted
// marker. The test drives the REAL retry/reconnect shape:
//
//   1. Transport connects, hello arrives (epoch E1), pty.opened (old id).
//   2. Socket close → CompanionWsTransport surfaces `not-detected`.
//   3. User clicks retry → `companion.retry()` bumps `retryNonce` →
//      useMemo MINTS A NEW TRANSPORT INSTANCE (Codex R2-P2: this is the
//      production path; the prior test bypassed it by re-emitting `connected`
//      on the SAME mock transport, which production never does).
//   4. New transport connects, hello arrives (epoch E2 ≠ E1), pty.opened (new
//      id).
//   5. Rekey-forward + marker fires.
//
// To force the hook to mint a fresh transport on retry, we vi.mock the
// CompanionWsTransport module — each `new CompanionWsTransport(...)` returns a
// fresh MockTransport, and we hand the test-level list of those instances so
// we can drive each one in order.
//
// Determinism: fake-indexeddb gives a real IDB; the mocks drive all timing;
// no real wall-clock or WebSocket.

import "fake-indexeddb/auto";
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";

// ── Mock the CompanionWsTransport module ─────────────────────────────────────
//
// Each `new CompanionWsTransport(...)` constructs a fresh MockTransport and
// pushes it into `__transports`. The test reads from that list to drive the
// transport that corresponds to the current retry epoch.

const __transports: MockTransport[] = [];

vi.mock("./companion-ws-transport.js", () => {
  return {
    CompanionWsTransport: vi
      .fn()
      .mockImplementation(function CompanionWsTransportMock() {
        const t = new MockTransport();
        __transports.push(t);
        return t;
      }),
  };
});

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
  closed = false;
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
    this.closed = true;
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
  onCompanion?: (companion: ReturnType<typeof useCompanion>) => void;
  onActivePtyId?: (id: string | null) => void;
}

function Harness({
  ticketId,
  onCompanion,
  onActivePtyId,
}: HarnessProps): React.ReactElement | null {
  // No `transport` prop — let the hook mint via the mocked
  // CompanionWsTransport constructor, so each retryNonce bump produces a
  // fresh MockTransport instance.
  const companion = useCompanion({ ticketId });
  React.useEffect(() => {
    onCompanion?.(companion);
  }, [companion, onCompanion]);
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
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
  }
}

/**
 * Wait until `getRecent(ticketId, ptyId)` contains the given substring (or
 * the deadline expires). Returns the final decoded buffer so the test can
 * assert against it.
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
  return decode(await scrollbackStore.getRecent(ticketId, ptyId));
}

const RESTART_MARKER_TEXT =
  "[Previous shell ended when Companion restarted; new shell started.]";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useCompanion — Companion-restart scrollback rekey-forward + marker", () => {
  beforeEach(async () => {
    await scrollbackStore.__forTest.reset();
    __transports.length = 0;
  });

  // Codex R2-P2: this test drives the REAL retry shape — a SECOND transport
  // instance materializes via the retryNonce-bumped useMemo. Pre-fix the
  // `lastEpoch` was effect-local, so the new transport's first `connected`
  // status looked like a fresh first-epoch and pendingRekey never armed.
  // The fix persists `lastEpochRef` across transport lifetimes (reset only on
  // ticketId change).
  it("rekeys old scrollback to the new pty_id across a real retry/transport rebuild", async () => {
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

    let companionRef: ReturnType<typeof useCompanion> | null = null;
    let observedActivePtyId: string | null = null;

    render(
      <Harness
        ticketId={ticketId}
        onCompanion={(c) => {
          companionRef = c;
        }}
        onActivePtyId={(id) => {
          observedActivePtyId = id;
        }}
      />
    );

    // Mount minted the FIRST transport via the mocked constructor.
    await flushAsync();
    expect(__transports.length).toBe(1);
    const t1 = __transports[0]!;

    // Emit the first `connected` with the OLD epoch so the hook captures it
    // as `lastEpochRef.current` and opens its first PTY.
    await act(async () => {
      t1.emitStatus({
        state: "connected",
        companionStartedAt: 1_000,
      });
      await flushAsync();
    });

    // Emit `pty.opened` for the OLD pty_id (no pending rekey on first epoch),
    // then resolve the openPty promise.
    await act(async () => {
      const openedOld: PtyOpenedFrame = {
        t: "pty.opened",
        pty_id: oldPtyId,
      };
      t1.emitFrame(openedOld);
      t1.resolveOpenPty(oldPtyId);
      await flushAsync();
    });

    expect(observedActivePtyId).toBe(oldPtyId);

    // ── REAL retry shape: socket close → not-detected → user clicks retry ──
    //
    // The CompanionWsTransport in production surfaces `not-detected` when the
    // WS closes (companion-ws-transport.ts:502). The UI calls
    // companion.retry(), which bumps retryNonce, which re-runs the useMemo
    // and mints a NEW transport instance.

    await act(async () => {
      t1.emitStatus({
        state: "not-detected",
        // no companionStartedAt — connection went away
      });
      await flushAsync();
    });

    // User clicks retry. retryNonce bump → new transport instance.
    expect(companionRef).not.toBeNull();
    await act(async () => {
      companionRef!.retry();
      await flushAsync();
    });

    // A SECOND transport instance must have been minted by the mocked
    // CompanionWsTransport constructor. The old one is closed.
    expect(__transports.length).toBe(2);
    const t2 = __transports[1]!;
    expect(t2).not.toBe(t1);
    expect(t1.closed).toBe(true);

    // New transport connects with the NEW epoch (Companion restarted, so
    // companion_started_at differs from epoch 1).
    await act(async () => {
      t2.emitStatus({
        state: "connected",
        companionStartedAt: 2_000,
      });
      await flushAsync();
    });

    // The hook should have noted that lastEpochRef.current (1_000) ≠ new
    // epoch (2_000) and armed `pendingRekey = { oldPtyId }`. activePtyId
    // gets reset to null.
    expect(observedActivePtyId).toBe(null);

    // Emit `pty.opened` for the new id on the NEW transport — the onFrame
    // interceptor runs the rekey-forward + marker append + frame forward.
    await act(async () => {
      const openedNew: PtyOpenedFrame = {
        t: "pty.opened",
        pty_id: newPtyId,
      };
      t2.emitFrame(openedNew);
      t2.resolveOpenPty(newPtyId);
      await flushAsync();
    });

    // ── Assertions ───────────────────────────────────────────────────────────

    // 1. Old scrollback now lives under the NEW pty_id. Wait for the marker
    // to appear — the rekey + append run inside an async IIFE in the hook
    // and complete on the microtask queue.
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

    render(<Harness ticketId={ticketId} />);
    await flushAsync();
    expect(__transports.length).toBe(1);
    const t1 = __transports[0]!;

    await act(async () => {
      t1.emitStatus({
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
      t1.emitFrame(opened);
      t1.resolveOpenPty(firstPtyId);
      await flushAsync();
    });

    // The buffer under the first pty_id is empty — no marker, no copy from
    // a (non-existent) prior pty.
    const buf = await scrollbackStore.getRecent(ticketId, firstPtyId);
    expect(buf.length).toBe(0);
  });

  // Codex R2-P2 — prevActivePtyId updates from EVERY forwarded `pty.opened`,
  // not just the auto-open .then(). This covers manual openPty() (e.g.
  // user-driven tab open via activePty) and multi-PTY scenarios so the rekey
  // targets the MOST RECENT active id, not just the auto-opened one.
  it("tracks the most recently opened pty_id across multiple pty.opened frames", async () => {
    const ticketId = "DSP-3";
    const autoPtyId = "pty-auto";
    const manualPtyId = "pty-manual";
    const newPtyId = "pty-new";

    // Seed scrollback under the MANUAL pty — that's the one the user was
    // actively using when the Companion crashed, so it's the one whose
    // scrollback should be rekeyed forward.
    await scrollbackStore.append(
      ticketId,
      manualPtyId,
      bytesOf("$ pwd\r\n/home/se\r\n$ ")
    );

    let companionRef: ReturnType<typeof useCompanion> | null = null;

    render(
      <Harness
        ticketId={ticketId}
        onCompanion={(c) => {
          companionRef = c;
        }}
      />
    );
    await flushAsync();
    expect(__transports.length).toBe(1);
    const t1 = __transports[0]!;

    // First epoch + auto-opened pty.
    await act(async () => {
      t1.emitStatus({ state: "connected", companionStartedAt: 10_000 });
      await flushAsync();
    });
    await act(async () => {
      t1.emitFrame({ t: "pty.opened", pty_id: autoPtyId });
      t1.resolveOpenPty(autoPtyId);
      await flushAsync();
    });

    // Simulate a manual openPty (the user opened a second shell via
    // activePty.openPty in production). The transport emits a NEW pty.opened
    // frame; the hook must update prevActivePtyIdRef from this frame too.
    //
    // The manual openPty would call transport.openPty(), but for this test
    // we only need to assert that an additional pty.opened frame updates
    // the hook's "most recent active" tracking. We bypass the openPty
    // promise plumbing — the hook's onFrame doesn't care, it just inspects
    // the frame.
    await act(async () => {
      t1.emitFrame({ t: "pty.opened", pty_id: manualPtyId });
      await flushAsync();
    });

    // Now: Companion restart. Retry → new transport → new epoch.
    await act(async () => {
      t1.emitStatus({ state: "not-detected" });
      await flushAsync();
    });
    await act(async () => {
      companionRef!.retry();
      await flushAsync();
    });
    expect(__transports.length).toBe(2);
    const t2 = __transports[1]!;

    await act(async () => {
      t2.emitStatus({ state: "connected", companionStartedAt: 20_000 });
      await flushAsync();
    });

    // The new pty.opened arrives. Rekey should target the MOST RECENT
    // active (manualPtyId), not the auto-opened one.
    await act(async () => {
      t2.emitFrame({ t: "pty.opened", pty_id: newPtyId });
      t2.resolveOpenPty(newPtyId);
      await flushAsync();
    });

    const newBuf = await waitForBufferContains(
      ticketId,
      newPtyId,
      RESTART_MARKER_TEXT
    );
    expect(newBuf).toContain("$ pwd\r\n/home/se");
    // The auto-pty buffer was untouched (no scrollback was ever appended to
    // it), so we just confirm the manual buffer was emptied (rekey moved it).
    const oldManual = await scrollbackStore.getRecent(ticketId, manualPtyId);
    expect(oldManual.length).toBe(0);
  });
});
