/**
 * dispatch Companion — three-factor connection auth.
 *
 * The PTY this bridge spawns hosts the SE's real credentialed `claude` — an
 * RCE surface. Auth is therefore graded against a non-cooperative attacker
 * (DNS rebinding, port squatting), not just a wrong-Origin browser tab. THREE
 * checks run at the WebSocket `upgrade` boundary BEFORE any PTY spawns; any one
 * failing rejects the connection:
 *
 *   1. Token       — a backend-minted HS256 connection token. The Companion
 *                    verifies signature + expiry + single-use `jti` AND the
 *                    scoped claims (the token's ticket id / session id must
 *                    match the connection's claimed ticket / session). A token
 *                    minted for ticket X / session S presented for ticket Y or
 *                    session S′ is rejected — the token is not a generic key.
 *   2. Origin pin  — a STRICT exact-match allowlist. An absent or `null`
 *                    Origin is REJECTED (not "allowed because no Origin") —
 *                    that is what a loose check lets DNS rebinding walk through.
 *   3. Host pin    — the `Host` header must be a loopback host
 *                    (`127.0.0.1:<port>` / `localhost:<port>`). This — not the
 *                    Origin pin — is the actual DNS-rebinding defense: a
 *                    rebinding attack arrives with `Host: evil.com`.
 *
 * Single-use enforcement: a consumed `jti` is recorded for the process
 * lifetime; replaying it (or presenting an expired token) is rejected. This is
 * also what makes the fake-Companion port-squat race detectable — a squatter
 * that never obtained a backend-minted token cannot complete the handshake.
 *
 * The token format is a compact HS256 JWS: base64url(header).base64url(payload).
 * base64url(HMAC-SHA256). The api mints it (Slice 2 — jsonwebtoken); this
 * module verifies it with only Node `crypto`, no external dependency.
 */

import crypto from "node:crypto";

// ── Token claim shape ────────────────────────────────────────────────────────

/** The five scoped claims a minted connection token carries. */
export interface CompanionTokenClaims {
  /** Clerk user id the token was minted for. */
  sub: string;
  /** Ticket id the token is scoped to. */
  ticketId: string;
  /** Unique per-session id the token is scoped to. */
  sessionId: string;
  /** Intended dispatch Origin / audience. */
  aud: string;
  /** Unique token id — enforces single-use. */
  jti: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds (short TTL, ~60s). */
  exp: number;
}

// ── The auth context a successful upgrade carries forward ────────────────────

export interface AuthedConnection {
  claims: CompanionTokenClaims;
  origin: string;
}

// ── Reject results ───────────────────────────────────────────────────────────

export type AuthResult =
  | { ok: true; connection: AuthedConnection }
  | { ok: false; status: 401 | 403; reason: string };

// ── Single-use jti registry (process-lifetime) ───────────────────────────────

const consumedJtis = new Set<string>();

/** Reset the consumed-jti set — test-only. */
export function _resetConsumedJtis(): void {
  consumedJtis.clear();
}

// ── HS256 token verification ─────────────────────────────────────────────────

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Verify a compact HS256 JWS and return its claims, or null on any failure
 * (bad shape, bad signature, expired). Pure signature+expiry check — scope
 * matching is done by the caller against the claimed ticket/session.
 */
export function verifyToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): CompanionTokenClaims | null {
  if (typeof token !== "string" || token.length === 0) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // Verify signature with a timing-safe compare.
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let presentedSig: Buffer;
  try {
    presentedSig = base64urlDecode(signatureB64);
  } catch {
    return null;
  }
  if (
    presentedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(presentedSig, expectedSig)
  ) {
    return null;
  }

  // Header must declare HS256.
  let header: { alg?: string };
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  // Parse + shape-check the payload.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  const claims = payload as Partial<CompanionTokenClaims>;
  if (
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    typeof claims.ticketId !== "string" ||
    claims.ticketId.length === 0 ||
    typeof claims.sessionId !== "string" ||
    claims.sessionId.length === 0 ||
    typeof claims.aud !== "string" ||
    claims.aud.length === 0 ||
    typeof claims.jti !== "string" ||
    claims.jti.length === 0 ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }

  // Expiry — a token that has outlived its short TTL is rejected.
  if (nowSeconds >= claims.exp) return null;

  return claims as CompanionTokenClaims;
}

