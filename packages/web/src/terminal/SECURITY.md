# dispatch terminal — security posture (Phase 2)

Last updated: 2026-05-22 (Slice 7 wrap).

This doc ties together the Phase 2 security surface of the dispatch embedded
local terminal. It is written for the next engineer who lands on this
directory and is about to change something — read it before you touch any
file under `packages/web/src/terminal/`, `packages/companion/`, or any
security plugin under `packages/api/src/plugins/`.

The terminal is a `node-pty` shell running on the SE's laptop, with bytes
flowing over a localhost WebSocket between the dispatch SPA and a sibling
Companion process. It is not sandboxed. Bytes that reach the shell run with
the SE's user privileges.

## Threat model

**Headline.** An XSS anywhere on `dispatch.paintos.app` → arbitrary
local-command RCE on every SE machine with a terminal panel open.

The Phase 2 blast radius is meaningfully wider than Phase 1's. Spike #1
established a path for "XSS in the SPA → bytes typed into a `claude` CLI
process bound to a single command". Phase 2 widens that to "XSS in the SPA
→ bytes typed into a `$SHELL -l` zsh session, which can run any command the
SE could run from Terminal.app". `rm`, `curl | bash`, `defaults write`,
`security find-internet-password`, the whole keychain — all reachable from
a single working XSS sink.

That threat shape is the reason every layer below exists, and the reason
this directory has its own security doc instead of leaning on the SPA-wide
one in `packages/web/src/security/`.

## Defense layers (mapped to slices)

The defense is layered — no single layer is "the" defense. Each slice
added the layer it ships against the threat as the surface grew.

### Slice 0 — SPA-wide security infrastructure

| Component | File | What it does |
|---|---|---|
| Custom CSP plugin | `packages/api/src/plugins/csp.ts` | Per-request nonce; `script-src-elem 'self' 'strict-dynamic' 'nonce-…'`; `script-src-attr 'none'`; no `'unsafe-inline'` on script directives; no `'unsafe-eval'` anywhere. Carve-out: `style-src-attr 'unsafe-inline'` (Phase 3 follow-up — see below). |
| Helmet headers | `packages/api/src/plugins/helmet.ts` | COOP `same-origin`, CORP `same-origin`, frame-ancestors `'none'`, Referrer-Policy `no-referrer`, X-Content-Type-Options `nosniff`. |
| Lint rules | `eslint.config.js` | `no-eval`, `no-implied-eval`, `no-new-func`, `no-restricted-properties` on `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`, `react/no-danger`. Build fails on violation. |
| Cross-route XSS rig | `packages/web/src/security/xss-routes.test.tsx` | Renders every SPA route with the 11-payload corpus from `payloads.ts` in every user-controllable string field; asserts `window.__pwn` stays undefined and no `<script>`/`<iframe>` lands in the DOM. |
| CSP-header contract test | `packages/api/test/csp-headers.test.ts` | Asserts the exact directive list against the API response. |

### Slice 1 — Companion-side authorization + env safety

| Component | File | What it does |
|---|---|---|
| Per-PTY ownership authz | `packages/companion/src/pty-map.ts` | Every `pty.write` / `pty.resize` / `pty.close` frame is checked against a connection-owned PTY registry. A frame for a `pty_id` not owned by the connection's WebSocket is rejected with `pty.error { code: 'forbidden' }`. (Codex design checkpoint F2 binding.) |
| Env allowlist + deny-suffix | `packages/companion/src/pty-session.ts` | The shell spawn inherits an explicit allowlist. `ANTHROPIC_*`, `CLAUDE_*`, and any var with a `*_SECRET`/`*_KEY`/`*_TOKEN`/`*_PASSWORD` suffix is **never** passed to the spawned shell. Asserted by `pty-env.test.ts`. |
| Windows-refuses fence | `packages/companion/src/main.ts` | If `process.platform === 'win32'`, the Companion refuses to start with a Phase 3 message. ADR-007 binding. |
| Idle sweeper | `packages/companion/src/idle-sweeper.ts` | Reaps PTYs whose connection has been gone for >5 min. **Only** reaps detached PTYs — never live-WS quiet PTYs. Injectable clock + cadence for tests. |

### Slice 2 — xterm renderer + per-ticket scrollback partitioning

