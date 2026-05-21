/**
 * dispatch Companion — PTY session lifecycle.
 *
 * Wraps `node-pty` around the SE's own `claude` CLI. The security-critical
 * properties (Codex P1-3 / P1-4, spec §3.1.1 / §3.1.7):
 *
 *   - DIRECT `claude` ARGV — the PTY hosts `claude` itself via a direct argv
 *     array. NO `/bin/bash -lc claude`, NO `sh -c`, no shell wrapper of any
 *     kind. A shell wrapper turns this into a browser-to-shell bridge and
 *     leaves a live shell prompt after `claude` exits.
 *   - OWN PROCESS GROUP — the PTY is spawned in its own process group so
 *     teardown can kill the whole tree (`claude` + any child / grandchild),
 *     not just the PTY leader. node-pty's UnixTerminal calls `setsid()` for
 *     the child, so the child's PID is also its process-group id (PGID).
 *   - PROCESS-GROUP KILL + TERM→KILL ESCALATION — teardown sends SIGTERM to
 *     the whole group (`process.kill(-pid, ...)`), waits a short grace window,
 *     then escalates to SIGKILL if the tree has not exited. No orphaned
 *     `claude`, shell, or child process leaks.
 *   - ALLOWLISTED ENV — the PTY is spawned with an explicit, narrow env built
 *     from a fixed allowlist (`buildPtyEnv`), NOT the Companion's full
 *     `process.env`. `claude` is browser-driven and has full local tool power,
 *     so it must never see `COMPANION_TOKEN_SECRET` (the HS256 key signing
 *     every connection token) or any other Companion secret — a leaked signing
 *     key lets the session forge valid tokens for any SE/ticket. The allowlist
 *     passes through only what `claude` needs to resolve on PATH and
 *     authenticate from the SE's own `~/.claude` config (via `HOME`). The
 *     bridge supplies NO Anthropic credential itself (ADR-001 invariant).
 *   - The `cwd` is the boolean-knowledge repo root.
 */

import crypto from "node:crypto";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";

/** The terminal teardown escalates SIGTERM → SIGKILL after this grace window. */
export const KILL_GRACE_MS = 1500;

/**
 * Env var NAMES `claude` genuinely needs to run and authenticate from the SE's
 * own local config. Everything else — most importantly `COMPANION_TOKEN_SECRET`
 * and any other Companion secret — is dropped. `claude` authenticates from
 * `~/.claude` (resolved via `HOME`), so no Anthropic credential is needed in
 * this list and none is added.
 */
export const PTY_ENV_ALLOWLIST: readonly string[] = [
  "PATH", // resolve the `claude` binary
  "HOME", // `claude` reads its credentials/config from ~/.claude
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "TZ",
  "COLORTERM",
];

/**
 * Prefixes for env var names that are also safe to pass through (locale group).
 * `LC_ALL`, `LC_CTYPE`, etc. all govern locale and carry no secret.
 */
const PTY_ENV_ALLOWED_PREFIXES: readonly string[] = ["LC_"];

/**
 * Build the narrow, allowlisted env for the spawned `claude` PTY from a source
 * env (the Companion's `process.env`). Only names on `PTY_ENV_ALLOWLIST` or
 * matching an allowed prefix are carried through; `COMPANION_TOKEN_SECRET` and
 * every other non-allowlisted var — secret or not — is dropped. Undefined
 * values are skipped so the result is a clean `Record<string, string>`.
 */
export function buildPtyEnv(
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed =
      PTY_ENV_ALLOWLIST.includes(key) ||
      PTY_ENV_ALLOWED_PREFIXES.some((p) => key.startsWith(p));
    if (allowed) env[key] = value;
  }
  return env;
}

/** Options for spawning a Companion PTY session. */
export interface PtySessionOptions {
  /** The `claude` binary name or absolute path. Default: "claude". */
  claudeBin?: string;
  /** Extra argv passed to `claude` (the spike spawns interactive `claude`). */
  claudeArgs?: readonly string[];
  /** cwd — the boolean-knowledge repo root. */
  cwd: string;
  /**
   * Source environment — typically the Companion's `process.env`. It is NOT
   * passed to `claude` as-is: `PtySession` runs it through `buildPtyEnv`, which
   * keeps only the `PTY_ENV_ALLOWLIST` names and drops every Companion secret
   * (`COMPANION_TOKEN_SECRET` in particular). `claude` still resolves on PATH
   * and authenticates from `~/.claude` via `HOME`.
   */
  env: NodeJS.ProcessEnv;
  /** Initial PTY size. */
  cols?: number;
  rows?: number;
  /**
   * Spawn function — injectable for tests so a unit test can exercise the
   * lifecycle (process-group kill, TERM→KILL) against a cheap child instead of
   * a real `claude`. Defaults to node-pty's `spawn`.
   */
  spawnFn?: typeof nodePty.spawn;
}

