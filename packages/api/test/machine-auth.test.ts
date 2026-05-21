// dispatch — machine-credential auth tests (FIX 8)
//
// Tests the four-case auth-class separation proof:
//   1. No credential on MCP route → 401
//   2. A Clerk-style browser session JWT on an MCP route → 401
//      (wrong audience — the two credential classes are NOT interchangeable)
//   3. A valid machine token on an MCP route → 200
//   4. A valid machine token on a session route → 401
//      (session route uses requireClerkSession, which expects a Clerk JWT)
//
// The machine verifier is injected via _setMachineVerifierForTest so no real
// signing happens in these tests. The Clerk verifier is also mocked via
// _setClerkVerifierForTest so case 4 can confirm the session guard rejects
// the machine token (it would throw / fail Clerk verification).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import {
  _setMachineVerifierForTest,
  _resetMachineVerifier,
  _setClerkVerifierForTest,
  _resetClerkVerifier,
  type MachineTokenClaims,
} from "../src/plugins/clerk-auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a valid machine token claims object. */
function validMachineClaims(
  userId: string,
  role: "admin" | "se" = "se"
): MachineTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: userId,
    role,
    aud: "dispatch-mcp",
    iss: "dispatch",
    exp: now + 3600,
    iat: now,
  };
}

/** Install a machine verifier mock that returns valid claims. */
function mockValidMachineToken(userId: string, role: "admin" | "se" = "se") {
  _setMachineVerifierForTest(
    vi.fn((_token, _secret) => validMachineClaims(userId, role))
  );
}

/** Install a machine verifier mock that throws (simulates bad/expired token). */
function mockInvalidMachineToken() {
  _setMachineVerifierForTest(
    vi.fn((_token, _secret) => {
      throw new Error("invalid signature");
    })
  );
}

/** Install a machine verifier that returns claims with wrong audience — simulates
 *  a Clerk session JWT being presented on a machine-credential route. */
function mockClerkSessionOnMcpRoute(userId: string) {
  _setMachineVerifierForTest(
    vi.fn((_token, _secret) => {
      const now = Math.floor(Date.now() / 1000);
      return {
        sub: userId,
        role: "se",
        // Clerk issues aud: "dispatch" or its own audience, NOT "dispatch-mcp"
        aud: "dispatch",
        iss: "https://clerk.helloboolean.com",
        exp: now + 3600,
        iat: now,
      };
    })
  );
}

// ── requireMachineCredential on MCP routes ────────────────────────────────────

describe("requireMachineCredential — MCP routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.MCP_SIGNING_SECRET = "test-mcp-signing-secret-32-bytes!!";
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    _resetMachineVerifier();
    _resetClerkVerifier();
    delete process.env.MCP_SIGNING_SECRET;
    await app.close();
  });

  // Case 1: No credential at all
  it("returns 401 when no Authorization header is present", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ statusCode: number; error: string }>();
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  // Case 2: A Clerk-style browser session JWT on an MCP route is rejected
  it("returns 401 when a Clerk browser session JWT is presented on an MCP route", async () => {
    // The verifier succeeds (parses the token) but the claims carry wrong aud
    mockClerkSessionOnMcpRoute("user_clerk_abc");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer eyJfake.clerk.session" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ statusCode: number; error: string }>();
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  // Case 3: A valid machine token is accepted
  it("returns 200 with correct payload when a valid machine token is presented", async () => {
    const userId = "user_mcp_operator_001";
    mockValidMachineToken(userId, "se");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/accounts",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    // 200 — the real DB may be empty (test db), which is fine; auth passed
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 for admin machine token as well", async () => {
    const userId = "user_mcp_admin_001";
    mockValidMachineToken(userId, "admin");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/accounts",
      headers: { Authorization: "Bearer valid.admin.machine.token" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 401 when machine token has invalid signature", async () => {
    mockInvalidMachineToken();

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer bad.machine.token" },
    });

    expect(res.statusCode).toBe(401);
  });
});

// ── Case 4: Machine token on a session route is rejected ──────────────────────

describe("machine credential is rejected on session routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.MCP_SIGNING_SECRET = "test-mcp-signing-secret-32-bytes!!";
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    _resetMachineVerifier();
    _resetClerkVerifier();
    delete process.env.MCP_SIGNING_SECRET;
    await app.close();
  });

  // Case 4: The session guard (requireClerkSession) uses the Clerk verifier,
  // not the machine verifier. A machine token presented here hits Clerk's
  // verifyToken, which will reject it (wrong format / signature / issuer for Clerk).
  // We simulate this by installing a Clerk verifier that throws — as the real
  // Clerk SDK would when given a non-Clerk token.
  it("returns 401 when a machine token is presented on a Clerk session route", async () => {
    // Make the Clerk verifier throw — as it would for any non-Clerk token
    _setClerkVerifierForTest(
      vi.fn(async (_token, _opts) => {
        throw new Error("Not a valid Clerk session JWT");
      })
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        // A machine token: the Clerk guard won't accept this
        Authorization: "Bearer eyJmachine.credential.here",
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ statusCode: number; error: string }>();
    expect(body.statusCode).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });
});

