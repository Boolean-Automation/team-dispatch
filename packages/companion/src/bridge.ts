/**
 * dispatch Companion — the bridge (headless core).
 *
 * Given an already-authed WebSocket connection, the bridge:
 *   - spawns a `PtySession` (the SE's `claude` in a PTY, own process group),
 *   - sends the `session-meta` handshake frame (carries protocolVersion +
 *     companionVersion — Codex P2),
 *   - injects the Ticket+Account context preamble as the session's first
 *     PTY write (OQ-S2),
 *   - duplexes PTY ↔ WebSocket as validated protocol frames,
 *   - runs a per-session heartbeat / idle timeout — a socket gone silent past
 *     the timeout (the half-open / laptop-sleep case) is torn down via the
 *     process-group kill; it does not linger (Codex P1-3),
 *   - tears the PTY down on socket close, on heartbeat timeout, and (via
 *     main.ts) on Companion SIGTERM.
 *
 * The bridge is the headless contract surface — `main.ts` is one thin consumer
 * of it; a future Companion MCP or CLI test client is another.
 */

import type { WebSocket } from "ws";
import { PtySession } from "./pty-session.js";
import type { PtySessionOptions } from "./pty-session.js";
import { buildContextPreamble } from "./context.js";
import type { TicketContext } from "./context.js";
import {
  parseClientFrame,
  COMPANION_VERSION,
  PROTOCOL_VERSION,
} from "./protocol.js";
import type { ServerFrame } from "./protocol.js";

/** A session goes idle if no inbound WS message arrives within this window. */
export const IDLE_TIMEOUT_MS = 90_000;

/** The bridge probes the socket with a ping on this interval. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface BridgeSessionOptions {
  /** PTY spawn options (cwd, env, claude bin/args, optional test spawnFn). */
  pty: PtySessionOptions;
  /** The Ticket + Account context to inject as the opening preamble. */
  context: TicketContext;
  /** Override the idle timeout — test hook. */
  idleTimeoutMs?: number;
  /** Override the heartbeat interval — test hook. */
  heartbeatIntervalMs?: number;
}

/**
 * One bridged session. Wires a PtySession to a WebSocket. The bridge owns the
 * teardown discipline — every exit path (socket close, PTY exit, idle timeout)
 * routes through `teardown()` exactly once.
 */
export class BridgeSession {
  readonly session: PtySession;

  private readonly ws: WebSocket;
  private readonly idleTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private tornDown = false;

  constructor(ws: WebSocket, opts: BridgeSessionOptions) {
    this.ws = ws;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    // Spawn the PTY (claude, direct argv, own process group).
    this.session = new PtySession(opts.pty, {
      onData: (chunk) => this.sendFrame({ t: "data", d: chunk }),
      onExit: (exitCode, signal) => {
        this.sendFrame({ t: "exit", exitCode, signal });
        this.teardown("pty-exit");
      },
    });

    // Handshake — session-meta carries the protocol + companion version.
    this.sendFrame({
      t: "session-meta",
      sessionId: this.session.sessionId,
      cmd: this.session.spawnedArgv.join(" "),
      protocolVersion: PROTOCOL_VERSION,
      companionVersion: COMPANION_VERSION,
    });

    // Context injection — the Ticket+Account preamble is the first PTY write.
    this.session.write(buildContextPreamble(opts.context));

    // WS → PTY: validated frames only.
    this.ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      this.touchIdle();
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : raw.toString();
      const result = parseClientFrame(text);
      if (!result.ok) {
        this.sendFrame({ t: "error", code: result.code, msg: result.msg });
        return;
      }
      const frame = result.frame;
      if (frame.t === "data") {
        this.session.write(frame.d);
      } else {
        this.session.resize(frame.cols, frame.rows);
      }
    });

    // A pong resets the idle clock — the socket is provably alive.
    this.ws.on("pong", () => this.touchIdle());

    // Socket closed (tab close, reload, browser kill) → tear the PTY down.
    this.ws.on("close", () => this.teardown("ws-close"));
    this.ws.on("error", () => this.teardown("ws-error"));

    this.startHeartbeat();
    this.armIdleTimer();
  }

  /** Tear the session down — process-group kill + timer cleanup. Idempotent. */
  teardown(_reason: string): void {
    if (this.tornDown) return;
    this.tornDown = true;

    this.clearIdleTimer();
    this.clearHeartbeat();

    // Process-group kill (whole `claude` tree) with TERM→KILL escalation.
    this.session.kill();

    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  /** Whether the session has been torn down. */
  get isTornDown(): boolean {
    return this.tornDown;
  }

  private sendFrame(frame: ServerFrame): void {
    // ws readyState 1 === OPEN.
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws.readyState === 1) {
        try {
          this.ws.ping();
        } catch {
          /* socket dying — idle timer will reap it */
        }
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private armIdleTimer(): void {
    this.idleTimer = setTimeout(() => {
      // No inbound traffic and no pong within the window — the socket is
      // half-open (laptop sleep / network drop). Reap it.
      this.teardown("idle-timeout");
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private touchIdle(): void {
    this.clearIdleTimer();
    if (!this.tornDown) this.armIdleTimer();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
