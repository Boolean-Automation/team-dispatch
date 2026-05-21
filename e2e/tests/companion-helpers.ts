// dispatch E2E — shared helpers for the Companion-bridge tests.
//
// The bridge e2e tests spawn the REAL @dispatch/companion server modules
// (the real auth.ts three-factor check, the real protocol.ts frame contract,
// the real bridge.ts PTY duplex) against a BENIGN PTY command — never an
// interactive `claude` session.
//
// CRITICAL — why a benign command, not `claude`:
//   CI has no `claude` auth and an interactive `claude` session never exits,
//   which would hang the test process. Interactive `claude` was proven by the
//   dev phase's one-off L1 evidence (the integration recordings). It is NOT a
//   CI test. These tests prove the BRIDGE — auth, the frame protocol, the PTY
//   pipe, resize — with a tiny deterministic shell program in the PTY instead.
//
// The Companion's process entry (main.ts) hardcodes `claudeBin: "claude"`, so
// for a deterministic CI test we wire the same real WebSocketServer +
// authenticateUpgrade + BridgeSession the production entry uses, but pass a
// benign `claudeBin`. That is the real bridge, end-to-end, minus only the
// choice of program hosted in the PTY.

import { createServer } from "node:http";
import type { Server, IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { authenticateUpgrade } from "../../packages/companion/src/auth.js";
import { BridgeSession } from "../../packages/companion/src/bridge.js";
import type { TicketContext } from "../../packages/companion/src/context.js";

/** A fixed test secret — both the mint helper and the bridge use this. */
export const TEST_SECRET = "e2e-companion-bridge-test-secret-do-not-use-in-prod";

/** The Origin the bridge accepts and the mint binds the token's audience to. */
export const TEST_ORIGIN = "http://localhost:5173";

// ── HS256 token mint — mirrors POST /api/companion/sessions ──────────────────
//
// The api route mints with `jsonwebtoken`; the Companion's auth.ts verifies
// with plain node:crypto. This helper mints the same compact HS256 JWS shape
// auth.ts expects, so the bridge tests exercise the real verify path without
// needing a live Fastify api + Clerk session.

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface MintOptions {
  ticketId: string;
  sessionId: string;
  /** Origin/audience the token is bound to. Defaults to TEST_ORIGIN. */
  aud?: string;
  /** Clerk user id claim. */
  sub?: string;
  /** TTL in seconds from now. Defaults to 60. A negative value mints expired. */
  ttlSeconds?: number;
  /** Override the signing secret — pass a wrong one to forge a bad token. */
  secret?: string;
  /** Override the jti — reuse one to test replay. */
  jti?: string;
}

/** Mint a scoped HS256 connection token of the shape the Companion verifies. */
export function mintToken(opts: MintOptions): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 60;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: opts.sub ?? "user_e2e_test",
    ticketId: opts.ticketId,
    sessionId: opts.sessionId,
    aud: opts.aud ?? TEST_ORIGIN,
    jti: opts.jti ?? crypto.randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + ttl,
  };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto
    .createHmac("sha256", opts.secret ?? TEST_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  return `${headerB64}.${payloadB64}.${base64url(sig)}`;
}

// ── A benign-command Companion bridge server ─────────────────────────────────

const DEFAULT_CTX: TicketContext = {
  clientSlug: "e2e-client",
  displayId: "DSP-9001",
  title: "E2E bridge test ticket",
  status: "in_progress",
};

export interface BridgeServerHandle {
  /** The port the bridge is listening on (loopback only). */
  port: number;
  /** Stop the server and tear down every live bridged session. */
  close(): Promise<void>;
}

export interface BridgeServerOptions {
  /** The benign program the PTY hosts. Default: `/bin/sh`. NEVER `claude`. */
  claudeBin?: string;
  /** Argv for the benign program. */
  claudeArgs?: readonly string[];
  /** Origin allowlist. Defaults to [TEST_ORIGIN]. */
  allowedOrigins?: readonly string[];
}

/**
 * Start a real Companion bridge bound to 127.0.0.1 on an ephemeral port.
 *
 * Uses the production `authenticateUpgrade` (three-factor auth) and the
 * production `BridgeSession` (the real PTY ↔ WebSocket duplex + protocol
 * frames), but spawns a BENIGN command in the PTY — never `claude`.
 */
export async function startBridgeServer(
  options: BridgeServerOptions = {}
): Promise<BridgeServerHandle> {
  const allowedOrigins = options.allowedOrigins ?? [TEST_ORIGIN];
  const claudeBin = options.claudeBin ?? "/bin/sh";
  const claudeArgs = options.claudeArgs ?? [];

  const liveSessions = new Set<BridgeSession>();
  const wss = new WebSocketServer({ noServer: true });

  const httpServer: Server = createServer((req, res) => {
    const pathOnly = (req.url ?? "").split("?")[0];
    if (pathOnly === "/healthz" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, companion: "e2e" }));
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  });

  // The real production port is read from config at runtime; the auth Host pin
  // checks `Host` against the actual listening port, so we resolve the port
  // first, then wire the upgrade handler with it.
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    // The REAL three-factor auth check — token + Origin + Host — before any PTY.
    const auth = authenticateUpgrade(
      {
        token: url.searchParams.get("token") ?? undefined,
        claimedTicketId: url.searchParams.get("ticket") ?? undefined,
        claimedSessionId: url.searchParams.get("session") ?? undefined,
        origin: req.headers.origin,
        host: req.headers.host,
      },
      { tokenSecret: TEST_SECRET, allowedOrigins, port }
    );

    if (!auth.ok) {
      const line = auth.status === 401 ? "401 Unauthorized" : "403 Forbidden";
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    const ctx: TicketContext = {
      ...DEFAULT_CTX,
      displayId: auth.connection.claims.ticketId,
    };

    wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge = new BridgeSession(ws, {
        pty: {
          claudeBin,
          claudeArgs,
          cwd: process.cwd(),
          env: process.env,
        },
        context: ctx,
      });
      liveSessions.add(bridge);
      ws.on("close", () => liveSessions.delete(bridge));
    });
  });

  return {
    port,
    close(): Promise<void> {
      for (const bridge of liveSessions) bridge.teardown("e2e-close");
      liveSessions.clear();
      return new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
  };
}

/** A short async sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