// ── Origin pin — strict exact-match allowlist ────────────────────────────────

/**
 * A strict exact-match Origin check. An absent or `null` Origin is REJECTED —
 * a loose "must be present" / known-bad check is what lets DNS rebinding
 * through.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[]
): boolean {
  if (origin === undefined || origin === null || origin === "" || origin === "null") {
    return false;
  }
  return allowlist.includes(origin);
}

// ── Host pin — loopback-only ─────────────────────────────────────────────────

/**
 * The `Host` header must be a loopback host on the Companion's port. This is
 * the DNS-rebinding defense — a rebinding attack arrives with `Host: evil.com`.
 */
export function isHostLoopback(host: string | undefined, port: number): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

// ── The combined three-factor upgrade check ──────────────────────────────────

export interface AuthInput {
  /** The presented connection token (from the `token` query param). */
  token: string | undefined;
  /** The ticket id the connection claims (from the `ticket` query param). */
  claimedTicketId: string | undefined;
  /** The session id the connection claims (from the `session` query param). */
  claimedSessionId: string | undefined;
  /** The HTTP `Origin` header. */
  origin: string | undefined;
  /** The HTTP `Host` header. */
  host: string | undefined;
}

export interface AuthConfig {
  tokenSecret: string;
  allowedOrigins: readonly string[];
  port: number;
}

/**
 * Run the three-factor check. Returns an accept (with the verified claims) or a
 * reject with the HTTP status the upgrade handler should write:
 *   401 — bad / missing / expired / replayed / wrong-scope token
 *   403 — bad Origin (incl. absent/null) or non-loopback Host
 *
 * On accept the token's `jti` is recorded as consumed — single-use.
 */
export function authenticateUpgrade(
  input: AuthInput,
  config: AuthConfig,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): AuthResult {
  // Factor 1 — token signature + expiry.
  if (!input.token) {
    return { ok: false, status: 401, reason: "no token presented" };
  }
  const claims = verifyToken(input.token, config.tokenSecret, nowSeconds);
  if (!claims) {
    return { ok: false, status: 401, reason: "token invalid, expired, or malformed" };
  }

  // Factor 1b — single-use: a consumed jti is a replay.
  if (consumedJtis.has(claims.jti)) {
    return { ok: false, status: 401, reason: "token replayed — jti already consumed" };
  }

  // Factor 1c — scope: the token is not a generic key. Its ticket / session
  // must match the connection's claimed ticket / session.
  if (claims.ticketId !== input.claimedTicketId) {
    return { ok: false, status: 401, reason: "token ticket scope mismatch" };
  }
  if (claims.sessionId !== input.claimedSessionId) {
    return { ok: false, status: 401, reason: "token session scope mismatch" };
  }

  // Factor 2 — Origin pin (strict exact-match; absent/null rejected).
  if (!isOriginAllowed(input.origin, config.allowedOrigins)) {
    return { ok: false, status: 403, reason: "Origin not in strict allowlist" };
  }

  // Factor 2b — the token's audience must match the presented Origin.
  if (claims.aud !== input.origin) {
    return { ok: false, status: 403, reason: "token audience does not match Origin" };
  }

  // Factor 3 — Host pin (loopback-only — the DNS-rebinding defense).
  if (!isHostLoopback(input.host, config.port)) {
    return { ok: false, status: 403, reason: "Host header is not a loopback host" };
  }

  // Accept — consume the jti so the token cannot be replayed.
  consumedJtis.add(claims.jti);
  // input.origin is non-undefined here (isOriginAllowed rejected undefined).
  return { ok: true, connection: { claims, origin: input.origin as string } };
}
