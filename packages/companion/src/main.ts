/**
 * dispatch Companion — process entry (thin consumer of the bridge core).
 *
 * Responsibilities ONLY:
 *   - bind an HTTP + WebSocket server to 127.0.0.1 ONLY (never 0.0.0.0 — a
 *     non-loopback bind is a spike failure),
 *   - expose a minimal `GET /healthz` for discovery (OQ-S4) — returns NO
 *     sensitive data, carries `Cache-Control: no-store`,
 *   - run the three-factor auth check (auth.ts) in the `upgrade` handler
 *     BEFORE `wss.handleUpgrade` — no PTY spawns for a bad connection,
 *   - hand each authed upgrade to a `BridgeSession`,
 *   - install a SIGTERM handler that tears down EVERY live session
 *     (process-group kill) before the process exits — no detached `claude`
 *     survives the Companion.
 *
 * Started by hand on the two pilot machines (no installer — §3.2).
 */

import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { authenticateUpgrade } from "./auth.js";
import { BridgeSession } from "./bridge.js";
import type { TicketContext } from "./context.js";
import { COMPANION_VERSION } from "./protocol.js";

/**
 * Build the Companion server. Returns the HTTP server, the WS server, and a
 * `closeAll` that tears every live session down — exported so a test can drive
 * the full server without `listen()` racing the test process.
 */
export function buildCompanionServer(config = loadConfig()) {
  const httpServer = createServer((req, res) => {
    // Minimal discovery endpoint. NO sensitive data; no-store.
    if (req.method === "GET" && req.url && req.url.split("?")[0] === "/healthz") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, companion: COMPANION_VERSION }));
      return;
    }
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  });

  const wss = new WebSocketServer({ noServer: true });

  /** Every live bridged session — the SIGTERM handler walks this. */
  const liveSessions = new Set<BridgeSession>();

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);

    // Three-factor auth at the upgrade boundary — BEFORE any PTY spawns.
    const auth = authenticateUpgrade(
      {
        token: url.searchParams.get("token") ?? undefined,
        claimedTicketId: url.searchParams.get("ticket") ?? undefined,
        claimedSessionId: url.searchParams.get("session") ?? undefined,
        origin: req.headers.origin,
        host: req.headers.host,
      },
      {
        tokenSecret: config.tokenSecret,
        allowedOrigins: config.allowedOrigins,
        port: config.port,
      }
    );

    if (!auth.ok) {
      const line = auth.status === 401 ? "401 Unauthorized" : "403 Forbidden";
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      // Never log the token. The reason is safe — it carries no secret.
      console.error(`[companion] upgrade rejected (${auth.status}): ${auth.reason}`);
      return;
    }

    const ticketContext: TicketContext = {
      clientSlug: url.searchParams.get("clientSlug") ?? "unknown",
      displayId: auth.connection.claims.ticketId,
      title: url.searchParams.get("title") ?? "(no title)",
      status: url.searchParams.get("status") ?? "unknown",
      threadToCursor: url.searchParams.get("thread") ?? undefined,
    };

    wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge = new BridgeSession(ws, {
        pty: {
          cwd: config.knowledgeRoot,
          env: process.env,
          // Interactive `claude` — the human in the panel drives it.
          claudeArgs: [],
        },
        context: ticketContext,
      });
      liveSessions.add(bridge);
      ws.on("close", () => liveSessions.delete(bridge));
      console.error(
        `[companion] session ${bridge.session.sessionId} accepted ` +
          `(ticket ${auth.connection.claims.ticketId})`
      );
    });
  });

  /** Tear down every live session — process-group kill — used by SIGTERM. */
  function closeAll(): void {
    for (const bridge of liveSessions) {
      bridge.teardown("companion-shutdown");
    }
    liveSessions.clear();
  }

  return { httpServer, wss, liveSessions, closeAll, config };
}

// ── Process entry — only when run directly, not when imported by a test ──────

const isMain =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname ===
    new URL(process.argv[1], import.meta.url).pathname;

if (isMain) {
  const { httpServer, closeAll, config } = buildCompanionServer();

  httpServer.listen(config.port, config.host, () => {
    console.error(
      `[companion] listening on ws://${config.host}:${config.port} (loopback only)`
    );
    console.error(
      `[companion] auth: backend-minted token + strict Origin allowlist + loopback Host pin`
    );
    console.error(`[companion] claude cwd: ${config.knowledgeRoot}`);
  });

  // SIGTERM — tear down every live session before exit. No detached `claude`.
  const shutdown = () => {
    console.error("[companion] SIGTERM — tearing down all live sessions");
    closeAll();
    httpServer.close(() => process.exit(0));
    // Hard backstop if close hangs.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
