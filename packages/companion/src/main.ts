/**
 * dispatch Companion — process entry (Phase 2, thin consumer of the bridge core).
 *
 * Responsibilities:
 *   - ADR-007 Windows fence: refuse to run on win32 (use Phase 3 container);
 *   - bind HTTP + WebSocket to 127.0.0.1 ONLY (never 0.0.0.0);
 *   - expose `GET /healthz` (discovery probe) and `GET /metrics` (Prometheus)
 *     on the same loopback HTTP server that handles the WS upgrade;
 *   - three-factor auth check (auth.ts) BEFORE the upgrade completes — no PTY
 *     spawns for a bad connection;
 *   - hand each authed upgrade to `attachBridge()` (bridge.ts);
 *   - start the idle sweeper for the pty-map (Codex F3 / R2-F2);
 *   - SIGTERM → close all PTYs synchronously, exit 0.
 */

import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import type { CompanionConfig } from "./config.js";
import { authenticateUpgrade } from "./auth.js";
import { attachBridge } from "./bridge.js";
import { COMPANION_VERSION, MAX_FRAME_BYTES } from "./protocol.js";
import { createPtyMap } from "./pty-map.js";
import type { PtyMap } from "./pty-map.js";
import { createIdleSweeper } from "./idle-sweeper.js";
import { createMetrics } from "./metrics.js";

/**
 * ADR-007 Windows fence: dispatch Companion does not run on Windows. Use the
 * Phase 3 server-side container (status: not-yet-released) instead.
 *
 * Exit code 78 = EX_CONFIG from sysexits.h.
 */
export function enforceWindowsFence(
  platform: NodeJS.Platform = process.platform,
  logger: (msg: string) => void = (m) => console.log(m),
  exit: (code: number) => never = process.exit.bind(process) as (code: number) => never
): void {
  if (platform === "win32") {
    logger(
      "Boolean dispatch Companion does not run on Windows. Use the Phase 3 server-side container instead (status: not-yet-released). See ADR-007."
    );
    exit(78);
  }
}

/**
 * Build the Companion server. Returns the HTTP server, the WS server, the
 * pty-map, the sweeper, and a `closeAll` that synchronously reaps every live
 * PTY. Exported so a test can drive the full server without `listen()` racing
 * the test process.
 */
export function buildCompanionServer(config: CompanionConfig = loadConfig()) {
  const companionStartedAt = Date.now();
  const ptyMap: PtyMap = createPtyMap({ maxPtysPerTicket: config.maxPtysPerTicket });
  const metrics = createMetrics({ map: ptyMap, startedAt: companionStartedAt });
  let wsActiveCount = 0;

  const sweeper = createIdleSweeper(
    ptyMap,
    {
      tickMs: config.sweeperTickMs,
      idleMs: config.sweeperIdleMs,
      gracePauseMs: config.sweeperGracePauseMs,
      clock: Date.now,
    },
    {
      incrementReaped(reason) {
        metrics.incrementReaped(reason);
      },
    }
  );

  const httpServer = createServer((req, res) => {
    const pathOnly = (req.url ?? "").split("?")[0];

    // ── /healthz — cross-origin discovery probe ─────────────────────────
    if (pathOnly === "/healthz") {
      const origin = req.headers.origin;
      const corsHeaders: Record<string, string> = { Vary: "Origin" };
      if (typeof origin === "string" && config.allowedOrigins.includes(origin)) {
        corsHeaders["Access-Control-Allow-Origin"] = origin;
        corsHeaders["Access-Control-Allow-Methods"] = "GET, OPTIONS";
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...corsHeaders, "Cache-Control": "no-store" });
        res.end();
        return;
      }

      if (req.method === "GET") {
        res.writeHead(200, {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, companion: COMPANION_VERSION }));
        return;
      }
    }

    // ── /metrics — Prometheus text on loopback ──────────────────────────
    if (pathOnly === "/metrics" && req.method === "GET") {
      metrics.setWsActive(wsActiveCount);
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(metrics.render());
      return;
    }

    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade Required");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

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
      console.error(`[companion] upgrade rejected (${auth.status}): ${auth.reason}`);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wsActiveCount++;
      ws.on("close", () => {
        wsActiveCount = Math.max(0, wsActiveCount - 1);
      });
      attachBridge(ws, {
        ptyMap,
        config,
        companionStartedAt,
        ticketId: auth.connection.claims.ticketId,
        onPtySpawned: () => metrics.incrementSpawned(),
      });
      console.error(
        `[companion] WS accepted for ticket ${auth.connection.claims.ticketId}`
      );
    });
  });

  /** Tear down every live PTY synchronously — used by SIGTERM. */
  function closeAll(): void {
    ptyMap.forEach((entry) => {
      try {
        entry.session.kill();
      } catch {
        /* already gone */
      }
      ptyMap.delete(entry.pty_id);
      metrics.incrementReaped("sigterm");
    });
  }

  return {
    httpServer,
    wss,
    ptyMap,
    sweeper,
    metrics,
    closeAll,
    config,
    companionStartedAt,
  };
}

// ── Process entry — only when run directly, not when imported by a test ──────

const isMain =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname ===
    new URL(process.argv[1], import.meta.url).pathname;

if (isMain) {
  // ADR-007 Windows fence — must run BEFORE loadConfig() so a Windows machine
  // gets the message even if env vars are misconfigured.
  enforceWindowsFence();

  const { httpServer, sweeper, closeAll, config } = buildCompanionServer();

  httpServer.listen(config.port, config.host, () => {
    console.error(
      `[companion] listening on ws://${config.host}:${config.port} (loopback only)`
    );
    console.error(
      `[companion] auth: backend-minted token + strict Origin allowlist + loopback Host pin`
    );
    console.error(`[companion] shell cwd: ${config.knowledgeRoot}`);
    console.error(`[companion] metrics: http://${config.host}:${config.port}/metrics`);
  });

  sweeper.start();

  const shutdown = () => {
    console.error("[companion] SIGTERM — tearing down all live sessions");
    sweeper.stop();
    closeAll();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