// ── MCP route shapes ──────────────────────────────────────────────────────────

describe("MCP route structure", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.MCP_SIGNING_SECRET = "test-mcp-signing-secret-32-bytes!!";
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    _resetMachineVerifier();
    _resetClerkVerifier();
    delete process.env.MCP_SIGNING_SECRET;
    await app.close();
  });

  it("GET /api/mcp/tickets returns array with valid machine token", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("GET /api/mcp/accounts returns array with valid machine token", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/accounts",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("GET /api/mcp/tickets/:id returns 404 for unknown UUID", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets/00000000-0000-0000-0000-000000000000",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /api/mcp/accounts/:id returns 404 for unknown UUID", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/accounts/00000000-0000-0000-0000-000000000000",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("GET /api/mcp/tickets/:id with DSP- display id returns 404 for unknown", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets/DSP-9999",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ── P2-E: Machine token claim shape validation ────────────────────────────────
//
// The requireMachineCredential handler must reject tokens with malformed
// sub / role / exp / iat claims (P2-E), not just bad signatures.

describe("P2-E: requireMachineCredential — claim shape validation", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.MCP_SIGNING_SECRET = "test-mcp-signing-secret-32-bytes!!";
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    _resetMachineVerifier();
    _resetClerkVerifier();
    delete process.env.MCP_SIGNING_SECRET;
    await app.close();
  });

  it("returns 401 when sub is missing (undefined)", async () => {
    const now = Math.floor(Date.now() / 1000);
    _setMachineVerifierForTest(
      vi.fn((_token, _secret) => ({
        sub: undefined as unknown as string, // invalid — sub must be a non-empty string
        role: "se",
        aud: "dispatch-mcp",
        iss: "dispatch",
        exp: now + 3600,
        iat: now,
      }))
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer some.token.here" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ message: string }>();
    expect(body.message).toContain("sub");
  });

  it("returns 401 when sub is an empty string", async () => {
    const now = Math.floor(Date.now() / 1000);
    _setMachineVerifierForTest(
      vi.fn((_token, _secret) => ({
        sub: "", // invalid — must be non-empty
        role: "se",
        aud: "dispatch-mcp",
        iss: "dispatch",
        exp: now + 3600,
        iat: now,
      }))
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer some.token.here" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when role is an unknown value (e.g. 'superuser')", async () => {
    const now = Math.floor(Date.now() / 1000);
    _setMachineVerifierForTest(
      vi.fn((_token, _secret) => ({
        sub: "user_valid_id",
        role: "superuser", // invalid — only 'admin' | 'se' allowed
        aud: "dispatch-mcp",
        iss: "dispatch",
        exp: now + 3600,
        iat: now,
      }))
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer some.token.here" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ message: string }>();
    expect(body.message).toContain("role");
  });

  it("returns 401 when iat is missing (undefined)", async () => {
    const now = Math.floor(Date.now() / 1000);
    _setMachineVerifierForTest(
      vi.fn((_token, _secret) => ({
        sub: "user_valid_id",
        role: "se",
        aud: "dispatch-mcp",
        iss: "dispatch",
        exp: now + 3600,
        iat: undefined as unknown as number, // invalid — iat must be a number
      }))
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets",
      headers: { Authorization: "Bearer some.token.here" },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<{ message: string }>();
    expect(body.message).toContain("iat");
  });
});

// ── P3-A: Malformed ticket id → 400 (not 500 from DB uuid-syntax error) ───────

describe("P3-A: Malformed ticket id returns 400 on MCP route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.MCP_SIGNING_SECRET = "test-mcp-signing-secret-32-bytes!!";
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    _resetMachineVerifier();
    _resetClerkVerifier();
    delete process.env.MCP_SIGNING_SECRET;
    await app.close();
  });

  it("GET /api/mcp/tickets/:id returns 400 for a non-UUID non-DSP id", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets/not-a-valid-id",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ message: string }>();
    expect(body.message).toContain("Invalid ticket id");
  });

  it("GET /api/mcp/tickets/:id returns 400 for a partial UUID", async () => {
    mockValidMachineToken("user_mcp_001");

    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/tickets/00000000-0000-0000-0000",
      headers: { Authorization: "Bearer valid.machine.token" },
    });

    expect(res.statusCode).toBe(400);
  });
});
