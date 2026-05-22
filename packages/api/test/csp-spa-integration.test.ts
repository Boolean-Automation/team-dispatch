// dispatch — Codex post-qa P1 fix integration test.
//
// Asserts that the production-shaped Fastify server actually serves the React
// SPA's index.html under CSP — closing the gap that csp-headers.test.ts (a
// minimal-app harness with stub HTML routes) left open.
//
// Before the P1 fix, GET / on `buildServer()` returned a JSON 404 with CSP
// applied to the error body. After: GET / returns the actual web/dist/
// index.html with the per-request nonce stamped in both the
// Content-Security-Policy header AND every <script> + <link rel="stylesheet">
// element, plus the <meta name="csp-nonce" content="..."> tag in <head>.
//
// Fixtures: this test reads the real packages/web/dist artifact (`pnpm
// --filter @dispatch/web build` must run before this suite). The fixture
// must be a real-shape SPA shell — a `<script>` (entry bundle) and a `<link
// rel="stylesheet">` (CSS bundle) — so the nonce-rewrite has tags to stamp.
// We discover them dynamically rather than hard-coding bundle hashes that
// change every build.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// packages/api/test/<this> → packages/web/dist
const webDistDir = path.resolve(__dirname, "..", "..", "web", "dist");
const indexHtmlPath = path.join(webDistDir, "index.html");

const webDistExists = fs.existsSync(indexHtmlPath);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Pull every `nonce="..."` attribute value out of an HTML string. */
function extractNonces(html: string): string[] {
  const out: string[] = [];
  const re = /\bnonce="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = m[1];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** Pull the meta-nonce content value. */
function extractMetaNonce(html: string): string | null {
  const m = /<meta[^>]+name="csp-nonce"[^>]+content="([^"]+)"/.exec(html);
  return m && m[1] ? m[1] : null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CSP on the real SPA surface — buildServer() integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!webDistExists) {
      // Hard error rather than silent skip — the integration test is binding
      // L1 evidence; running without the artifact gives a false-positive
      // greenlight. The /build pipeline runs `pnpm --filter @dispatch/web
      // build` before this suite.
      throw new Error(
        `csp-spa-integration: missing ${indexHtmlPath}. Run \`pnpm --filter @dispatch/web build\` before this test.`
      );
    }
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("GET / returns the SPA index.html with CSP header + nonce-stamped tags", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);

    const contentType = String(res.headers["content-type"] ?? "");
    expect(contentType.toLowerCase()).toContain("text/html");

    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp.length).toBeGreaterThan(0);

    const body = res.body;
    // Doctype is case-insensitive in HTML5; Vite's output is uppercase.
    expect(body.toLowerCase()).toContain("<!doctype html>");

    // <meta name="csp-nonce" content="..."> must be injected in <head>.
    const metaNonce = extractMetaNonce(body);
    expect(metaNonce).not.toBeNull();
    expect(metaNonce!.length).toBeGreaterThan(0);

    // Every <script> + <link rel="stylesheet"> in the served HTML carries
    // a nonce="..." attribute. We can't assume there's exactly N such tags
    // (Vite emits different bundle shapes), but the rewrite is supposed to
    // attach a nonce to every one — so the set of distinct nonce values in
    // the body should be exactly {metaNonce}.
    const allNonces = extractNonces(body);
    expect(allNonces.length).toBeGreaterThanOrEqual(2); // meta + ≥1 tag
    const distinct = new Set(allNonces);
    expect(distinct.size).toBe(1);
    expect(distinct.has(metaNonce!)).toBe(true);

    // The CSP header must contain 'nonce-<value>' on script-src-elem so the
    // injected nonce actually authorizes the stamped tags.
    expect(csp).toContain(`'nonce-${metaNonce}'`);

    // Every <script ...> tag in the body should carry a nonce attribute.
    const scriptTags = body.match(/<script\b[^>]*>/gi) ?? [];
    for (const tag of scriptTags) {
      expect(tag).toMatch(/\bnonce="/);
    }
    // Every <link rel="stylesheet" ...> tag should too.
    const stylesheetLinks =
      body.match(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi) ?? [];
    for (const tag of stylesheetLinks) {
      expect(tag).toMatch(/\bnonce="/);
    }
  });

  it("GET /t/DSP-FAKE — SPA fallback — also returns the index with CSP + nonce", async () => {
    const res = await app.inject({ method: "GET", url: "/t/DSP-FAKE" });
    // setNotFoundHandler returns the SPA index via reply.sendFile, which
    // by default emits 200 (the response IS found, just not from the route
    // tree). If it 404s, something other than the SPA fallback handled the
    // request — surface that explicitly.
    expect(res.statusCode).toBe(200);

    const contentType = String(res.headers["content-type"] ?? "");
    expect(contentType.toLowerCase()).toContain("text/html");

    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp.length).toBeGreaterThan(0);

    const metaNonce = extractMetaNonce(res.body);
    expect(metaNonce).not.toBeNull();

    // The two requests get DIFFERENT nonces — proving the onRequest hook
    // mints per-request, not once-at-boot.
    const firstRes = await app.inject({ method: "GET", url: "/" });
    const firstNonce = extractMetaNonce(firstRes.body);
    expect(firstNonce).not.toBeNull();
    expect(firstNonce).not.toBe(metaNonce);
  });

  it("GET /api/unknown — API miss returns JSON 404, NOT the SPA", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nothing-here" });
    expect(res.statusCode).toBe(404);
    const contentType = String(res.headers["content-type"] ?? "");
    expect(contentType.toLowerCase()).toContain("application/json");
    const body = res.json<{ error?: string }>();
    expect(body.error).toBe("not found");
  });

  it("GET /health — health route is not shadowed by the SPA serve", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it("GET /<asset> for a Vite asset path returns CSS/JS content-type, NOT the SPA HTML", async () => {
    // Discover one real asset path from the served index.html.
    const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
    const assetMatch =
      /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(indexHtml) ??
      /<link[^>]+href="(\/assets\/[^"]+\.css)"/.exec(indexHtml);
    if (!assetMatch || !assetMatch[1]) {
      // The fixture has no /assets/ entries — that's still a valid SPA, just
      // skip this assertion. The other tests above carry the load.
      return;
    }
    const assetUrl = assetMatch[1];
    const res = await app.inject({ method: "GET", url: assetUrl });
    expect(res.statusCode).toBe(200);
    const contentType = String(res.headers["content-type"] ?? "");
    // js or css — never text/html.
    expect(contentType.toLowerCase()).not.toContain("text/html");
  });
});
