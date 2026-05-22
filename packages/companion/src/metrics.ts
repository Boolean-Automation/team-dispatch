/**
 * dispatch Companion — Prometheus-format metrics (Phase 2, Codex F3).
 *
 * Exposes a tiny in-process counter/gauge surface and a `renderPrometheus()`
 * helper that serializes them as Prometheus text. The loopback HTTP server
 * (main.ts) registers `GET /metrics` against `127.0.0.1` only — never exposed
 * over the WS upgrade port to a non-loopback peer.
 *
 * Counters / gauges:
 *   companion_ptys_active                (gauge)
 *   companion_ptys_spawned_total         (counter)
 *   companion_ptys_reaped_total{reason}  (counter, labelled)
 *   companion_ws_active                  (gauge)
 *   companion_uptime_seconds             (gauge — derived from start time)
 *   companion_pty_last_io_seconds_ago{pty_id,ticket_id}  (gauge — per entry)
 */

import type { PtyMap } from "./pty-map.js";

export interface CompanionMetrics {
  incrementSpawned(): void;
  incrementReaped(reason: "ws-closed-idle" | "explicit-close" | "sigterm"): void;
  setWsActive(n: number): void;
  /** Render the current snapshot in Prometheus text format. */
  render(now?: number): string;
  /** Reset all counters — test hook. */
  _reset(): void;
}

export interface CreateMetricsOptions {
  /** The PtyMap to read live gauge state from. */
  map: PtyMap;
  /** Epoch ms at server start (for uptime_seconds). */
  startedAt: number;
  /** Clock override for tests. */
  clock?: () => number;
}

export function createMetrics(opts: CreateMetricsOptions): CompanionMetrics {
  let spawnedTotal = 0;
  const reapedTotal: Record<string, number> = {
    "ws-closed-idle": 0,
    "explicit-close": 0,
    sigterm: 0,
  };
  let wsActive = 0;
  const clock = opts.clock ?? (() => Date.now());

  return {
    incrementSpawned() {
      spawnedTotal++;
    },
    incrementReaped(reason) {
      reapedTotal[reason] = (reapedTotal[reason] ?? 0) + 1;
    },
    setWsActive(n) {
      wsActive = n;
    },
    render(now = clock()) {
      const uptimeSec = Math.floor((now - opts.startedAt) / 1000);
      const lines: string[] = [];
      lines.push("# HELP companion_ptys_active Currently-alive PTYs in the registry.");
      lines.push("# TYPE companion_ptys_active gauge");
      lines.push(`companion_ptys_active ${opts.map.countActive()}`);

      lines.push("# HELP companion_ptys_spawned_total Total PTYs spawned since boot.");
      lines.push("# TYPE companion_ptys_spawned_total counter");
      lines.push(`companion_ptys_spawned_total ${spawnedTotal}`);

      lines.push("# HELP companion_ptys_reaped_total PTYs reaped since boot, by reason.");
      lines.push("# TYPE companion_ptys_reaped_total counter");
      for (const [reason, n] of Object.entries(reapedTotal)) {
        lines.push(`companion_ptys_reaped_total{reason="${reason}"} ${n}`);
      }

      lines.push("# HELP companion_ws_active Currently-attached WebSocket connections.");
      lines.push("# TYPE companion_ws_active gauge");
      lines.push(`companion_ws_active ${wsActive}`);

      lines.push("# HELP companion_uptime_seconds Seconds since the Companion booted.");
      lines.push("# TYPE companion_uptime_seconds gauge");
      lines.push(`companion_uptime_seconds ${uptimeSec}`);

      lines.push(
        "# HELP companion_pty_last_io_seconds_ago Seconds since last I/O for each live PTY."
      );
      lines.push("# TYPE companion_pty_last_io_seconds_ago gauge");
      opts.map.forEach((entry) => {
        const ago = Math.max(0, Math.floor((now - entry.lastIoAt) / 1000));
        // Escape label values for Prometheus text format.
        const ptyLabel = entry.pty_id.replace(/["\\\n]/g, "_");
        const ticketLabel = entry.ticket_id.replace(/["\\\n]/g, "_");
        lines.push(
          `companion_pty_last_io_seconds_ago{pty_id="${ptyLabel}",ticket_id="${ticketLabel}"} ${ago}`
        );
      });

      return lines.join("\n") + "\n";
    },
    _reset() {
      spawnedTotal = 0;
      for (const k of Object.keys(reapedTotal)) reapedTotal[k] = 0;
      wsActive = 0;
    },
  };
}
