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
 *   BOOLEAN_KNOWLEDGE_ROOT  — repo root the Companion opens `claude` at (OQ-S6).
 *                             Default ~/boolean-knowledge.
 *   COMPANION_ALLOWED_ORIGINS — comma-separated strict exact-match Origin
 *                             allowlist. Default covers local Vite + the
 *                             production dispatch origin.
 */

import os from "node:os";
import path from "node:path";

export interface CompanionConfig {
  /** Loopback port the WebSocket server + /healthz bind to. */
  port: number;
  /** Loopback host — always 127.0.0.1, never 0.0.0.0. */
  host: "127.0.0.1";
  /** Shared HS256 secret for verifying backend-minted connection tokens. */
  tokenSecret: string;
  /** Repo root the Companion sets as `claude`'s cwd. */
  knowledgeRoot: string;
  /** Strict exact-match Origin allowlist. An Origin not in this set is rejected. */
  allowedOrigins: readonly string[];
}

const DEFAULT_PORT = 7720;

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://localhost:5173",
  "https://dispatch.paintos.app",
];

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
  };
}
