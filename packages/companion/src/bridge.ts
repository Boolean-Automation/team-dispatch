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

/**
 * If the PTY exits with a nonzero code THIS soon after spawn, it never really
 * ran — `claude` was missing, PATH was wrong, or the cwd was invalid.
 * `node-pty` does not throw synchronously for that case on every platform; it
 * returns an IPty and fires a near-immediate failure `onExit` instead. An
 * interactive `claude` does not exit within this window — it sits waiting for
 * input — so a nonzero, unsignalled exit inside it is a spawn failure. The
 * bridge surfaces it as a typed `error` frame (ADR-001 "never hard-fail" — the
 * panel must reach `claude-unusable`, not a bare `exit`).
 */
export const EARLY_EXIT_GRACE_MS = 1_500;

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
 * Classify a `claude` spawn failure into the protocol `error` code that fits.
 *
 * A `node-pty` spawn throw is the ADR-001 "never hard-fail" boundary: the
 * Companion must degrade, not crash. `EACCES` (and friends) means the binary
 * was found but could not be executed — a permission refusal, which maps to
 * `local-permission-denied`. Everything else — `claude` missing, a bad PATH,
 * an invalid `cwd`, or any other `node-pty` throw — maps to `claude-unusable`:
 * the Companion is up but cannot start a usable `claude` session.
 */
function classifySpawnFailure(err: unknown): "claude-unusable" | "local-permission-denied" {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  return code === "EACCES" || code === "EPERM"
    ? "local-permission-denied"
    : "claude-unusable";
}

/**
 * One bridged session. Wires a PtySession to a WebSocket. The bridge owns the
 * teardown discipline — every exit path (socket close, PTY exit, idle timeout)
 * routes through `teardown()` exactly once.
 */
export class BridgeSession {
  /**
   * The PTY session — `undefined` when the `claude` spawn failed (ADR-001
   * "never hard-fail": a spawn throw is caught, surfaced as a typed `error`
   * frame, and the Companion stays alive — see the constructor).
   */
  readonly session: PtySession | undefined;

  private readonly ws: WebSocket;
  private readonly idleTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private tornDown = false;
  /** Wall-clock spawn time — used to detect a near-immediate failure exit. */
  private readonly spawnedAt = Date.now();

  constructor(ws: WebSocket, opts: BridgeSessionOptions) {
    this.ws = ws;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    // Spawn the PTY (claude, direct argv, own process group).
    //
    // ADR-001 "never hard-fail" — TWO failure shapes are handled:
    //   1. A SYNCHRONOUS throw from `nodePty.spawn(...)` (a `node-pty` native
    //      load error, or a `posix_spawnp` failure on some platforms). An
    //      uncaught throw here escapes the `wss.handleUpgrade` callback and can
    //      crash the whole Companion — so it is caught below.
    //   2. A near-immediate failure `onExit` — on macOS `node-pty` does NOT
    //      throw for a missing `claude` / bad PATH / invalid cwd; it returns an
    //      IPty and fires `onExit` with a nonzero code milliseconds later. That
    //      is handled in the `onExit` callback (see `handlePtyExit`).
    // Either way the client gets a typed `error` frame (the code the web panel
    // routes into `claude-unusable` / `local-permission-denied`), THIS socket
    // is closed cleanly, and the Companion process stays alive for the next
    // connection. A crash is converted into a degraded single session.
    let session: PtySession;
    try {
      session = new PtySession(opts.pty, {
        onData: (chunk) => this.sendFrame({ t: "data", d: chunk }),
        onExit: (exitCode, signal) => this.handlePtyExit(exitCode, signal),
      });
    } catch (err) {
      this.session = undefined;
      const code = classifySpawnFailure(err);
      this.sendFrame({
        t: "error",
        code,
        msg: "the Companion could not start a claude session",
      });
      // Tear down: no timers were armed, so this just closes the socket. The
      // Companion process is untouched — it serves the next connection.
      this.teardown("spawn-failed");
      console.error(`[companion] claude spawn failed (${code})`);
      return;
    }
    this.session = session;

    // Handshake — session-meta carries the protocol + companion version.
    this.sendFrame({
      t: "session-meta",
      sessionId: session.sessionId,
      cmd: session.spawnedArgv.join(" "),
      protocolVersion: PROTOCOL_VERSION,
      companionVersion: COMPANION_VERSION,
    });

    // Context injection — the Ticket+Account preamble is the first PTY write.
    session.write(buildContextPreamble(opts.context));

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
        session.write(frame.d);
      } else {
        session.resize(frame.cols, frame.rows);
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
    // `session` is undefined when the `claude` spawn itself failed — there is
    // no PTY to kill, only the socket to close.
    this.session?.kill();

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

  /**
   * The PTY process exited. Distinguish a real session end from a failed spawn:
   * a nonzero, unsignalled exit within the early-exit grace window means
   * `claude` never actually ran (missing binary / bad PATH / invalid cwd) —
   * surface it as a typed `error` frame so the panel reaches `claude-unusable`,
   * not a bare `exit` (ADR-001 "never hard-fail"). Otherwise it is a normal
   * `exit`.
   */
  private handlePtyExit(exitCode: number, signal: number | null): void {
    // A signalled exit means the process was killed (teardown / OS) — that is
    // not a spawn failure. A spawn failure is a nonzero *exit code*, with no
    // signal, within the early-exit grace window — an interactive `claude`
    // does not exit that fast on its own.
    const earlyFailure =
      exitCode !== 0 &&
      (signal === null || signal === 0) &&
      Date.now() - this.spawnedAt < EARLY_EXIT_GRACE_MS;
    if (earlyFailure) {
      this.sendFrame({
        t: "error",
        code: "claude-unusable",
        msg: "the Companion could not start a claude session",
      });
      console.error("[companion] claude exited immediately (claude-unusable)");
    } else {
      this.sendFrame({ t: "exit", exitCode, signal });
    }
    this.teardown("pty-exit");
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
