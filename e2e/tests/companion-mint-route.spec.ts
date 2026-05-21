// dispatch E2E — POST /api/companion/sessions: the token-mint route.
//
// Surface: packages/api/src/routes/companion.ts — the API-first touchpoint
// that mints the scoped, short-TTL, single-use connection token the Companion
// bridge verifies (Spike #1, OQ-S3).
//
// What this e2e layer proves against the LIVE api server (started by
// playwright.config.ts's webServer, port 3000):
//   - the route is wired and reachable;
//   - it is a POST — a GET is not accepted (Codex P1-2: a PTY-opening bearer
//     credential is too dangerous for a broad cacheable GET);
//   - an unauthenticated request is rejected with 401 before any token is
//     minted — the route is Clerk-gated.
//
// What is DELIBERATELY NOT e2e-tested here, and why:
//   The mint happy path — a valid Clerk-authed SE receives a scoped token with
//   `Cache-Control: no-store`, and an SE requesting an inaccessible ticket is
//   rejected (A12e) — requires a valid Clerk session JWT. The e2e api process
//   runs with CLERK_SECRET_KEY="" (graceful-passthrough is a WEB-side concern;
//   the api's requireClerkSession still hard-rejects a missing/invalid Bearer
//   token). There is no test-only Clerk-verifier injection seam across a
//   separate server process. That happy path is fully covered by the Supertest
//   integration suite — packages/api/test/companion.test.ts (8 tests) — which
//   injects a mock Clerk verifier in-process. This is the same coverage split
//   e2e/README.md documents for the ingestion + write-back routes.

import { test, expect, request as pwRequest } from "@playwright/test";

const API_BASE = "http://localhost:3000";
const MINT_PATH = "/api/companion/sessions";

test.describe("POST /api/companion/sessions — token-mint route", () => {
  test("the route is reachable and Clerk-gated — an unauthed POST is 401", async () => {
    const ctx = await pwRequest.newContext();
    try {
      const res = await ctx.post(`${API_BASE}${MINT_PATH}`, {
        data: { ticketId: "DSP-2876", origin: "http://localhost:5173" },
        // No Authorization header — no Clerk session.
      });
      // requireClerkSession rejects a request with no Bearer token before the
      // handler runs — no token is minted for an unauthenticated caller.
      expect(res.status()).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    } finally {
      await ctx.dispose();
    }
  });

  test("an invalid/garbage Bearer token is rejected with 401", async () => {
    const ctx = await pwRequest.newContext();
    try {
      const res = await ctx.post(`${API_BASE}${MINT_PATH}`, {
        headers: { Authorization: "Bearer not-a-real-clerk-session-jwt" },
        data: { ticketId: "DSP-2876", origin: "http://localhost:5173" },
      });
      // The Clerk verify throws on a bogus token → 401, no mint.
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test("the mint route is a POST — a GET to the same path is not accepted", async () => {
    const ctx = await pwRequest.newContext();
    try {
      const res = await ctx.get(`${API_BASE}${MINT_PATH}`);
      // Fastify returns 404 for an unregistered METHOD+path pair — the route is
      // registered ONLY as POST. A PTY-opening credential is never a GET.
      expect(res.status()).not.toBe(200);
      expect([404, 405]).toContain(res.status());
    } finally {
      await ctx.dispose();
    }
  });
});
