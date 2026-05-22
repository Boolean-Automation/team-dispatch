/**
 * dispatch Companion — the bridge (Phase 2, multi-PTY).
 *
 * One WebSocket per browser window (singleton, Codex F2). The connection is
 * authenticated against a (user, ticket) scope at the WS upgrade boundary
 * (auth.ts). After upgrade the bridge:
 *   - mints a `connectionId` ULID and stamps it on every PTY this connection
 *     opens (the per-frame ownership check, Codex F2);
 *   - sends the `hello` frame carrying protocolVersion + companionVersion +
 *     capabilities[] + companion_started_at (epoch ms — clients detect a
 *     Companion restart by comparing this against their cached value);
 *   - duplexes pty.open / pty.write / pty.resize / pty.close ↔ pty.opened /
 *     pty.data / pty.exit / pty.error through the singleton pty-map;
 *   - runs a per-connection heartbeat (ping every 30s, no pong within 10s →
 *     close with code 4409 → pty-map.markDetached → sweeper takes over);
 *   - on WS close OR error, calls pty-map.markDetached(connectionId) to stamp
 *     `wsClosedAt` on the connection's PTYs. The sweeper reaps them after
 *     idleMs.
 *
 * The bridge does NOT directly own a `Set<BridgeSession>` (the Spike #1
 * shape). It pushes/pulls through `pty-map` so the registry is the single
 * source of truth across multiple bridges in a single Companion.
 */

import type { WebSocket } from "ws";
import { ulid } from "ulid";
import { PtySession } from "./pty-session.js";
import {
  parseClientFrame,
  PROTOCOL_VERSION,
  COMPANION_VERSION,
} from "./protocol.js";
import type { ServerFrame, PtyErrorCode } from "./protocol.js";
import { COMPANION_CAPABILITIES } from "./capabilities.js";
import type { PtyMap } from "./pty-map.js";
import type { CompanionConfig } from "./config.js";

/** Heartbeat: ping the WS this often. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Heartbeat: close the WS if no pong within this many ms of a sent ping. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** WS close code for "heartbeat failed" — bridges to pty-map.markDetached. */
export const HEARTBEAT_FAILED_CODE = 4409;

/** WS close code for "auth failure" — used by the per-frame ownership reject. */
export const AUTH_FAILED_CODE = 4401;

export interface BridgeContext {
  /** The pty-map singleton. */
  ptyMap: PtyMap;
  /** Companion config (cwd, timing, env, etc.). */
  config: CompanionConfig;
  /** Epoch ms at Companion server start — surfaced in the hello frame. */
  companionStartedAt: number;
  /** The Ticket id this connection was authed for. */
  ticketId: string;
  /** Optional: invoked when a PTY is spawned (metrics hook). */
  onPtySpawned?: () => void;
}

/** Per-connection state — owned by the bridge for the connection lifetime. */
export interface BridgeConnection {
  /** ULID minted at upgrade — the per-frame ownership key. */
  connectionId: string;
  /** Whether the bridge has closed and detached its PTYs from the WS. */
  closed: boolean;
}

/**
 * Wire a freshly-authed WebSocket into the pty-map and protocol surface.
 * Returns the connection handle so main.ts can include it in the metrics
 * `companion_ws_active` gauge.
 */
