// dispatch — Slice 0 XSS payload corpus
//
// The xss-routes.test.tsx suite renders every SPA route with malicious payloads
// in every user-controllable field and asserts none of them execute. This
// corpus is the input set for those tests, kept in one file so we can extend
// it (terminal-specific payloads land in Slice 7).
//
// Plan §Slice 0 payload list:
//   - <script>window.__pwn=true</script>
//   - <img src=x onerror="window.__pwn=true">
//   - javascript:-URL
//   - <iframe>
//   - encoded variants (&lt;script&gt;, &#x3C;script&#x3E;, &#60;script&#62;)
//   - <div onclick="...">
//
// React's default rendering of any string interpolation escapes HTML — so
// none of these should execute. The test exists to PROVE that, not to prove
// that React still works. If anything reaches `dangerouslySetInnerHTML`, an
// `href={…}` resolution, or a direct DOM mutation that bypasses React, the
// payload will fire and `window.__pwn` will be true. That's the failure mode.

export const XSS_PAYLOADS: readonly string[] = [
  // 1. Raw <script> injection — the canonical XSS test
  `<script>window.__pwn=true</script>`,

  // 2. Image with onerror — fires when the bad src 404s
  `<img src=x onerror="window.__pwn=true">`,

  // 3. javascript: URL — fires if rendered into an href attribute
  `javascript:window.__pwn=true`,

  // 4. iframe with src — different sandboxing rules than scripts
  `<iframe src="javascript:window.__pwn=true"></iframe>`,

  // 5–7. HTML-entity-encoded variants of <script> — fires only if a
  //      double-decode somewhere in the rendering path unescapes them
  `&lt;script&gt;window.__pwn=true&lt;/script&gt;`,
  `&#x3C;script&#x3E;window.__pwn=true&#x3C;/script&#x3E;`,
  `&#60;script&#62;window.__pwn=true&#60;/script&#62;`,

  // 8. Event handler on a non-script tag — fires if React's normalization is
  //    bypassed (it shouldn't be, but the test proves the negative)
  `<div onclick="window.__pwn=true">click</div>`,

  // 9. SVG-based XSS — uses a different parsing context than <html>
  `<svg><script>window.__pwn=true</script></svg>`,

  // 10. Mixed-case <ScRiPt> — defeats naive case-sensitive sanitizers
  `<ScRiPt>window.__pwn=true</ScRiPt>`,

  // 11. Body onload — fires if HTML is parsed into a fragment
  `"><body onload="window.__pwn=true">`,
] as const;

/**
 * `window.__pwn` is the canary. Any payload that successfully executes will
 * write `true` to this global. Tests assert it is undefined after rendering.
 */
declare global {
  interface Window {
    __pwn?: boolean;
  }
}
