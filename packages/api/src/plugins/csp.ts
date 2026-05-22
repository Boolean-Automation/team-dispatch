// dispatch — custom CSP plugin (Slice 0)
//
// Why this plugin and not @fastify/helmet's CSP option:
//   - We need a per-request nonce that lands in BOTH the response header AND
//     the HTML body (a <meta name="csp-nonce"> tag + a `nonce="…"` attribute
//     on every <script> + <link rel="stylesheet">). Helmet's CSP middleware
//     can mint a nonce per request but doesn't rewrite the body.
//   - We need to allowlist the Companion bridge's fixed loopback origins
//     (http(s)://127.0.0.1:7720 + ws(s)://127.0.0.1:7720) on connect-src,
//     plus an optional override port if VITE_COMPANION_PORT is set.
//   - We need the documented `style-src-attr 'unsafe-inline'` carve-out for
//     the 75 React inline style usages — tracked as Phase 2.5 follow-up.
//
// Behavior:
//   onRequest hook:  mint a 16-byte hex nonce, stash it on the request, set
//                    the Content-Security-Policy header.
//   onSend hook:     if the response is HTML, rewrite the body to (a) inject
//                    <meta name="csp-nonce" content="<nonce>"> in <head>,
//                    (b) attach nonce="<nonce>" to every <script> and
//                    <link rel="stylesheet"> tag.
//
// Rewrite is regex-based (not cheerio) because this is the SPA hot path —
// every page load goes through it.

import { randomBytes } from "node:crypto";
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import fp from "fastify-plugin";

// ── Companion port resolution ────────────────────────────────────────────────
// The Companion bridge runs on a fixed loopback port (7720) per
// packages/web/src/ticket/companion-ws-transport.ts:30. If an SE overrides via
// VITE_COMPANION_PORT, include both.

const DEFAULT_COMPANION_PORT = 7720;

function getCompanionPorts(): number[] {
  const override = process.env["VITE_COMPANION_PORT"];
  if (!override) return [DEFAULT_COMPANION_PORT];
  const overridePort = Number(override);
  if (!Number.isFinite(overridePort) || overridePort <= 0) {
    return [DEFAULT_COMPANION_PORT];
  }
  if (overridePort === DEFAULT_COMPANION_PORT) return [DEFAULT_COMPANION_PORT];
  return [DEFAULT_COMPANION_PORT, overridePort];
}

function buildCompanionConnectSrc(): string[] {
  const ports = getCompanionPorts();
  const out: string[] = [];
  for (const port of ports) {
    out.push(`http://127.0.0.1:${port}`);
    out.push(`ws://127.0.0.1:${port}`);
    out.push(`https://127.0.0.1:${port}`);
    out.push(`wss://127.0.0.1:${port}`);
  }
  return out;
}

// ── Build the CSP header string for a given nonce ────────────────────────────

