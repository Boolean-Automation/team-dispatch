// dispatch E2E — Ingestion Stage 1 registry load smoke test (Fix 5, AC-9 partial)
//
// Packet §AC-9 partial: smoke test that `[dispatch] registry loaded` log line
// appears at API startup; `registryClientCount > 0`.
//
// Dev phase gate-dev.md commit c305bc0 shipped:
//   - ingestion.ts loadRegistry() with observability log: `[dispatch] registry loaded`
//   - Dockerfile COPY + REGISTRY_PATH env var
//   - DISPATCH_REGISTRY_HARD_FAIL guard
//
// E2E approach: This spec tests the API-layer behavior without a browser.
// Playwright's `request` fixture allows direct HTTP calls to the API server
// (started by playwright.config.ts webServer[1] on port 3000).
//
// What this test can verify:
//   1. The API server starts successfully (health check passes).
//   2. The ingestion stub endpoint accepts a well-formed event (registry is loaded,
//      not hard-failing, classifier runs without crashing).
//   3. The response shape indicates ingestion processed the event.
//
// What this test CANNOT verify in E2E (needs Railway logs):
//   - The exact `[dispatch] registry loaded` console.info log line — that's a
//     server stdout event, not observable from a browser/HTTP request.
//   - `registryClientCount > 0` — the dev environment's registry YAML may not
//     exist locally at the expected path; the test will succeed even with
//     registryClientCount=0 (silent fallback is the default in dev).
//
// NOTE: In the E2E environment (graceful-passthrough, no CLERK_SECRET_KEY),
// the requireClerkAdmin middleware on POST /api/ingest/stub will reject the request
// with 401. This spec tests that the API is UP and the ingestion route is registered
// (not a 404), which proves Stage 1 Dockerfile changes didn't break startup.

import { test, expect } from "@playwright/test";

const API_BASE = "http://localhost:3000";

test.describe("AC-9 partial — Ingestion Stage 1 registry load", () => {
  test("API server is healthy (registry load did not crash startup)", async ({ request }) => {
    // GET /health → { ok: true }
    // If the registry loadRegistry() threw at startup (DISPATCH_REGISTRY_HARD_FAIL=1 + missing file),
    // the API server would not have started and this request would fail.
    const response = await request.get(`${API_BASE}/health`);
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
  });

  test("POST /api/ingest/stub route is registered (returns 401, not 404)", async ({ request }) => {
    // The ingestion routes are registered in the Fastify app.
    // If loadRegistry() causes a hard crash (unhandled exception), the route would not be registered.
    // 401 = route exists but Clerk auth rejected the unauthenticated request (expected).
    // 404 = route was never registered (Stage 1 COPY broke the app startup).
    const response = await request.post(`${API_BASE}/api/ingest/stub`, {
      data: {
        channelId: "C_TEST_REGISTRY_SMOKE",
        authorRef: "U_TEST",
        body: "smoke test",
        isTopLevel: true,
      },
    });

    // Should be 401 (auth rejected) not 404 (route missing) or 500 (crash)
    expect([401, 403]).toContain(response.status());
    expect(response.status()).not.toBe(404);
    expect(response.status()).not.toBe(500);
  });

  test("POST /api/ingest/slack route is registered (returns 401/400, not 404 or 500)", async ({ request }) => {
    // Slack webhook route — requires HMAC signature validation.
    // Without a valid signature, should return 401 or 400.
    // 500 would indicate a crash in the registry loader.
    const response = await request.post(`${API_BASE}/api/ingest/slack`, {
      headers: { "content-type": "application/json" },
      data: { type: "event_callback" },
    });

    // Should be 4xx (auth/validation rejected) not 500 (crash) or 404 (missing)
    expect(response.status()).toBeLessThan(500);
    expect(response.status()).not.toBe(404);
  });

  test("GET /api/tickets returns 200 or 401 (API is live, not crashed)", async ({ request }) => {
    // The playwright.config.ts webServer already waits for /api/tickets to respond,
    // so this is a belt-and-suspenders check that the API didn't crash post-registry-load.
    const response = await request.get(`${API_BASE}/api/tickets`);
    // 200 if Clerk passthrough works, 401 if auth required — both mean API is alive
    expect([200, 401]).toContain(response.status());
    expect(response.status()).not.toBe(500);
  });
});