export function attachBridge(
  ws: WebSocket,
  ctx: BridgeContext
): BridgeConnection {
  const connection: BridgeConnection = {
    connectionId: ulid(),
    closed: false,
  };

  let heartbeatTimer: NodeJS.Timeout | undefined;
  let pongDeadline: NodeJS.Timeout | undefined;

  function sendFrame(frame: ServerFrame): void {
    // ws readyState 1 === OPEN.
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* socket dying */
      }
    }
  }

  function sendError(
    code: PtyErrorCode,
    pty_id?: string,
    detail?: string,
    request_id?: string | null
  ): void {
    // P1-2 (gate-review.md): when the error is scoped to a specific client
    // request (an in-flight `pty.open`), we echo the originating request_id so
    // the client's pendingOpens Map can route the rejection to the exact
    // promise that sent it. Broadcast errors (bad-frame, frame-too-large,
    // unknown-pty for a non-open frame) leave request_id absent.
    const base: ServerFrame = pty_id
      ? { t: "pty.error", code, pty_id }
      : { t: "pty.error", code };
    if (detail) (base as { detail?: string }).detail = detail;
    if (request_id !== undefined) {
      (base as { request_id?: string | null }).request_id = request_id;
    }
    sendFrame(base);
  }

  function teardown(reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    void reason;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (pongDeadline) {
      clearTimeout(pongDeadline);
      pongDeadline = undefined;
    }

    // Stamp wsClosedAt on every PTY this connection owns. The sweeper reaps
    // after `idleMs`. We do NOT kill the PTYs synchronously here — a network
    // blip / tab reload that re-opens the same window before idleMs lets the
    // shells survive (Phase 2 is "no resume across Companion restart" but
    // within a single Companion process the WS may briefly drop).
    ctx.ptyMap.markDetached(connection.connectionId);

    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  // ── Handshake ───────────────────────────────────────────────────────────
  sendFrame({
    t: "hello",
    protocolVersion: PROTOCOL_VERSION,
    companionVersion: COMPANION_VERSION,
    capabilities: [...COMPANION_CAPABILITIES],
    companion_started_at: ctx.companionStartedAt,
  });

  // ── Frame dispatch ──────────────────────────────────────────────────────
  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : raw.toString();
    const parsed = parseClientFrame(text);
    if (!parsed.ok) {
      sendError(parsed.code, undefined, parsed.msg);
      return;
    }
    const frame = parsed.frame;

    switch (frame.t) {
      case "pty.open": {
        // P1-2: capture the client's correlation id (may be undefined for
        // older clients). Echoed back on the pty.opened OR pty.error response
        // so the client's pendingOpens map can route the resolution to the
        // exact promise that sent the open.
        const requestId = frame.request_id ?? null;
        // Phase 2 binding: the ticket the client names in `pty.open` MUST
        // match the ticket the connection was authed for. A token minted for
        // ticket X cannot drive a PTY for ticket Y.
        if (frame.ticket_id !== ctx.ticketId) {
          sendError("not-authed", undefined, "ticket mismatch", requestId);
          return;
        }
        void (async () => {
          const result = await ctx.ptyMap.open({
            ticket_id: frame.ticket_id,
            ownerConnectionId: connection.connectionId,
            // P1-1 fix (gate-review.md): if the WS closed while we were
            // awaiting the per-ticket mutex (markDetached already ran but
            // found no entries to stamp), the new entry would otherwise keep
            // wsClosedAt: null forever. `connection.closed` flips inside
            // `teardown()` which fires on ws.close / ws.error / heartbeat
            // failure / auth reject — every path that calls markDetached.
            isConnectionAttached: (cid) =>
              cid === connection.connectionId && !connection.closed,
            spawn: ({ pty_id }) => {
              // Spawn the real PTY. PtySession's handlers route PTY output
              // back over THIS WebSocket as `pty.data` frames carrying the
              // pty_id, and a final `pty.exit` on process termination.
              const session: PtySession = new PtySession(
                {
                  cwd: ctx.config.knowledgeRoot,
                  env: process.env,
                  killGraceMs: ctx.config.killGraceMs,
                },
                {
                  onData: (chunk) => {
                    sendFrame({ t: "pty.data", pty_id, bytes: chunk });
                  },
                  onExit: (code, signal) => {
                    sendFrame({
                      t: "pty.exit",
                      pty_id,
                      code,
                      signal: signal === null ? null : String(signal),
                    });
                    // Remove the entry so a re-`pty.open` is required.
                    ctx.ptyMap.delete(pty_id);
                  },
                }
              );
              return session;
            },
          });
          if (!result.ok) {
            // P1-2: echo the request_id so the client routes the error to
            // the EXACT pending-open it correlates with — not to whichever
            // pending happens to be first/last in a FIFO queue.
            sendError(result.error, undefined, undefined, requestId);
            return;
          }
          ctx.onPtySpawned?.();
          // P1-2: echo the request_id on success too so the client's Map can
          // resolve the matching promise.
          sendFrame({
            t: "pty.opened",
            pty_id: result.pty_id,
            request_id: requestId,
          });
        })();
        break;
      }

      case "pty.write": {
        const res = ctx.ptyMap.write(
          frame.pty_id,
          frame.data,
          connection.connectionId
        );
        if (!res.ok) {
          sendError(res.error, frame.pty_id);
          if (res.error === "not-authed") {
            // Per spec §S1: a per-frame ownership reject closes the WS with
            // 4401. Stamps wsClosedAt via markDetached in teardown().
            try {
              ws.close(AUTH_FAILED_CODE, "not-authed");
            } catch {
              /* */
            }
            teardown("auth-failed");
          }
        }
        break;
      }

      case "pty.resize": {
        const res = ctx.ptyMap.resize(
          frame.pty_id,
          frame.cols,
          frame.rows,
          connection.connectionId
        );
        if (!res.ok) sendError(res.error, frame.pty_id);
        break;
      }

      case "pty.close": {
        const res = ctx.ptyMap.close(frame.pty_id, connection.connectionId);
        if (!res.ok) sendError(res.error, frame.pty_id);
        break;
      }
    }
  });

  // ── Heartbeat (ping/pong) ───────────────────────────────────────────────
  function armPongDeadline(): void {
    if (pongDeadline) clearTimeout(pongDeadline);
    pongDeadline = setTimeout(() => {
      // No pong within HEARTBEAT_TIMEOUT_MS — half-open WS. Close with 4409.
      try {
        ws.close(HEARTBEAT_FAILED_CODE, "heartbeat-failed");
      } catch {
        /* */
      }
      teardown("heartbeat-timeout");
    }, HEARTBEAT_TIMEOUT_MS);
    pongDeadline.unref?.();
  }

  heartbeatTimer = setInterval(() => {
    if (ws.readyState === 1) {
      try {
        ws.ping();
        armPongDeadline();
      } catch {
        /* socket dying — close handler will reap */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  ws.on("pong", () => {
    if (pongDeadline) {
      clearTimeout(pongDeadline);
      pongDeadline = undefined;
    }
  });

  ws.on("close", () => teardown("ws-close"));
  ws.on("error", () => teardown("ws-error"));

  return connection;
}
