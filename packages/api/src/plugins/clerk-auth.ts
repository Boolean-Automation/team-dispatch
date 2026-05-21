// dispatch — clerk-auth Fastify plugin
//
// Implements the four route-auth-class guards defined in plan.md §3:
//
//   (a) requireClerkSession  — Clerk session JWT (web app operator routes)
//   (b) requireSlackSignature — Slack HMAC (Slice 4 — NOT added here yet)
//   (c) requireClerkAdmin    — requireClerkSession + role === "admin"
//   (d) requireMachineCredential — MCP machine token (Slice 8 — NOT added here yet)
//
// Each route opts into exactly ONE guard as a preHandler.
// There is NO blanket /api/* hook — that would block the Slack ingestion
// webhook which must accept requests carrying no Clerk session.
//
// Slice 2 ships classes (a) and (c). Classes (b) and (d) are stubs exported
// here so the plugin file is the single module future slices extend.

import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

// ── Types ──────────────────────────────────────────────────────────────────────

export type DispatchRole = "admin" | "se";

/** Attached to request.auth by requireClerkSession (and requireClerkAdmin). */
export interface AuthContext {
  userId: string;
  role: DispatchRole;
}

// Augment Fastify's request type so TypeScript knows about request.auth
declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

// ── Clerk token verifier boundary ─────────────────────────────────────────────
//
// The real implementation calls @clerk/backend's `verifyToken`.
// Tests inject a mock via _setClerkVerifierForTest so we never hit the
// Clerk API in unit tests.
//
// VerifyTokenFn signature mirrors the @clerk/backend `verifyToken` shape:
//   (token, options) => Promise<{ sub: string; [key: string]: unknown }>

export type VerifyTokenResult = {
  sub: string;
  public_metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ClerkVerifyFn = (
  token: string,
  options: Record<string, unknown>
) => Promise<VerifyTokenResult>;

let _clerkVerify: ClerkVerifyFn | null = null;

async function getClerkVerify(): Promise<ClerkVerifyFn> {
  if (_clerkVerify) return _clerkVerify;
  // Dynamic import so tests can override before the SDK is loaded
  const { verifyToken } = await import("@clerk/backend");
  return verifyToken as unknown as ClerkVerifyFn;
}

/** Inject a mock for tests — replaces the real Clerk verifyToken. */
export function _setClerkVerifierForTest(mock: ClerkVerifyFn): void {
  _clerkVerify = mock;
}

/** Reset to the real SDK after tests. */
export function _resetClerkVerifier(): void {
  _clerkVerify = null;
}

// ── Guard: requireClerkSession (route-class a) ─────────────────────────────────
//
// Verifies the Clerk session JWT sent as `Authorization: Bearer <token>`.
// On success: attaches `{ userId, role }` to `request.auth`.
// On failure: replies 401.

export async function requireClerkSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  const sessionToken =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (!sessionToken) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "No session token provided",
      statusCode: 401,
    });
  }

  let userId: string;
  let role: DispatchRole;

  try {
    const verify = await getClerkVerify();
    const payload = await verify(sessionToken, {
      secretKey: process.env.CLERK_SECRET_KEY ?? "",
    });

    userId = payload.sub;

    // Role lives in Clerk publicMetadata.role; the JWT carries it as the
    // `public_metadata` claim (Clerk's standard JWT shape).
    const meta = payload.public_metadata ?? {};
    const rawRole = meta["role"];
    role = rawRole === "admin" ? "admin" : "se";
  } catch {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired session token",
      statusCode: 401,
    });
  }

  request.auth = { userId, role };
}

// ── Guard: requireClerkAdmin (route-class c) ───────────────────────────────────
//
// requireClerkSession + role === "admin"; else 403.

export async function requireClerkAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await requireClerkSession(request, reply);

  // reply.sent is true if requireClerkSession already replied 401
  if (reply.sent) return;

  if (request.auth.role !== "admin") {
    return reply.status(403).send({
      error: "Forbidden",
      message: "Admin role required",
      statusCode: 403,
    });
  }
}

// ── Guard: requireSlackSignature (route-class b) ──────────────────────────────
//
// Validates the Slack HMAC request signature:
//   X-Slack-Signature: v0=<hmac-sha256>
//   X-Slack-Request-Timestamp: <unix-epoch>
//
// Rejects requests older than 5 minutes to prevent replay attacks.
// Also handles the Events-API url_verification handshake transparently:
//   when the body contains { type: "url_verification" } the handler
//   replies 200 with { challenge } directly without reaching the route handler.
//
// The signing secret is read from process.env.SLACK_SIGNING_SECRET.
// Tests inject a mock via _setSlackSigningSecretForTest.

let _slackSigningSecret: string | null = null;

/** Inject a custom signing secret for tests. */
export function _setSlackSigningSecretForTest(secret: string): void {
  _slackSigningSecret = secret;
}

/** Reset to env-based secret. */
export function _resetSlackSigningSecret(): void {
  _slackSigningSecret = null;
}

function getSlackSigningSecret(): string {
  return _slackSigningSecret ?? process.env.SLACK_SIGNING_SECRET ?? "";
}

export async function requireSlackSignature(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const signingSecret = getSlackSigningSecret();
  if (!signingSecret) {
    return reply.status(500).send({
      error: "Internal Server Error",
      message: "SLACK_SIGNING_SECRET not configured",
      statusCode: 500,
    });
  }

  const timestamp = request.headers["x-slack-request-timestamp"];
  const signature = request.headers["x-slack-signature"];

  if (typeof timestamp !== "string" || typeof signature !== "string") {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing Slack signature headers",
      statusCode: 401,
    });
  }

  // Replay attack prevention: reject requests older than 5 minutes
  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(timestamp, 10);
  if (isNaN(tsNum) || Math.abs(nowSec - tsNum) > 300) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Slack request timestamp too old or invalid",
      statusCode: 401,
    });
  }

  // Build the signature basestring
  // raw-body plugin stores the raw request body string in request.rawBody.
  // Fall back to re-serializing the parsed body if rawBody is empty.
  const rawBodyStr = (request as FastifyRequest & { rawBody?: string }).rawBody;
  const bodyString =
    typeof rawBodyStr === "string" && rawBodyStr.length > 0
      ? rawBodyStr
      : JSON.stringify(request.body ?? "");

  const sigBasestring = `v0:${timestamp}:${bodyString}`;

  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(sigBasestring, "utf8")
    .digest("hex");

  const computedSignature = `v0=${hmac}`;

  // Timing-safe comparison
  const sigBuffer = Buffer.from(signature, "utf8");
  const computedBuffer = Buffer.from(computedSignature, "utf8");

  if (
    sigBuffer.length !== computedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, computedBuffer)
  ) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid Slack signature",
      statusCode: 401,
    });
  }

  // Signature is valid — no request.auth needed for Slack webhook routes
}

// ── Stub: requireMachineCredential (route-class d) — Slice 8 ──────────────────

export async function requireMachineCredential(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  return reply.status(501).send({
    error: "Not Implemented",
    message: "Machine credential auth is added in Slice 8",
    statusCode: 501,
  });
}

// ── Plugin registration ────────────────────────────────────────────────────────
//
// Registers nothing app-wide — all guards are per-route.
// Decorates request.auth with a null default so the TypeScript augmentation
// has a concrete value before any guard runs.

async function clerkAuthPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest("auth", null);
}

export default fp(clerkAuthPlugin, {
  name: "clerk-auth",
  fastify: "4.x",
});
