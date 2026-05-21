// dispatch — clerk-auth plugin unit tests
// Tests the per-route-class guard model with Clerk's verifyToken mocked at
// the system boundary (the ClerkVerifyFn injectable).
//
// Assertions:
//   - no token → 401
//   - invalid/expired token → 401
//   - valid token, role=se → 200 with { userId, role: "se" }
//   - valid token, role=admin → 200 with { userId, role: "admin" }
//   - valid token, no role in metadata → defaults to role=se
//   - valid se token on admin-only route → 403
//   - valid admin token on admin-only route → 200

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  _setClerkVerifierForTest,
  _resetClerkVerifier,
  type VerifyTokenResult,
} from "../src/plugins/clerk-auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock JWT payload. */
function validPayload(
  userId: string,
  role: "admin" | "se" | undefined
): VerifyTokenResult {
  const payload: VerifyTokenResult = {
    sub: userId,
    iss: "https://clerk.test",
    aud: "dispatch",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  };

  if (role !== undefined) {
    payload["public_metadata"] = { role };
  }

  return payload;
}

/** Install a mock that returns a valid payload. */
function mockValidToken(userId: string, role: "admin" | "se" | undefined) {
  _setClerkVerifierForTest(
    vi.fn(async (_token, _opts) => validPayload(userId, role))
  );
}

/** Install a mock that throws (simulates invalid/expired token). */
function mockInvalidToken() {
  _setClerkVerifierForTest(
    vi.fn(async (_token, _opts) => {
      throw new Error("Token expired or invalid");
    })
  );
}

// ── requireClerkSession — GET /api/me ─────────────────────────────────────────

describe("requireClerkSession guard (GET /api/me)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    _resetClerkVerifier();
    await app.close();
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ statusCode: number; error: string }>();
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when the token is invalid / expired", async () => {
    mockInvalidToken();

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { Authorization: "Bearer bad.token.here" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ statusCode: number }>();
    expect(body.statusCode).toBe(401);
  });

  it("returns 200 with { userId, role: 'se' } for a valid se token", async () => {
    const mockUserId = "user_se_abc123";
    mockValidToken(mockUserId, "se");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { Authorization: "Bearer valid.se.token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ userId: string; role: string }>();
    expect(body.userId).toBe(mockUserId);
    expect(body.role).toBe("se");
  });

  it("returns 200 with { userId, role: 'admin' } for a valid admin token", async () => {
    const mockUserId = "user_admin_xyz789";
    mockValidToken(mockUserId, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { Authorization: "Bearer valid.admin.token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ userId: string; role: string }>();
    expect(body.userId).toBe(mockUserId);
    expect(body.role).toBe("admin");
  });

  it("defaults role to 'se' when publicMetadata.role is absent", async () => {
    const mockUserId = "user_norole_000";
    mockValidToken(mockUserId, undefined);

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { Authorization: "Bearer valid.norole.token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ userId: string; role: string }>();
    expect(body.userId).toBe(mockUserId);
    expect(body.role).toBe("se");
  });
});

// ── requireClerkAdmin guard ───────────────────────────────────────────────────

describe("requireClerkAdmin guard (admin-only route)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer();

    // Add a minimal admin-only test route
    const { requireClerkAdmin } = await import(
      "../src/plugins/clerk-auth.js"
    );
    app.get(
      "/api/test-admin-only",
      { preHandler: [requireClerkAdmin] },
      async () => ({ ok: true })
    );

    await app.ready();
  });

  afterEach(async () => {
    _resetClerkVerifier();
    await app.close();
  });

  it("returns 401 when no token is provided on an admin-only route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/test-admin-only",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when a valid se user hits an admin-only route", async () => {
    mockValidToken("user_se_111", "se");

    const res = await app.inject({
      method: "GET",
      url: "/api/test-admin-only",
      headers: { Authorization: "Bearer valid.se.token" },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 200 when a valid admin presents token on admin-only route", async () => {
    mockValidToken("user_admin_222", "admin");

    const res = await app.inject({
      method: "GET",
      url: "/api/test-admin-only",
      headers: { Authorization: "Bearer valid.admin.token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });
});