| Component | File | What it does |
|---|---|---|
| WebGL canvas renderer | `packages/web/src/terminal/use-terminal.ts` | xterm renders cell-by-cell via WebGL. Literal HTML in the byte stream is rendered as text glyphs; it cannot escape to the DOM tree. Fallback DOM renderer behaves the same way. |
| Per-`(ticket_id, pty_id)` IDB partition | `packages/web/src/terminal/scrollback-store.ts` | One IndexedDB store. Composite key `${ticket_id}::${pty_id}::${seq}`. Reads + writes for one ticket cannot touch another ticket's bytes. |

### Slice 3 — Popout same-origin assertion + opener-close detection

| Component | File | What it does |
|---|---|---|
| Same-origin assertion at boot | `packages/web/src/routes/terminal-popout.tsx` | The popout's first effect verifies `window.opener.location.origin === window.location.origin`; if not (cross-origin or detached), the page renders an inert "Detached" surface and refuses to subscribe. Wrapped in try/catch — accessing `opener.location` on a cross-origin opener throws by spec. |
| Opener-close detection | `packages/web/src/terminal/popout-bridge.ts` | Polls `window.opener.closed` every 500 ms; on detection, locks the popout terminal with the "Main dispatch window closed" banner. The terminal is removed from the live xterm host so further bytes cannot land. |
| Cap = 1 popout per PTY | `packages/web/src/terminal/popout-bridge.ts` | A `BroadcastChannel`-coordinated lock ensures only one popout window can attach to any given `pty_id`. The second open returns an info toast. |

### Slice 4 — Launcher first-edit consent + server-side audit

| Component | File | What it does |
|---|---|---|
| First-edit consent modal | `packages/web/src/terminal/launcher-consent-modal.tsx` | When the SE changes the default `claude` launcher command for the first time, a modal explains: "this string is sent verbatim to your shell. No sandboxing." Stamping `launcherConsentedAt` in Clerk `publicMetadata` is required before the new command takes effect. |
| Server-side audit POST | `packages/api/src/routes/audit/launcher.ts` | On every launcher fire, the SPA POSTs a SHA-256 hash of the command, the user_id, the ticket_id, and the timestamp. The **raw command never leaves the browser** — only the hash. Backstop log + change-detection signal. |
| Rate limit | `packages/api/src/routes/audit/launcher.ts` | 10 fires/min/user. A flood would be exfiltration symptomatic. |

### Slice 5 — Settings persistence (Clerk publicMetadata, versioned)

| Component | File | What it does |
|---|---|---|
| Namespaced + versioned schema | `packages/web/src/settings/use-terminal-settings.ts` | All settings live under `user.publicMetadata.terminalSettings` with `_v: 1`. Future schema bumps fork on `_v`. |
| Read-fresh + per-field merge + retry-once | `packages/web/src/settings/use-terminal-settings.ts` | RMW path: read fresh `publicMetadata`, merge the changed field, write. On `409 conflict`, retry once with a fresh read. (Codex F6 binding.) |
| 6 KB budget + persistent unsaved indicator | `packages/web/src/settings/use-terminal-settings.ts` | Clerk's `publicMetadata` cap is hardcoded to 8 KB; we conservatively use 6 KB. Any save that would exceed it leaves the "Unsaved" chip visible so the SE notices. |
| Two-tab race test | `packages/web/src/settings/use-terminal-settings.race.test.ts` | Two concurrent saves resolve to one-merged-final-state. |

### Slice 7 — This slice

| Component | File | What it does |
|---|---|---|
| Terminal-specific XSS fuzz | `packages/web/src/terminal/xss-fuzz.test.ts` | Mounts the `Terminal` component with a mock transport and feeds the `pty.data` channel ANSI escapes, OSC 8 hyperlinks with `javascript:` URIs, URL-encoded HTML, base64-decoded HTML, mojibake / overlong UTF-8 / BOM, bracketed-paste-mode escape attempts, and combined-soup payloads. Asserts: no DOM injection, no `document.title` mutation, no clickable `javascript:` link, no settings-control write into the live terminal. 17 assertions. |
| This doc | `packages/web/src/terminal/SECURITY.md` | The wrap. |

## Non-mitigations (called out explicitly so they don't get confused with security)

These are easy to mistake for security controls. They are not.

### The launcher regex is a footgun-nudge, NOT a sandbox

