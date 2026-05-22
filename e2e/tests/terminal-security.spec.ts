// dispatch E2E — Phase 2 security posture (A24).
//
// Covers AC A24:
//   - `Content-Security-Policy` present on SPA responses (root + ticket routes).
//   - CSP has no `'unsafe-inline'` on any script directive.
//   - CSP has NO `'unsafe-eval'` anywhere.
//   - CSP has the documented `style-src-attr 'unsafe-inline'` carve-out for
//     the 75-inline-styles-refactor follow-up (Slice 0 plan).
//   - `Cross-Origin-Opener-Policy: same-origin` is set (popout same-origin
//     assertion relies on this).
//   - `X-Content-Type-Options: nosniff` + `X-Frame-Options` set.
//
// Important: the CSP is registered on the Fastify api server (port 3000).
// The Vite dev server (port 5173) serves the SPA in dev but does NOT inject
// the CSP — the production path is `api.dispatch.paintos.app` serving the
// built SPA. We curl the api server directly to assert the headers.
//
// In CI, both servers are up via the Playwright webServer block.

import { test, expect, request } from "@playwright/test";

const API_BASE = "http://localhost:3000";

test.describe("Terminal security headers — A24", () => {
  test("A24 — api responses carry a Content-Security-Policy header", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      // Any api response carries the CSP — even a 404. We hit /api/tickets
      // (which 401s without auth but still emits headers).
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"];
      expect(csp).toBeTruthy();
      expect(csp).toMatch(/default-src 'self'/);
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — no 'unsafe-inline' on script directives", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";

      // Pull out each script-* directive and confirm none contain 'unsafe-inline'.
      const scriptDirectives = csp
        .split(";")
        .map((d) => d.trim())
        .filter((d) => /^script-src(-elem|-attr)?\b/.test(d));

      // At least one script directive should be present (script-src-elem
      // carries the SPA bundle policy).
      expect(scriptDirectives.length).toBeGreaterThan(0);
      for (const d of scriptDirectives) {
        expect(d).not.toContain("'unsafe-inline'");
        expect(d).not.toContain("'unsafe-eval'");
      }
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — CSP contains no 'unsafe-eval' anywhere", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";
      expect(csp).not.toContain("'unsafe-eval'");
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — script-src-attr is locked to 'none' (no inline event handlers)", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";
      expect(csp).toMatch(/script-src-attr 'none'/);
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — documented style-src-attr 'unsafe-inline' carve-out IS present", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";
      // The 75-inline-styles follow-up justifies this single, documented
      // carve-out. The carve-out is on style-src-attr ONLY — not on script.
      expect(csp).toMatch(/style-src-attr 'unsafe-inline'/);
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — script-src-elem carries 'strict-dynamic' + a nonce", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";
      expect(csp).toMatch(/script-src-elem[^;]*'strict-dynamic'/);
      // Per-request nonce — 16 bytes hex = 32 chars.
      expect(csp).toMatch(/script-src-elem[^;]*'nonce-[0-9a-f]{32}'/);
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — Cross-Origin-Opener-Policy: same-origin (popout assertion)", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      expect(res.headers()["cross-origin-opener-policy"]).toBe("same-origin");
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — X-Content-Type-Options: nosniff + X-Frame-Options set", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
      // helmet defaults to SAMEORIGIN — either DENY or SAMEORIGIN is OK
      // (the rule is "no foreign frames"). Accept either.
      const xfo = res.headers()["x-frame-options"]?.toUpperCase();
      expect(["DENY", "SAMEORIGIN"]).toContain(xfo);
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — connect-src allowlists the Companion fixed-port (7720)", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";
      // The Companion binds 127.0.0.1:7720 (DEFAULT_COMPANION_PORT). The CSP
      // explicitly allowlists ws://127.0.0.1:7720 + http://127.0.0.1:7720 so
      // the SPA can talk to it from the same origin.
      expect(csp).toContain("ws://127.0.0.1:7720");
      expect(csp).toContain("http://127.0.0.1:7720");
    } finally {
      await ctx.dispose();
    }
  });

  test("A24 — object-src 'none' + frame-ancestors 'none'", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/api/tickets");
      const csp = res.headers()["content-security-policy"] ?? "";
      expect(csp).toMatch(/object-src 'none'/);
      expect(csp).toMatch(/frame-ancestors 'none'/);
    } finally {
      await ctx.dispose();
    }
  });
});
