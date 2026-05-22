/**
 * dispatch Companion — PTY session lifecycle (Phase 2).
 *
 * Wraps `node-pty` around the SE's own login shell — `$SHELL -l` (default
 * `/bin/zsh -l`). The security-critical properties carry forward from Spike #1
 * and were re-PROVEN by the Phase 2 prototype (probe 3, `probe3-pty-shell.json`):
 *
 *   - DIRECT `$SHELL` ARGV — the PTY hosts `$SHELL -l` itself via a direct
 *     argv array. NO `/bin/bash -lc` wrapper, no `sh -c` wrapping. A shell
 *     wrapper turns the bridge into a browser-to-shell bridge that the SE's
 *     login profile cannot fully define (the `-l` flag sources their
 *     `.zshenv`/`.zprofile`/`.zshrc` chain so PATH is what their own terminal
 *     sees).
 *   - OWN PROCESS GROUP — the PTY is spawned in its own process group so
 *     teardown can kill the whole tree (`$SHELL` + any child / grandchild),
 *     not just the PTY leader. node-pty's UnixTerminal calls `setsid()` for
 *     the child, so the child's PID is also its process-group id (PGID).
 *   - PROCESS-GROUP KILL + TERM→KILL ESCALATION — teardown sends SIGTERM to
 *     the whole group (`process.kill(-pid, ...)`), waits a short grace window,
 *     then escalates to SIGKILL if the tree has not exited. No orphaned
 *     shell, command, or child process leaks.
 *   - ALLOWLISTED + DENY-FENCED ENV — the PTY is spawned with an explicit
 *     allowlist (`buildPtyEnv`), then a deny-suffix check strips anything
 *     matching `*_SECRET`, `*_KEY`, `*_TOKEN`, `*_PASSWORD` AND explicit
 *     `ANTHROPIC_*`, `CLAUDE_*`, `OP_SERVICE_ACCOUNT_TOKEN`, `CLERK_*`,
 *     `COMPANION_TOKEN_SECRET`, `SLACK_*_TOKEN`. Pin `TERM=xterm-256color`
 *     to advertise 24-bit color regardless of inherited TERM.
 *   - The `cwd` is the boolean-knowledge repo root (configurable).
 *
 * Phase 2 also tracks per-PTY `lastIoAt` and `wsClosedAt` for the
 * pty-map registry the idle sweeper reads.
 */

import crypto from "node:crypto";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";

/** SIGTERM → SIGKILL grace (PtySession internal). Override via config.killGraceMs. */
export const KILL_GRACE_MS = 3_000;

/**
 * Env var NAMES the spawned `$SHELL -l` genuinely needs. The login flag
 * sources the SE's profile chain so most of PATH is rebuilt by the shell
 * itself; the allowlist carries the names the shell EXPECTS to find already
 * set when it boots.
 *
 * Phase 2 widens Spike #1's narrow set for shell ergonomics — PS1, ZDOTDIR,
 * EDITOR, PAGER, TERM_PROGRAM — and adds the XDG_* group. The deny-list
 * (below) is applied on top so secrets cannot survive even if they happen to
 * match an allowed prefix.
 */
export const PTY_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
  "TZ",
  "COLORTERM",
  "PS1",
  "ZDOTDIR",
  "EDITOR",
  "PAGER",
  "TERM_PROGRAM",
  "PATH",
];

/** Prefix-allowed groups (XDG, LC). */
export const PTY_ENV_ALLOWED_PREFIXES: readonly string[] = ["XDG_", "LC_"];

/**
 * Deny-suffix fence — applied AFTER the allowlist. ANY name matching one of
 * these patterns is dropped regardless of whether it survived the allowlist.
 * Double-fence: the allowlist is supposed to keep secrets out, but a typo in
 * the allowlist (e.g. someone adds `AWS_SECRET_ACCESS_KEY` thinking it's
 * "fine") still gets caught here.
 */
export const PTY_ENV_DENY_SUFFIXES: readonly string[] = [
  "_SECRET",
  "_KEY",
  "_TOKEN",
  "_PASSWORD",
];

/** Deny-prefix fence — explicit Anthropic / Claude / Op / Clerk / Slack groups. */
export const PTY_ENV_DENY_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CLERK_",
  "SLACK_",
];

/** Deny-exact fence — specific names that don't match the patterns above. */
export const PTY_ENV_DENY_EXACT: readonly string[] = [
  "OP_SERVICE_ACCOUNT_TOKEN",
  "COMPANION_TOKEN_SECRET",
  "CLERK_SECRET_KEY",
  "CLERK_PUBLISHABLE_KEY",
];

function isDenied(key: string): boolean {
  if (PTY_ENV_DENY_EXACT.includes(key)) return true;
  if (PTY_ENV_DENY_PREFIXES.some((p) => key.startsWith(p))) return true;
  if (PTY_ENV_DENY_SUFFIXES.some((s) => key.endsWith(s))) return true;
  return false;
}

