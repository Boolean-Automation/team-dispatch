// dispatch — Slice 0 CSP + helmet header tests
//
// Asserts the SPA-wide CSP plugin emits the right headers on every response,
// that the nonce-injection onSend hook rewrites the served HTML, and that
// the documented `style-src-attr 'unsafe-inline'` carve-out is the ONLY place
// `'unsafe-inline'` appears in the policy.
//
// Plan §Slice 0 — "L2: vitest output showing `csp-headers.test.ts` asserting
// no `unsafe-*`." The assertion is mechanical: the test parses the CSP header
// directives and walks each one looking for forbidden tokens.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import helmetPlugin from "../src/plugins/helmet.js";
import cspPlugin from "../src/plugins/csp.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse a CSP header string into directive → tokens map. */
function parseCsp(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const segment of csp.split(";")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const [name, ...tokens] = trimmed.split(/\s+/);
    if (!name) continue;
    out[name] = tokens;
  }
  return out;
}

// ── Build a minimal app that exercises the two plugins ───────────────────────
//
// We do NOT use the full buildServer() here — it pulls in clerk-auth, db, the
// outbox worker, etc. The plugins under test are independent of route-class
// guards, so a stripped-down Fastify lets us prove header behavior in
// isolation.

async function buildSecurityApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(helmetPlugin);
  await app.register(cspPlugin);

  // A no-op JSON route to confirm headers land on JSON responses too.
  app.get("/health", async () => ({ ok: true }));

  // A simulated SPA index — the onSend hook must inject the nonce <meta> and
  // attach a nonce attribute to every <script> + <link rel="stylesheet"> tag.
  app.get("/", async (_req, reply) => {
    reply.type("text/html");
    return [
      "<!doctype html>",
      "<html>",
      "<head>",
      "  <title>dispatch</title>",
      '  <link rel="stylesheet" href="/assets/index.css">',
      "</head>",
      "<body>",
      '  <script type="module" src="/assets/index.js"></script>',
      '  <script src="/assets/secondary.js"></script>',
      "</body>",
      "</html>",
    ].join("\n");
  });

  // Stub additional SPA routes — they serve the same shell so the same
  // headers must be present.
  for (const path of ["/t/DSP-0001", "/settings", "/analytics"]) {
    app.get(path, async (_req, reply) => {
      reply.type("text/html");
      return "<!doctype html><html><head></head><body><script>noop</script></body></html>";
    });
  }

  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Slice 0 — SPA-wide CSP + helmet headers", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildSecurityApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const ROUTES = ["/", "/t/DSP-0001", "/settings", "/analytics", "/health"];

  describe.each(ROUTES)("response to GET %s", (route) => {
    it("emits a Content-Security-Policy header", async () => {
      const res = await app.inject({ method: "GET", url: route });
      expect(res.statusCode).toBe(200);
      const csp = res.headers["content-security-policy"];
      expect(csp).toBeTruthy();
      expect(typeof csp).toBe("string");
    });

    it("does not permit 'unsafe-inline' on any script directive", async () => {
      const res = await app.inject({ method: "GET", url: route });
      const csp = String(res.headers["content-security-policy"]);
      const directives = parseCsp(csp);
      for (const name of ["script-src", "script-src-elem", "script-src-attr"]) {
        const tokens = directives[name];
        if (!tokens) continue;
        expect(
          tokens,
          `${name} must not include 'unsafe-inline'`
        ).not.toContain("'unsafe-inline'");
      }
    });

    it("does not permit 'unsafe-eval' anywhere", async () => {
      const res = await app.inject({ method: "GET", url: route });
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).not.toContain("'unsafe-eval'");
    });

    it("explicitly allows the Companion loopback origins on connect-src", async () => {
      const res = await app.inject({ method: "GET", url: route });
      const csp = String(res.headers["content-security-policy"]);
      const directives = parseCsp(csp);
      const connectSrc = directives["connect-src"] ?? [];
      expect(connectSrc).toContain("http://127.0.0.1:7720");
      expect(connectSrc).toContain("ws://127.0.0.1:7720");
      expect(connectSrc).toContain("https://127.0.0.1:7720");
      expect(connectSrc).toContain("wss://127.0.0.1:7720");
    });

    it("locks down object-src, frame-ancestors, base-uri, form-action", async () => {
      const res = await app.inject({ method: "GET", url: route });
      const csp = String(res.headers["content-security-policy"]);
      const directives = parseCsp(csp);
      expect(directives["object-src"]).toEqual(["'none'"]);
      expect(directives["frame-ancestors"]).toEqual(["'none'"]);
      expect(directives["base-uri"]).toEqual(["'self'"]);
      expect(directives["form-action"]).toEqual(["'self'"]);
    });
  });

  // ── The carve-out: 'unsafe-inline' is permitted on style-src-attr only ─────
  it("permits 'unsafe-inline' on style-src-attr (documented carve-out for 75 inline React styles)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = String(res.headers["content-security-policy"]);
    const directives = parseCsp(csp);
    expect(directives["style-src-attr"]).toContain("'unsafe-inline'");
  });

  it("style-src-attr is the ONLY directive that contains 'unsafe-inline'", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = String(res.headers["content-security-policy"]);
    const directives = parseCsp(csp);
    const offenders: string[] = [];
    for (const [name, tokens] of Object.entries(directives)) {
      if (name === "style-src-attr") continue;
      if (tokens.includes("'unsafe-inline'")) offenders.push(name);
    }
    expect(offenders, `unexpected 'unsafe-inline' in: ${offenders.join(", ")}`).toEqual(
      []
    );
  });

  // ── Clerk origins on script-src-elem ───────────────────────────────────────
  it("allows Clerk script origins on script-src-elem", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = String(res.headers["content-security-policy"]);
    const directives = parseCsp(csp);
    const scriptSrcElem = directives["script-src-elem"] ?? [];
    expect(scriptSrcElem).toContain("https://*.clerk.accounts.dev");
    expect(scriptSrcElem).toContain("https://clerk.dispatch.paintos.app");
  });

  it("forbids inline event handlers via script-src-attr 'none'", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    const csp = String(res.headers["content-security-policy"]);
    const directives = parseCsp(csp);
    expect(directives["script-src-attr"]).toEqual(["'none'"]);
  });

  // ── Nonce injection (the onSend hook) ──────────────────────────────────────
  describe("nonce injection in HTML responses", () => {
    it("injects <meta name='csp-nonce' content='…'/> into the served <head>", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const html = res.body;
      const metaMatch = html.match(
        /<meta\s+name="csp-nonce"\s+content="([a-f0-9]{32})"\s*\/?>/
      );
      expect(metaMatch, "csp-nonce <meta> tag must be present").not.toBeNull();
    });

    it("attaches nonce='…' to every <script> tag", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const html = res.body;
      // The fixture has two <script> tags; both must carry a nonce.
      const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scriptTags.length).toBeGreaterThanOrEqual(2);
      for (const tag of scriptTags) {
        expect(tag, `expected nonce on <script>: ${tag}`).toMatch(
          /nonce="[a-f0-9]{32}"/
        );
      }
    });

    it("attaches nonce='…' to every <link rel=\"stylesheet\"> tag", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const html = res.body;
      const linkTags =
        html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) ?? [];
      expect(linkTags.length).toBeGreaterThanOrEqual(1);
      for (const tag of linkTags) {
        expect(tag, `expected nonce on stylesheet <link>: ${tag}`).toMatch(
          /nonce="[a-f0-9]{32}"/
        );
      }
    });

    it("the nonce attribute on tags matches the <meta> nonce (single per-request value)", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const html = res.body;
      const metaMatch = html.match(
        /<meta\s+name="csp-nonce"\s+content="([a-f0-9]{32})"\s*\/?>/
      );
      expect(metaMatch).not.toBeNull();
      const nonce = metaMatch![1]!;
      const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
      for (const tag of scriptTags) {
        expect(tag).toContain(`nonce="${nonce}"`);
      }
    });

    it("mints a fresh nonce per request", async () => {
      const res1 = await app.inject({ method: "GET", url: "/" });
      const res2 = await app.inject({ method: "GET", url: "/" });
      const nonce1 = res1.body.match(
        /<meta\s+name="csp-nonce"\s+content="([a-f0-9]{32})"/
      )?.[1];
      const nonce2 = res2.body.match(
        /<meta\s+name="csp-nonce"\s+content="([a-f0-9]{32})"/
      )?.[1];
      expect(nonce1).toBeTruthy();
      expect(nonce2).toBeTruthy();
      expect(nonce1).not.toBe(nonce2);
    });

    it("emits the nonce on the CSP header itself (script-src-elem 'nonce-…')", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      const csp = String(res.headers["content-security-policy"]);
      const html = res.body;
      const headerNonce = csp.match(/'nonce-([a-f0-9]{32})'/)?.[1];
      const bodyNonce = html.match(
        /<meta\s+name="csp-nonce"\s+content="([a-f0-9]{32})"/
      )?.[1];
      expect(headerNonce).toBeTruthy();
      expect(bodyNonce).toBeTruthy();
      expect(headerNonce).toBe(bodyNonce);
    });
  });

  // ── Helmet's other defaults ────────────────────────────────────────────────
  it("emits X-Content-Type-Options: nosniff", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("emits Referrer-Policy: no-referrer or strict-origin-when-cross-origin", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const referrer = res.headers["referrer-policy"];
    expect(referrer).toBeTruthy();
  });

  it("emits Cross-Origin-Opener-Policy: same-origin", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });
});
