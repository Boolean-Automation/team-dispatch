/**
 * dispatch Companion — runtime configuration.
 *
 * Reads the Companion's env with safe defaults. Fails LOUD if the shared
 * connection-token secret is missing — the Companion must not start a
 * RCE-capable bridge with an unset / empty `COMPANION_TOKEN_SECRET`, because
 * an empty secret would verify any HS256 token.
 *
 * Env (documented in the repo `.env.example`):
 *   COMPANION_PORT          — fixed loopback port (OQ-S4). Default 7720.
 *   COMPANION_TOKEN_SECRET  — shared HS256 secret. The api mints, the Companion
 *                             verifies. REQUIRED — no default.
 *   BOOLEAN_KNOWLEDGE_ROOT  — repo root the Companion opens `$SHELL` at.
 *                             Default ~/boolean-knowledge.
 *   COMPANION_ALLOWED_ORIGINS — comma-separated strict exact-match Origin
 *                             allowlist. Default covers local Vite + the
 *                             production dispatch origin.
 *   MAX_PTYS_PER_TICKET     — per-ticket PTY cap. Default 3.
 *   SWEEPER_TICK_MS         — idle-sweeper interval. Default 10_000.
 *   SWEEPER_IDLE_MS         — reap threshold after WS drop. Default 60_000.
 *   SWEEPER_GRACE_PAUSE_MS  — SIGHUP → SIGTERM pause. Default 3_000.
 *   KILL_GRACE_MS           — SIGTERM → SIGKILL grace (PtySession-level).
 *                             Default 3_000.
 */

import os from "node:os";
import path from "node:path";

export interface CompanionConfig {
  /** Loopback port the WebSocket server + /healthz + /metrics bind to. */
  port: number;
  /** Loopback host — always 127.0.0.1, never 0.0.0.0. */
  host: "127.0.0.1";
  /** Shared HS256 secret for verifying backend-minted connection tokens. */
  tokenSecret: string;
  /** Repo root the Companion sets as `$SHELL`'s cwd. */
  knowledgeRoot: string;
  /** Strict exact-match Origin allowlist. An Origin not in this set is rejected. */
  allowedOrigins: readonly string[];
  /** Per-ticket PTY cap (Codex F2 / S1 plan). */
  maxPtysPerTicket: number;
  /** Idle-sweeper tick interval (ms). */
  sweeperTickMs: number;
  /** Idle threshold past `wsClosedAt` before reap (ms). */
  sweeperIdleMs: number;
  /** SIGHUP → SIGTERM grace pause (ms). */
  sweeperGracePauseMs: number;
  /** SIGTERM → SIGKILL grace (ms) — PtySession-level. */
  killGraceMs: number;
}

const DEFAULT_PORT = 7720;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://localhost:5173",
  "https://dispatch.paintos.app",
];

/** Defaults per S1 plan. */
export const DEFAULT_MAX_PTYS_PER_TICKET = 3;
export const DEFAULT_SWEEPER_TICK_MS = 10_000;
export const DEFAULT_SWEEPER_IDLE_MS = 60_000;
export const DEFAULT_SWEEPER_GRACE_PAUSE_MS = 3_000;
export const DEFAULT_KILL_GRACE_MS = 3_000;

function readIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} is invalid: ${raw}`);
  }
  return n;
}

/**
 * Build the Companion config from process.env.
 * @throws if COMPANION_TOKEN_SECRET is unset or empty.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CompanionConfig {
  const tokenSecret = env.COMPANION_TOKEN_SECRET;
  if (!tokenSecret || tokenSecret.trim().length === 0) {
    throw new Error(
      "COMPANION_TOKEN_SECRET is required and must be non-empty — the Companion " +
        "will not start a bridge that would verify any token. Generate: openssl rand -hex 32"
    );
  }

  const port = env.COMPANION_PORT ? Number(env.COMPANION_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`COMPANION_PORT is invalid: ${env.COMPANION_PORT}`);
  }

  const knowledgeRoot =
    env.BOOLEAN_KNOWLEDGE_ROOT ?? path.join(os.homedir(), "boolean-knowledge");

  const allowedOrigins = env.COMPANION_ALLOWED_ORIGINS
    ? env.COMPANION_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

  return {
    port,
    host: "127.0.0.1",
    tokenSecret,
    knowledgeRoot,
    allowedOrigins,
    maxPtysPerTicket: readIntEnv(env, "MAX_PTYS_PER_TICKET", DEFAULT_MAX_PTYS_PER_TICKET),
    sweeperTickMs: readIntEnv(env, "SWEEPER_TICK_MS", DEFAULT_SWEEPER_TICK_MS),
    sweeperIdleMs: readIntEnv(env, "SWEEPER_IDLE_MS", DEFAULT_SWEEPER_IDLE_MS),
    sweeperGracePauseMs: readIntEnv(
      env,
      "SWEEPER_GRACE_PAUSE_MS",
      DEFAULT_SWEEPER_GRACE_PAUSE_MS
    ),
    killGraceMs: readIntEnv(env, "KILL_GRACE_MS", DEFAULT_KILL_GRACE_MS),
  };
}