function buildCspHeader(nonce: string): string {
  const nonceToken = `'nonce-${nonce}'`;
  const companionConnect = buildCompanionConnectSrc();

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    [
      "script-src-elem",
      [
        "'self'",
        "'strict-dynamic'",
        nonceToken,
        "https://*.clerk.accounts.dev",
        "https://clerk.dispatch.paintos.app",
      ],
    ],
    ["script-src-attr", ["'none'"]],
    ["style-src-elem", ["'self'", nonceToken]],
    // Documented carve-out: 75 React inline style={{…}} usages emit `style`
    // attributes; CSP nonces do NOT authorize style attributes. This is the
    // only place 'unsafe-inline' appears anywhere in the policy. Tracked as
    // a Phase 2.5 follow-up (docs/follow-ups/inline-styles-refactor.md).
    // 'unsafe-inline' on style-src-attr does NOT enable script execution.
    ["style-src-attr", ["'unsafe-inline'"]],
    ["font-src", ["'self'", "data:"]],
    [
      "connect-src",
      [
        "'self'",
        ...companionConnect,
        "https://*.clerk.accounts.dev",
        "https://clerk.dispatch.paintos.app",
        "https://api.dispatch.paintos.app",
      ],
    ],
    ["img-src", ["'self'", "data:", "https:"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];

  return directives.map(([name, tokens]) => `${name} ${tokens.join(" ")}`).join("; ");
}

// ── Nonce minting ─────────────────────────────────────────────────────────────

function mintNonce(): string {
  return randomBytes(16).toString("hex");
}

// ── HTML rewrite for nonce injection ──────────────────────────────────────────
//
// Buffered string rewrite — not a cheerio parse — so the per-request cost is
// O(html length) and proportional to the SPA shell, not the DOM size.

function injectNonces(html: string, nonce: string): string {
  const metaTag = `<meta name="csp-nonce" content="${nonce}">`;

  // 1. Insert the <meta> tag right after the opening <head> tag (or at the
  //    start of the document if no <head> is present — defensive).
  let rewritten = html;
  if (/<head\b[^>]*>/i.test(rewritten)) {
    rewritten = rewritten.replace(/(<head\b[^>]*>)/i, `$1\n  ${metaTag}`);
  } else {
    // No <head> — prepend the meta tag at the very top of the body so the
    // SPA bootstrap can still read it via document.querySelector.
    rewritten = `${metaTag}\n${rewritten}`;
  }

  // 2. Attach nonce="…" to every <script …> opening tag that does not
  //    already carry a nonce attribute. Skip </script> closers.
  //
  // Codex R2-P3 fix — handle BOTH self-closing (`<script src="..." />`) and
  // non-self-closing forms. The optional trailing `/` is captured as the
  // self-close marker; nonce is inserted BEFORE it so the result remains
  // well-formed HTML. Note: `<script />` is browser-invalid (the spec
  // requires a closing tag), but if a serializer emits it, our rewrite must
  // still produce well-formed output rather than `<script ... / nonce="…">`.
  rewritten = rewritten.replace(
    /<script\b([^>]*?)(\s*\/)?>/gi,
    (_match, attrs: string, selfClose: string | undefined) => {
      const closer = selfClose ?? "";
      if (/\bnonce=/.test(attrs)) return `<script${attrs}${closer}>`;
      // Trim trailing whitespace from attrs so we produce `<script ... nonce="x" />`
      // not `<script ...  nonce="x" />` when there were already a leading space
      // before the `/`. The original (closer) chunk owns the leading whitespace.
      return `<script${attrs} nonce="${nonce}"${closer}>`;
    }
  );

  // 3. Attach nonce="…" to every <link rel="stylesheet" …> tag.
  //
  // Codex R2-P3 fix — same self-closing handling as <script>. Real-world
  // self-closing case: Google Fonts stylesheet links bundled into the SPA
  // (`<link rel="stylesheet" href="..." />`). Pre-fix the rewrite produced
  // `<link rel="stylesheet" href="..." / nonce="...">` — malformed HTML.
  // Patterns handled:
  //   <link rel="stylesheet" href="..." />            (self-closing)
  //   <link rel="stylesheet" href="...">              (non-self-closing)
  //   <link rel="stylesheet" href="..." crossorigin>  (extra attrs)
  //   <link rel="stylesheet" href="..." crossorigin/> (extra attrs, self-close)
  rewritten = rewritten.replace(
    /<link\b([^>]*?)(\s*\/)?>/gi,
    (match, attrs: string, selfClose: string | undefined) => {
      if (!/rel=["']?stylesheet["']?/i.test(attrs)) return match;
      if (/\bnonce=/.test(attrs)) return match;
      const closer = selfClose ?? "";
      return `<link${attrs} nonce="${nonce}"${closer}>`;
    }
  );

  return rewritten;
}

// ── Request augmentation ──────────────────────────────────────────────────────
// Stash the nonce on the request so other handlers can read it if they ever
// need to (server-rendered React, SSR-injected scripts, etc).

declare module "fastify" {
  interface FastifyRequest {
    cspNonce?: string;
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

async function cspPlugin(fastify: FastifyInstance) {
  // onRequest: mint the nonce + set the CSP header BEFORE any handler runs.
  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const nonce = mintNonce();
      request.cspNonce = nonce;
      reply.header("Content-Security-Policy", buildCspHeader(nonce));
    }
  );

  // onSend: rewrite HTML responses to inject the nonce into the body.
  fastify.addHook(
    "onSend",
    async (
      request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown
    ) => {
      const contentType = String(reply.getHeader("content-type") ?? "");
      if (!contentType.toLowerCase().includes("text/html")) {
        return payload;
      }
      const nonce = request.cspNonce;
      if (!nonce) return payload;

      // Payload can be a string, Buffer, or a stream. We handle string +
      // Buffer here — the SPA static handler returns string/Buffer payloads,
      // not streams. (If we ever switch to a streaming static handler, the
      // rewrite needs to move into a Transform stream.)
      if (typeof payload === "string") {
        return injectNonces(payload, nonce);
      }
      if (Buffer.isBuffer(payload)) {
        return injectNonces(payload.toString("utf8"), nonce);
      }
      // Unknown shape — pass through untouched; better than corrupting it.
      return payload;
    }
  );
}

export default fp(cspPlugin, {
  name: "csp",
  fastify: "4.x",
});

// ── Test-only exports ─────────────────────────────────────────────────────────
// Pulled out for direct unit testing if needed; not part of the runtime API.
export const _internal = {
  buildCspHeader,
  injectNonces,
  mintNonce,
  buildCompanionConnectSrc,
};
