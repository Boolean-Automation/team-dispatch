// dispatch — @fastify/helmet wrapper (Slice 0)
//
// Registers @fastify/helmet with the SPA-wide defaults plan.md §Slice 0 calls
// for. The custom CSP plugin (./csp.ts) handles the full Content-Security-Policy
// directive — helmet here is told `contentSecurityPolicy: false` so it does
// not double-emit a clashing CSP header.
//
// Other defaults left on:
//   - X-Content-Type-Options: nosniff
//   - Referrer-Policy
//   - X-Frame-Options (DENY) — defense-in-depth alongside CSP frame-ancestors
//
// Production-only:
//   - Strict-Transport-Security: max-age=31536000; includeSubDomains
//     (Skipped in dev so localhost without HTTPS still works.)
//
// COEP starts at `unsafe-none` per plan.md §Slice 0 — Clerk's iframe surface
// needs verification before tightening to `require-corp`. The plan flags this
// as a follow-up; if Clerk breaks under `require-corp`, the directive stays
// at `unsafe-none`.

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import helmet from "@fastify/helmet";

async function helmetPlugin(fastify: FastifyInstance) {
  const isProd = process.env.NODE_ENV === "production";

  await fastify.register(helmet, {
    // The custom CSP plugin (./csp.ts) owns the Content-Security-Policy header.
    // Helmet's CSP would emit a competing header — turn it off here.
    contentSecurityPolicy: false,

    // Same-origin window opener so popup-driven XSS can't reach window.opener.
    crossOriginOpenerPolicy: { policy: "same-origin" },

    // unsafe-none for now — Clerk iframes break under require-corp without
    // CORP headers on their CDN. Re-test under require-corp after Slice 1.
    crossOriginEmbedderPolicy: { policy: "unsafe-none" },

    // HSTS in production only. Dev runs over plain HTTP.
    strictTransportSecurity: isProd
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });
}

export default fp(helmetPlugin, {
  name: "helmet",
  fastify: "4.x",
});
