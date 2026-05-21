#!/usr/bin/env node
/**
 * serve-https.mjs — serve the BUILT dispatch web app over local HTTPS.
 *
 * Spike #1 / spec §3.1.8 / A5b — the production-HTTPS-origin path.
 *
 * The core L1 path runs from local Vite — an HTTP origin. Phase 2 runs
 * `https://dispatch.paintos.app` — a production HTTPS public origin — reaching
 * `ws://127.0.0.1:7720`. That is a DIFFERENT browser security path (Chrome 147
 * expanded Local Network Access restrictions to WebSockets, with a permission
 * prompt for local-address connections from public sites; Safari/WebKit can
 * differ).
 *
 * This script serves `packages/web/dist` over local HTTPS with a self-signed
 * cert so the browser exercises the real HTTPS-page → localhost-WS path —
 * WITHOUT a live Railway deploy. The spike's evidence phase loads this origin
 * and captures the integration session a second time, recording any Chrome 147
 * LNA permission-prompt behavior.
 *
 * This is a dev/test harness, NOT shipped product. It touches no core/db
 * boundary.
 *
 * Usage:
 *   pnpm --filter @dispatch/web build        # produce dist/
 *   node packages/web/scripts/serve-https.mjs [port]
 *   # then open https://localhost:8443 and accept the self-signed cert.
 */

import { createServer } from "node:https";
import { request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, "..");
const DIST_DIR = join(WEB_ROOT, "dist");
const CERT_DIR = join(WEB_ROOT, ".https-cert");
const CERT_PATH = join(CERT_DIR, "localhost-cert.pem");
const KEY_PATH = join(CERT_DIR, "localhost-key.pem");
const PORT = Number(process.argv[2] ?? 8443);

/**
 * Backend the `/api/*` paths proxy to. The deployed app serves web + api from
 * one origin; locally the api runs as a separate process. The web app's
 * api-client uses same-origin paths (`API_BASE = ""`), so this HTTPS harness
 * must forward `/api/*` to the api the same way the Vite dev server does —
 * otherwise the production-origin capture cannot mint a Companion token.
 */
const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:3000";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** Generate a self-signed localhost cert via openssl if one is not present. */
function ensureCert() {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    try {
      new X509Certificate(execFileSync("cat", [CERT_PATH]));
      return;
    } catch {
      /* regenerate below */
    }
  }
  execFileSync("mkdir", ["-p", CERT_DIR]);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", KEY_PATH, "-out", CERT_PATH,
    "-days", "365", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  console.error(`[serve-https] generated self-signed cert at ${CERT_DIR}`);
}

async function main() {
  if (!existsSync(DIST_DIR)) {
    console.error(
      "[serve-https] no dist/ — run `pnpm --filter @dispatch/web build` first."
    );
    process.exit(1);
  }
  ensureCert();

  const server = createServer(
    {
      cert: await readFile(CERT_PATH),
      key: await readFile(KEY_PATH),
    },
    async (req, res) => {
      // `/api/*` → proxy to the api process (same shape as the Vite dev proxy).
      // This is what lets the production-like HTTPS origin mint a Companion
      // session token; without it the same-origin `POST /api/companion/sessions`
      // would 404 against the static SPA server.
      if ((req.url ?? "").startsWith("/api/")) {
        const target = new URL(API_TARGET);
        const proxied = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: target.host },
          },
          (upstream) => {
            res.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(res);
          }
        );
        proxied.on("error", () => {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("Bad Gateway — api unreachable");
        });
        req.pipe(proxied);
        return;
      }

      // SPA static serve with index.html fallback for client routes.
      const urlPath = (req.url ?? "/").split("?")[0];
      let filePath = join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);

      try {
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = join(filePath, "index.html");
      } catch {
        // Unknown path → SPA fallback to index.html (React Router owns it).
        filePath = join(DIST_DIR, "index.html");
      }

      try {
        const body = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    }
  );

  server.listen(PORT, "127.0.0.1", () => {
    console.error(
      `[serve-https] dispatch web app on https://localhost:${PORT} ` +
        `(self-signed — accept the cert warning).`
    );
    console.error(
      "[serve-https] this is the production-like HTTPS origin for the A5b capture."
    );
  });
}

main().catch((err) => {
  console.error("[serve-https]", err);
  process.exit(1);
});
