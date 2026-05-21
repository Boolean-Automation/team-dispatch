/**
 * auth.test.ts — the three-factor connection auth.
 *
 * Mirrors the prototype's L2 reject evidence as runnable unit tests:
 *   no token            → 401
 *   bad / malformed token → 401
 *   replayed token      → 401   (A12b — single-use)
 *   expired token       → 401   (A12b — short-TTL)
 *   wrong ticket scope  → 401   (A12d — token is not a generic key)
 *   wrong session scope → 401   (A12d)
 *   wrong Origin        → 403   (A10a)
 *   absent / null Origin → 403  (A10a — strict allowlist, not "must be present")
 *   non-loopback Host   → 403   (A10b — DNS-rebinding defense)
 *   valid scoped token + exact Origin + loopback Host → accepted (A8)
 *
 * ACs A9/A10a/A10b/A12b/A12d still need a *captured* artifact in Slice 4 — this
 * is supporting evidence.
 */

import crypto from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import {
  authenticateUpgrade,
  verifyToken,
  isOriginAllowed,
  isHostLoopback,
  _resetConsumedJtis,
} from "./auth.js";
import type { CompanionTokenClaims, AuthConfig } from "./auth.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

const SECRET = "test-companion-secret-32-bytes-long!!";
const PORT = 7720;
const ORIGIN = "http://localhost:5173";

const CONFIG: AuthConfig = {
  tokenSecret: SECRET,
  allowedOrigins: [ORIGIN, "https://dispatch.paintos.app"],
  port: PORT,
};

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/** Mint a fixture-signed HS256 token — same shape the api's mint route emits. */
function mintToken(claims: Partial<CompanionTokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const full: CompanionTokenClaims = {
    sub: "user_se_001",
    ticketId: "DSP-2901",
    sessionId: "sess-aaaa",
    aud: ORIGIN,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 60,
    ...claims,
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(full));
  const sig = b64url(
    crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${sig}`;
}

const validInput = (token: string) => ({
  token,
  claimedTicketId: "DSP-2901",
  claimedSessionId: "sess-aaaa",
  origin: ORIGIN,
  host: `127.0.0.1:${PORT}`,
});

beforeEach(() => {
  _resetConsumedJtis();
});

// ── verifyToken — signature + expiry ─────────────────────────────────────────

describe("verifyToken", () => {
  it("verifies a well-formed signed token", () => {
    const claims = verifyToken(mintToken(), SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.ticketId).toBe("DSP-2901");
  });

  it("rejects a token signed with the wrong secret", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        sub: "u",
        ticketId: "DSP-1",
        sessionId: "s",
        aud: ORIGIN,
        jti: "j",
        iat: now,
        exp: now + 60,
      })
    );
    const badSig = b64url(
      crypto.createHmac("sha256", "wrong-secret").update(`${header}.${payload}`).digest()
    );
    expect(verifyToken(`${header}.${payload}.${badSig}`, SECRET)).toBeNull();
  });

  it("rejects a malformed (non-3-part) token", () => {
    expect(verifyToken("garbage", SECRET)).toBeNull();
    expect(verifyToken("a.b", SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = mintToken({ iat: now - 120, exp: now - 60 });
    expect(verifyToken(expired, SECRET)).toBeNull();
  });
});

// ── isOriginAllowed — strict exact-match ─────────────────────────────────────

describe("isOriginAllowed", () => {
  it("accepts an exact-match origin", () => {
    expect(isOriginAllowed(ORIGIN, CONFIG.allowedOrigins)).toBe(true);
  });

  it("rejects a non-allowlisted origin", () => {
    expect(isOriginAllowed("https://evil.example.com", CONFIG.allowedOrigins)).toBe(
      false
    );
  });

  it("rejects an absent origin", () => {
    expect(isOriginAllowed(undefined, CONFIG.allowedOrigins)).toBe(false);
  });

  it('rejects a literal "null" origin (the sandboxed-iframe / rebinding shape)', () => {
    expect(isOriginAllowed("null", CONFIG.allowedOrigins)).toBe(false);
  });
});

// ── isHostLoopback — the DNS-rebinding defense ───────────────────────────────

describe("isHostLoopback", () => {
  it("accepts 127.0.0.1:<port>", () => {
    expect(isHostLoopback(`127.0.0.1:${PORT}`, PORT)).toBe(true);
  });

  it("accepts localhost:<port>", () => {
    expect(isHostLoopback(`localhost:${PORT}`, PORT)).toBe(true);
  });

  it("rejects a spoofed Host: evil.com (the rebinding shape)", () => {
    expect(isHostLoopback("evil.com", PORT)).toBe(false);
  });

  it("rejects a loopback host on the wrong port", () => {
    expect(isHostLoopback("127.0.0.1:9999", PORT)).toBe(false);
  });

  it("rejects an absent Host header", () => {
    expect(isHostLoopback(undefined, PORT)).toBe(false);
  });
});

// ── authenticateUpgrade — the combined three-factor check ────────────────────

describe("authenticateUpgrade", () => {
  it("accepts a valid scoped token + exact Origin + loopback Host (A8)", () => {
    const result = authenticateUpgrade(validInput(mintToken()), CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.claims.ticketId).toBe("DSP-2901");
      expect(result.connection.origin).toBe(ORIGIN);
    }
  });

  it("rejects no token → 401 (A9)", () => {
    const input = { ...validInput(""), token: undefined };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a bad/malformed token → 401 (A9)", () => {
    const result = authenticateUpgrade(validInput("not-a-real-token"), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a replayed token → 401 (A12b — single-use jti)", () => {
    const token = mintToken();
    const first = authenticateUpgrade(validInput(token), CONFIG);
    expect(first.ok).toBe(true);
    // The same token re-presented on a second connection.
    const replay = authenticateUpgrade(validInput(token), CONFIG);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.status).toBe(401);
      expect(replay.reason).toContain("replay");
    }
  });

  it("rejects an expired token → 401 (A12b — short-TTL)", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = mintToken({ iat: now - 120, exp: now - 60 });
    const result = authenticateUpgrade(validInput(expired), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a token scoped to ticket X presented for ticket Y → 401 (A12d)", () => {
    const token = mintToken({ ticketId: "DSP-2901" });
    const input = { ...validInput(token), claimedTicketId: "DSP-9999" };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("ticket");
    }
  });

  it("rejects a token scoped to session S presented for session S' → 401 (A12d)", () => {
    const token = mintToken({ sessionId: "sess-aaaa" });
    const input = { ...validInput(token), claimedSessionId: "sess-zzzz" };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("session");
    }
  });

  it("rejects a non-dispatch Origin → 403 (A10a)", () => {
    const input = { ...validInput(mintToken()), origin: "https://evil.example.com" };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects an absent Origin → 403 (A10a — strict allowlist)", () => {
    const input = { ...validInput(mintToken()), origin: undefined };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('rejects a "null" Origin → 403 (A10a)', () => {
    const input = { ...validInput(mintToken()), origin: "null" };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects a non-loopback Host → 403 (A10b — DNS-rebinding defense)", () => {
    const input = { ...validInput(mintToken()), host: "evil.com" };
    const result = authenticateUpgrade(input, CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toContain("Host");
    }
  });

  it("rejects a token whose audience does not match the Origin → 403", () => {
    // Token minted for the prod origin but the connection arrives from local.
    const token = mintToken({ aud: "https://dispatch.paintos.app" });
    const result = authenticateUpgrade(validInput(token), CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});