/**
 * Build the narrow, allowlisted-then-deny-fenced env for the spawned `$SHELL`
 * PTY from a source env (the Companion's `process.env`). Pins
 * `TERM=xterm-256color` last so any inherited TERM (e.g. `dumb` from a daemon
 * parent) is overridden — the panel renders 24-bit color.
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
    if (!allowed) continue;
    if (isDenied(key)) continue;
    env[key] = value;
  }
  // Pin TERM=xterm-256color last — overrides any inherited TERM. The Phase 2
  // panel relies on 24-bit-color advertisement (spec §3.3).
  env.TERM = "xterm-256color";
  return env;
}

/** Options for spawning a Companion PTY session. */
export interface PtySessionOptions {
  /**
   * The shell binary to spawn. Default: `process.env.SHELL || '/bin/zsh'`.
   * Phase 2 spawns `$SHELL -l` directly — no shell wrapper.
   */
  shellBin?: string;
  /**
   * Extra argv passed to the shell. Default: `['-l']` (login shell).
   * Tests may override (e.g. for `/bin/sh -c 'sleep 30'` lifecycle tests).
   */
  shellArgs?: readonly string[];
  /** cwd — the boolean-knowledge repo root. */
  cwd: string;
  /**
   * Source environment — typically the Companion's `process.env`. It is NOT
   * passed to `$SHELL` as-is: `PtySession` runs it through `buildPtyEnv`,
   * which applies the allowlist + deny-fence.
   */
  env: NodeJS.ProcessEnv;
  /** Initial PTY size. */
  cols?: number;
  rows?: number;
  /** SIGTERM → SIGKILL grace override. */
  killGraceMs?: number;
  /**
   * Spawn function — injectable for tests so a unit test can exercise the
   * lifecycle (process-group kill, TERM→KILL) against a cheap child instead of
   * a real shell. Defaults to node-pty's `spawn`.
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
 * A live PTY session: `$SHELL -l` running in a PTY, in its own process group.
 * The bridge owns one of these per `pty.open` frame; the pty-map owns the
 * registry.
 */
export class PtySession {
  /** 8-hex session id surfaced for debugging / metrics ("5a82"-style). */
  readonly sessionId: string;

  /** The argv actually spawned — surfaced for L1 PID/argv evidence. */
  readonly spawnedArgv: readonly string[];

  private readonly pty: IPty;
  private readonly killGraceMs: number;
  private killed = false;
  private killTimer: NodeJS.Timeout | undefined;

  constructor(opts: PtySessionOptions, handlers: PtySessionHandlers) {
    this.sessionId = crypto.randomBytes(4).toString("hex");
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;

    // PROVEN by prototype probe 3: `process.env.SHELL || '/bin/zsh'` with
    // argv `['-l']` exactly. Tests inject `/bin/sh -c '...'` for lifecycle
    // assertions; production gets the SE's login shell.
    const shellBin = opts.shellBin ?? process.env.SHELL ?? "/bin/zsh";
    const shellArgs = opts.shellArgs ? [...opts.shellArgs] : ["-l"];
    this.spawnedArgv = [shellBin, ...shellArgs];

    const spawn = opts.spawnFn ?? nodePty.spawn;

    // DIRECT argv — `$SHELL` is the file, shellArgs are its argv. No shell
    // wrapper. node-pty's UnixTerminal calls setsid() so the child leads its
    // own process group; killing the negated PID reaches the whole tree.
    // ALLOWLISTED + DENY-FENCED ENV — `buildPtyEnv` strips
    // COMPANION_TOKEN_SECRET, ANTHROPIC_*, CLAUDE_*, *_SECRET, etc.
    this.pty = spawn(shellBin, [...shellArgs], {
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

  /** The OS pid of the PTY leader (`$SHELL`). Also its process-group id. */
  get pid(): number {
    return this.pty.pid;
  }

  /** Write bytes (keystrokes) into the PTY. */
  write(data: string): void {
    if (this.killed) return;
    this.pty.write(data);
  }

  /** Resize the PTY — driven by the panel's FitAddon → `pty.resize` frame. */
  resize(cols: number, rows: number): void {
    if (this.killed) return;
    if (cols > 0 && rows > 0) {
      this.pty.resize(cols, rows);
    }
  }

  /**
   * Tear the session down: a process-GROUP kill of the whole shell tree
   * with a SIGTERM → SIGKILL escalation. Idempotent.
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
      try {
        this.pty.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, this.killGraceMs);
    this.killTimer.unref?.();
  }

  /** Whether `kill()` has been called. */
  get isKilled(): boolean {
    return this.killed;
  }

  private signalGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch {
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
