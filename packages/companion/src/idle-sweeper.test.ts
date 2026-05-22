/**
 * idle-sweeper.test.ts — Codex F3 testability fold + R2-F2 semantics.
 *
 * The sweeper reaps PTYs whose WS has been detached for > idleMs. A live-WS
 * PTY is NEVER reaped, regardless of how long lastIoAt has been stale.
 *
 * Tests use injected fake clock + `tickOnce()` so no real wall-time elapses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdleSweeper } from "./idle-sweeper.js";
import type { SweeperConfig, SweeperMetrics } from "./idle-sweeper.js";
import { createPtyMap } from "./pty-map.js";
import type { PtySessionFactory } from "./pty-map.js";
import type { PtySession } from "./pty-session.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeSession(): PtySession {
  return {
    sessionId: "fake",
    spawnedArgv: ["/bin/sh", "-l"],
    pid: 0,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    isKilled: false,
  } as unknown as PtySession;
}

const fakeSpawn: PtySessionFactory = () => fakeSession();

function makeMetrics(): SweeperMetrics & { reaped: string[] } {
  const reaped: string[] = [];
  return {
    reaped,
    incrementReaped(reason) {
      reaped.push(reason);
    },
  };
}

describe("idle-sweeper — live-WS PTYs are NEVER reaped (R2-F2)", () => {
  it("a PTY with wsClosedAt=null survives 100× idleMs of fake ticks", async () => {
    const map = createPtyMap();
    let now = 1_000;
    const config: SweeperConfig = {
      tickMs: 100,
      idleMs: 1_000,
      gracePauseMs: 10,
      clock: () => now,
    };
    const metrics = makeMetrics();
    const sweeper = createIdleSweeper(map, config, metrics);

    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-A",
      spawn: fakeSpawn,
      clock: () => now,
    });
    if (!opened.ok) throw new Error("setup failed");

    // 100 ticks at 100,000 ms past idleMs — live WS, must NOT reap.
    for (let i = 0; i < 100; i++) {
      now += config.idleMs;
      sweeper.tickOnce();
    }
    expect(map.get(opened.pty_id)).toBeDefined();
    expect(metrics.reaped.length).toBe(0);
  });
});

describe("idle-sweeper — detached PTYs are reaped after wsClosedAt + idleMs", () => {
  it("reaps an entry only AFTER wsClosedAt + idleMs has elapsed", async () => {
    const map = createPtyMap();
    let now = 1_000;
    const config: SweeperConfig = {
      tickMs: 100,
      idleMs: 1_000,
      gracePauseMs: 10,
      clock: () => now,
    };
    const metrics = makeMetrics();
    const sweeper = createIdleSweeper(map, config, metrics);

    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-A",
      spawn: fakeSpawn,
      clock: () => now,
    });
    if (!opened.ok) throw new Error("setup failed");

    // Detach at t=1000.
    map.markDetached("conn-A", () => now);

    // Advance to t=1500 — wsClosedAt + idleMs is t=2000 — still under threshold.
    now = 1_500;
    sweeper.tickOnce();
    expect(map.get(opened.pty_id)).toBeDefined();
    expect(metrics.reaped.length).toBe(0);

    // Advance past wsClosedAt + idleMs.
    now = 2_500;
    sweeper.tickOnce();

    // Sweeper used setTimeout(gracePauseMs) before the actual kill; advance
    // fake timers to fire it.
    await vi.advanceTimersByTimeAsync(config.gracePauseMs + 5);

    expect(map.get(opened.pty_id)).toBeUndefined();
    expect(metrics.reaped).toEqual(["ws-closed-idle"]);
  });
});

describe("idle-sweeper — gracePauseMs delays the actual kill", () => {
  it("does not call session.kill() until gracePauseMs has elapsed (SIGHUP-first)", async () => {
    const map = createPtyMap();
    let now = 1_000;
    const config: SweeperConfig = {
      tickMs: 100,
      idleMs: 500,
      gracePauseMs: 3_000,
      clock: () => now,
    };
    const metrics = makeMetrics();
    const sweeper = createIdleSweeper(map, config, metrics);

    const opened = await map.open({
      ticket_id: "DSP-1",
      ownerConnectionId: "conn-A",
      spawn: fakeSpawn,
      clock: () => now,
    });
    if (!opened.ok) throw new Error("setup failed");
    const session = map.get(opened.pty_id)!.session;

    map.markDetached("conn-A", () => now);
    now = 2_000; // > wsClosedAt + idleMs (1500)
    sweeper.tickOnce();

    // BEFORE gracePauseMs — session.kill() should NOT have been called yet.
    // (The sweeper sent SIGHUP first, then scheduled the kill via setTimeout.)
    expect(session.kill).not.toHaveBeenCalled();
    expect(map.get(opened.pty_id)).toBeDefined();

    // Advance fake timers past gracePauseMs.
    await vi.advanceTimersByTimeAsync(config.gracePauseMs - 100);
    expect(session.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    // NOW the kill should have fired, entry removed, metric incremented.
    expect(session.kill).toHaveBeenCalled();
    expect(map.get(opened.pty_id)).toBeUndefined();
    expect(metrics.reaped).toEqual(["ws-closed-idle"]);
  });
});

describe("idle-sweeper — start/stop lifecycle", () => {
  it("start() arms the interval; stop() clears it", () => {
    const map = createPtyMap();
    const config: SweeperConfig = {
      tickMs: 100,
      idleMs: 1_000,
      gracePauseMs: 10,
      clock: () => 0,
    };
    const sweeper = createIdleSweeper(map, config);
    expect(sweeper.running).toBe(false);
    sweeper.start();
    expect(sweeper.running).toBe(true);
    // Idempotent: a second start is a no-op.
    sweeper.start();
    expect(sweeper.running).toBe(true);
    sweeper.stop();
    expect(sweeper.running).toBe(false);
    // Idempotent: a second stop is a no-op.
    sweeper.stop();
    expect(sweeper.running).toBe(false);
  });
});