/** Events a PtySession surfaces to the bridge. */
export interface PtySessionHandlers {
  /** PTY produced output bytes. */
  onData: (chunk: string) => void;
  /** The PTY process exited. */
  onExit: (exitCode: number, signal: number | null) => void;
}

/**
 * A live PTY session: `claude` running in a PTY, in its own process group.
 * The bridge owns one of these per accepted WebSocket connection.
 */
export class PtySession {
  /** 8-hex session id surfaced in the `session-meta` frame ("5a82"-style). */
  readonly sessionId: string;

  /** The argv actually spawned — surfaced for A7b PID/argv evidence. */
  readonly spawnedArgv: readonly string[];

  private readonly pty: IPty;
  private killed = false;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(opts: PtySessionOptions, handlers: PtySessionHandlers) {
    this.sessionId = crypto.randomBytes(4).toString("hex");

    const claudeBin = opts.claudeBin ?? "claude";
    const claudeArgs = opts.claudeArgs ? [...opts.claudeArgs] : [];
    this.spawnedArgv = [claudeBin, ...claudeArgs];

    const spawn = opts.spawnFn ?? nodePty.spawn;

    // DIRECT argv — `claude` is the file, claudeArgs are its argv. No shell.
    // node-pty's UnixTerminal calls setsid() so the child leads its own
    // process group; killing the negated PID reaches the whole tree.
    // ALLOWLISTED ENV — `buildPtyEnv` strips COMPANION_TOKEN_SECRET (and every
    // other non-allowlisted var) so the browser-driven `claude` can never read
    // the token-signing key out of its own environment.
    this.pty = spawn(claudeBin, claudeArgs, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: buildPtyEnv(opts.env),
    });

    this.pty.onData((chunk) => {
      handlers.onData(chunk);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.clearKillTimer();
      handlers.onExit(exitCode, signal ?? null);
    });
  }

  /** The OS pid of the PTY leader (`claude`). Also its process-group id. */
  get pid(): number {
    return this.pty.pid;
  }

  /** Write bytes (keystrokes / context preamble) into the PTY. */
  write(data: string): void {
    if (this.killed) return;
    this.pty.write(data);
  }

  /** Resize the PTY — driven by the panel's FitAddon → `resize` frame. */
  resize(cols: number, rows: number): void {
    if (this.killed) return;
    if (cols > 0 && rows > 0) {
      this.pty.resize(cols, rows);
    }
  }

  /**
   * Tear the session down: a process-GROUP kill of the whole `claude` tree
   * with a SIGTERM → SIGKILL escalation. Idempotent.
   *
   * Sends SIGTERM to the negated pid (the process group) so `claude` plus any
   * child / grandchild it spawned all receive it. If the group has not exited
   * within KILL_GRACE_MS, escalates to SIGKILL on the group.
   */
  kill(): void {
    if (this.killed) return;
    this.killed = true;

    const pgid = this.pty.pid;

    // Graceful TERM to the whole process group.
    this.signalGroup(pgid, "SIGTERM");

    // Escalation: forced KILL if the tree is still alive after the grace window.
    this.killTimer = setTimeout(() => {
      this.signalGroup(pgid, "SIGKILL");
      // node-pty also gets an explicit kill of the leader as a backstop.
      try {
        this.pty.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, KILL_GRACE_MS);
    // Do not keep the event loop alive solely for the escalation timer.
    this.killTimer.unref?.();
  }

  /** Whether `kill()` has been called. */
  get isKilled(): boolean {
    return this.killed;
  }

  private signalGroup(pgid: number, signal: NodeJS.Signals): void {
    // Negative pid = the process group. This is the whole-tree kill.
    try {
      process.kill(-pgid, signal);
    } catch {
      // The group may already be gone, or (rare) not be a group leader —
      // fall back to signalling node-pty's leader directly.
      try {
        this.pty.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  private clearKillTimer(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
  }
}
