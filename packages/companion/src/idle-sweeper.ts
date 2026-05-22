/**
 * dispatch Companion — idle sweeper (Phase 2, Codex F3 + R2-F2).
 *
 * Reaps PTYs whose WebSocket has been DETACHED for too long. **Live-WS PTYs
 * are NEVER reaped** — a `sleep 300`, `tail -f`, or silent `pip install` under
 * an open WS is intentional silence, not orphanage.
 *
 * Sweep predicate (per entry): `wsClosedAt !== null && wsClosedAt + idleMs <
 * clock()`. Reap sequence: SIGHUP to the process group → wait `gracePauseMs`
 * → SIGTERM → wait 1s → SIGKILL. The PtySession's `kill()` already implements
 * the TERM→KILL escalation inside node-pty; the sweeper's job is the
 * SIGHUP-first courtesy pause for shells/programs that handle SIGHUP cleanly.
 *
 * Cadence + thresholds + clock are INJECTABLE (Codex F3 testability fold) so
 * `vi.useFakeTimers()` + a fake clock drive the soak test in <5s wall time.
 */

import type { PtyMap, PtyMapEntry } from "./pty-map.js";

export interface SweeperMetrics {
  /** Increment `companion_ptys_reaped_total{reason}`. */
  incrementReaped(reason: "ws-closed-idle" | "explicit-close" | "sigterm"): void;
}

export interface SweeperConfig {
  /** How often to walk the map. */
  tickMs: number;
  /** Reap threshold (ms since `wsClosedAt`). */
  idleMs: number;
  /** Pause between SIGHUP and SIGTERM. */
  gracePauseMs: number;
  /** Clock fn — injectable for tests. */
  clock: () => number;
}

export interface IdleSweeperHandle {
  /** Start the tick interval. */
  start(): void;
  /** Stop the tick interval. */
  stop(): void;
  /** Run a single sweep iteration (test hook — bypass setInterval). */
  tickOnce(): void;
  /** Whether `start()` is currently running. */
  readonly running: boolean;
}

/**
 * Build a sweeper. `start()` arms the interval; `stop()` clears it. The actual
 * reap is `reapEntry()` which orchestrates the SIGHUP → SIGTERM → SIGKILL
 * sequence and removes the entry from the map.
 *
 * Default metrics is a no-op — tests pass a sink; main.ts wires the live
 * counter.
 */
export function createIdleSweeper(
  map: PtyMap,
  config: SweeperConfig,
  metrics: SweeperMetrics = { incrementReaped: () => {} }
): IdleSweeperHandle {
  let intervalHandle: NodeJS.Timeout | undefined;
  let running = false;

  /**
   * Reap one entry: SIGHUP process-group, wait gracePauseMs, then SIGTERM
   * (PtySession.kill() also escalates to SIGKILL after its internal grace
   * window). After the SIGTERM is dispatched the entry is removed from the
   * map — the OS-level process death is best-effort by then.
   */
  function reapEntry(entry: PtyMapEntry): void {
    const pgid = entry.session.pid;
    // SIGHUP to the whole process-group — courtesy signal for shells/tails
    // that handle SIGHUP cleanly (writes a trailing newline, flushes buffers).
    try {
      if (pgid > 0) process.kill(-pgid, "SIGHUP");
    } catch {
      /* group may already be gone */
    }
    setTimeout(() => {
      // PtySession.kill() owns the TERM→KILL escalation (KILL_GRACE_MS in
      // pty-session.ts). The sweeper just needs to fire it after the SIGHUP
      // pause.
      try {
        entry.session.kill();
      } catch {
        /* already dead */
      }
      map.delete(entry.pty_id);
      metrics.incrementReaped("ws-closed-idle");
    }, config.gracePauseMs).unref?.();
  }

  function tickOnce(): void {
    const now = config.clock();
    // Collect first, mutate second — avoid iterator invalidation while we
    // mutate the underlying Map.
    const toReap: PtyMapEntry[] = [];
    map.forEach((entry) => {
      // Codex R2-F2 binding: live-WS PTYs are NEVER reaped, regardless of
      // lastIoAt. Silence under a heartbeating WS is intentional.
      if (entry.wsClosedAt === null) return;
      if (entry.wsClosedAt + config.idleMs < now) {
        toReap.push(entry);
      }
    });
    for (const entry of toReap) reapEntry(entry);
  }

  return {
    start() {
      if (running) return;
      running = true;
      intervalHandle = setInterval(tickOnce, config.tickMs);
      intervalHandle.unref?.();
    },
    stop() {
      if (!running) return;
      running = false;
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
    },
    tickOnce,
    get running() {
      return running;
    },
  };
}