The Settings → Terminal launcher control accepts an arbitrary string. The
SPA-side regex on the input only nudges away from `rm -rf` shapes — it does
not parse the shell command, it does not enforce a syntax, it does not
prevent dangerous bytes from reaching the shell. **Bytes go raw to the
shell.** Treat the launcher field as `eval`. The Slice 4 consent modal
exists because of this. The audit POST exists because of this. The 10/min
rate limit exists because of this. The regex itself is decorative.

### The optimistic UI in Settings is UX, NOT durability

The Settings page renders the saved-state pill as "Saved" the moment the
PATCH resolves locally. The PATCH is not durable until Clerk's
`publicMetadata` writer has fanned out — there's a multi-second window
where a hostile actor with sufficient access could read-modify-write
around your save. The mitigation is the read-fresh + per-field merge +
retry-once RMW path (S5). The pill's optimism is just UX.

### The Clerk metadata race retry-once narrows but does not eliminate the overlapping-reads window

The RMW path retries once on `409 conflict`. Under sustained overlap (two
SE clients writing the same user's metadata concurrently and repeatedly),
the second writer can still win after the first writer's retry has
landed. The fix is to move `terminalSettings` to a dispatch-DB-backed
endpoint with a per-user mutex — see Phase 3 follow-ups.

## Maintenance procedure

**If you change anything in this directory, run these commands before
merging.** None of them are slow; together they are about 6 seconds.

```bash
# 1. The SPA-wide XSS rig — proves no React route can be coerced into an
#    eval-shaped sink. If you added a route, add it to xss-routes.test.tsx's
#    route list first.
pnpm --filter @dispatch/web test --run xss-routes

# 2. The terminal-specific fuzz — proves the bytes → xterm path is inert
#    against ANSI escape attacks and that the settings-control path does
#    not write to the live terminal.
pnpm --filter @dispatch/web test --run xss-fuzz

# 3. The CSP-header contract — if you change anything that touches the
#    CSP plugin, this test will fail with the exact diff.
pnpm --filter @dispatch/api test --run csp-headers

# 4. The Companion PTY-map ownership tests — if you change auth.ts or
#    pty-map.ts, this verifies the per-PTY authz model is still intact.
pnpm --filter @dispatch/companion test --run pty-map
```

The 75 inline React styles refactor is tracked at
`docs/follow-ups/inline-styles-refactor.md`. **Do not increase the count.**
Every additional inline style widens the carve-out we have to keep on
`style-src-attr 'unsafe-inline'` and pushes the Phase 3 hardening date out.

## Phase 3 follow-ups

Captured here so they survive the Phase 2 merge and the next contributor
sees them without spelunking the build-run artifacts.

1. **Move `terminalSettings` to a dispatch-DB-backed endpoint with a
   per-user mutex.** Kills the Clerk overlapping-reads race entirely. The
   shape would be `GET/PATCH /api/me/terminal-settings` against a single
   row keyed by `user_id` with a row-level lock. Estimated 1 slice.

2. **Refactor the 75 inline React styles to CSS classes.** Lets us drop
   `style-src-attr 'unsafe-inline'` from the CSP. Each inline style is one
   property change; the patch is mechanical. Tracked separately because
   the change spans many files and would conflict with active feature
   work.

3. **Companion installer + Sparkle auto-update.** OQ-7 deferred. The
   2-person pilot deploys via `pnpm run companion` from a checkout, which
   is fine for the bench but not fine for a wider rollout. Signed `.pkg`
   + launchd `.plist` + Sparkle auto-update is the canonical macOS
   distribution path. Estimated 2-3 slices including signing infra setup.

4. **Multi-render UI (v1.5).** The Slice 6 tab-strip stub already
   single-renders an existing multi-PTY data model. The flip to
   interactive tabs is a UI-only change — the data layer is ready.

5. **Native Windows Companion (Phase 3 parachute) or finalize the
   container-based path.** ADR-007 fences out Windows in Phase 2. The
   Phase 3 parachute is documented in the spec but not built.

## See also

- `packages/web/src/security/payloads.ts` — the SPA-wide XSS payload
  corpus (11 entries). Extend here if you find a new SPA-wide payload
  shape; extend `xss-fuzz.test.ts` if you find a new ANSI/escape shape.
- `packages/api/src/plugins/csp.ts` — the per-request CSP nonce plugin.
  The header comment in that file references this doc.
- `docs/adr/ADR-007-companion-platform-fence.md` — Windows refuses-to-start
  rationale.
- `CONTEXT.md` — the Phase 2 operator brief; references this doc.
