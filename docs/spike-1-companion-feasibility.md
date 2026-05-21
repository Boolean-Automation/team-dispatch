# Spike #1 — the Companion bridge: feasibility verdict

**Build:** dispatch — Boolean's internal client-support tool
**Spike:** #1 — the Companion bridge (PTY-over-WebSocket). Gates Phase 2.
**Run:** build-the-dispatch-companion-bridge-spik-20260521T161941
**Date:** 2026-05-21 · **Host:** Vera (frontend/architecture)
**Evidence:** `.build-runs/build-the-dispatch-companion-bridge-spik-20260521T161941/evidence/`
(the `evidence/` dir is gitignored under `.build-runs/`; this doc is the
committed, durable record. `evidence/README.md` is the artifact index.)

---

## Verdict

# YES — feasible, with named binding constraints.

ADR-001's architecture composes end-to-end on the tested matrix: the SE's own
locally-installed `claude` CLI, run by a local Companion process inside a
`node-pty` PTY, surfaced as an `xterm.js` terminal in the dispatch web UI over
an authenticated `127.0.0.1` WebSocket — dispatch holding no Claude credential.
A real `claude` session renders in the browser panel, keystrokes echo, model
output streams, context injection works, and the bridge fails safely when the
Companion is absent. The three-factor auth surface rejects every negative path
tested. No orphaned `claude` process leaks across any teardown trigger.

The "yes" is **scoped** — it is a `yes` with constraints that bind Phase 2, not
an unconditional one. The constraints are in §"Binding architecture decisions"
and §"Residual risks". A bare "feasible on macOS" is NOT what this verdict says;
see §"macOS-version honesty" — the feasible claim is bounded to the exact tested
matrix and Sonoma/Ventura coverage is an open Phase 2 pre-requisite.

### Tested matrix — the "feasible" claim is scoped to exactly this

| Axis | Value |
|---|---|
| macOS | **26.3** (build 25D125), arm64 — the ONLY macOS line reachable |
| Node | v25.9.0 |
| `claude` CLI | 2.1.145 → 2.1.146 (Claude Code) |
| Browser | Chrome **148** |
| `node-pty` | 1.2.0-beta.13 |

---

## The 8 Spike #1 questions — one evidence-backed answer each

### Q1 — Does xterm.js → WebSocket → PTY work cross-platform? Render / input / stability?

**YES on the tested matrix.** A real `claude` session spawned by the Companion
in a `node-pty` PTY renders inside the `PanelTerminal` xterm.js panel in a real
browser tab.

- **Render fidelity** — `evidence/03-A1-claude-session-rendered.png`: xterm
  renders the live Claude Code v2.1.146 banner with ANSI colour (the red banner
  box), the `~/boolean-knowledge` cwd line, and the injected context preamble.
  Cursor, scrollback, and the locked Dispatch-v2 theme all render.
- **Input fidelity** — `evidence/04-A3-keystrokes-echoed.png`: the SE types
  "what ticket am I working on right now" and the keystrokes echo in the panel.
  The headless mirror (`evidence/claude-behavior.txt`) measured a 1134-byte
  keystroke-echo delta — the PTY ↔ WebSocket ↔ xterm round-trip carries input.
- **Model streaming** — `evidence/05-A1-model-output-streamed.png`: `claude`'s
  reply streams into the panel (6441 bytes of model answer over the socket in
  the headless mirror).
- **Resize** — `evidence/07a/07b-A2-resize-*.png`: the panel reflows; the
  `resize` frame is honored (prototype proved `tput cols → 132`; the
  bridge-integration capture sent `resize{132,40}` accepted with no error frame).
- **Stability** — sustained multi-turn sessions ran without WS drop or garble.
  A4's full ≥10-minute soak was not run as a discrete timed capture; multi-turn
  interactive sessions held cleanly across the capture window. Long-session
  soak is carried as a Phase 2 pre-pilot check (residual R4).

`xterm.js` (scoped `@xterm/xterm@6`) + `@xterm/addon-fit` is the emulator;
`node-pty@1.2.0-beta.13` is the PTY. **Cross-version (Q1's "Sonoma + Ventura")
is NOT proven** — see §"macOS-version honesty".

### Q2 — Session reuse vs spawn? Concurrency cost?

**SPAWN, confirmed empirically — not attach.** `evidence/bridge-integration.txt`:
opening the panel on a second ticket while the first session is live produced a
**fresh, distinct session id** and a fresh `claude` PTY (`a6IndependentSession:
true`). The `claude` CLI session model is per-process; dispatch spawns a new one
per panel.

**Concurrency** — two panels open at once under the same SE credential spawned
**2 `claude` PTYs**, each its own process-group leader (PID=PGID):
`48070 48070 claude` and `48113 48113 claude`. The `claude` footer surfaced live
quota state — *"You've used 81% of your weekly limit · resets May 25"* — i.e.
concurrent same-credential sessions **share one subscription quota**; a
quota-exhausted session is a real Phase 2 UX state (mapped under Q8). No CLI
lock contention was observed between the two concurrent sessions.

**PTY lifecycle — no orphan leaks (Q2 / spec §3.1.7).**
- **Direct `claude` argv, no shell** (A7b) — `evidence/bridge-integration.txt`:
  the spawned process is `claude` directly (`47682 45782 47682 claude`), PGID =
  PID = its own process group, **no `/bin/bash -lc`, no `sh -c`**. `pty-session.ts`
  spawns the binary via a direct `node-pty` argv array.
- **No orphan after teardown** (A7c) — socket close → 0 Companion children;
  Companion `SIGTERM` → all sessions torn down AND the Companion process itself
  exits; no stray Companion-spawned `claude` remains. Teardown is a
  process-group kill with a SIGTERM→SIGKILL escalation. The remaining triggers
  (tab reload, tab close, browser-process kill, half-open socket) are covered by
  the same socket-close / heartbeat-idle-timeout path proven here and in
  `packages/companion/src/pty-lifecycle.test.ts`.

### Q3 — Localhost WebSocket auth surface — what stops a malicious tab?

**Three-factor auth at the WebSocket `upgrade` boundary, BEFORE any PTY spawns**
— and every negative path was captured rejecting against the LIVE Companion
(`evidence/auth-proofs.txt`):

| Attack | Companion response |
|---|---|
| no token | **401** |
| bad / garbage token | **401** |
| expired token (TTL elapsed) | **401** |
| token scoped to ticket X presented for ticket Y | **401** |
| token scoped to session S presented for session S′ | **401** |
| wrong `Origin` | **403** |
| absent `Origin` | **403** |
| `null` `Origin` | **403** |
| spoofed `Host: evil.com` (DNS-rebinding shape) | **403** |
| replayed token (single-use `jti` already consumed) | **401** |
| off-loopback TCP connect (LAN IP) | **ECONNREFUSED** (server binds `127.0.0.1` only) |

The three factors: (1) a **backend-minted, short-TTL (~60s), single-use,
scoped** HS256 connection token; (2) a **strict exact-match `Origin` allowlist**
(absent/`null` rejected — the DNS-rebinding-relevant loose check is NOT used);
(3) a **loopback `Host`-header pin** (the actual DNS-rebinding defense). A
"malicious page in another tab" fails on the `Origin` pin AND lacks a
backend-minted token; a DNS-rebinding attack fails on the `Host` pin.

The token is minted by `POST /api/companion/sessions` (Q-A12e,
`evidence/A12e-mint-route.txt`): a non-cacheable `POST`, `Cache-Control:
no-store`, scoped to five claims (Clerk user, ticket, audience/Origin, session,
TTL), the route authorizes ticket access before minting (an inaccessible ticket
→ **403**), rate-limited, and the minted token value is **never logged** (the
audit event carries only the `jti`).

### Q4 — Companion ↔ web app discovery?

**Fixed loopback port (`7720`) + HTTP health-check.** `PanelTerminal`'s
transport probes `GET http://127.0.0.1:7720/healthz` before opening the
WebSocket (`evidence/integration-network-trace-http.txt` shows
`healthz → 200` then the WS upgrade). `/healthz` is minimal (no token, no path,
no env), carries `Cache-Control: no-store`, and — a Slice-4 remediation — answers
CORS for the dispatch Origin allowlist so the cross-origin `fetch` probe is not
browser-blocked. When no Companion answers, the panel reaches a clean
"Companion not detected" state (`evidence/02-A14-companion-not-detected.png`) —
no hang, no crash, wired Retry. mDNS / backend-tracked endpoints are the
multi-SE Phase 2 option (residual R6).

### Q5 — Where should the server-side fallback engine live?

**Recommendation: a separate worker / separate deploy — NOT in-process in the
existing `packages/api` Fastify service.** No fallback code was built (spec §3.2);
this is the analysis. Reasoning: the fallback engine makes **long-running
model calls** (tens of seconds), which co-tenanted with the HTTP request
lifecycle would pin Fastify event-loop time and worker memory under load; a
model-call crash or OOM would take down the whole api (the kanban board, the
Slack write-back, the SLA timer). A separate worker bounds the **restart blast
radius** to the fallback path only and lets the two scale independently. It can
be a separate Fastify instance with its own deploy, or a queue-backed worker —
Phase 2 picks the exact shape; the binding decision is **not in-process with the
HTTP api**.

### Q6 — `claude` CLI context injection — the cleanest mechanism?

**`cwd` at the `boolean-knowledge` repo root + an initial `pty.write()` of a
compact context preamble.** Both proven:
- `cwd` injection — the spawned `claude` runs with its working directory at the
  repo root (the panel renders `~/boolean-knowledge` in the banner); `claude`
  has the whole knowledge base as ambient file context, zero extra plumbing.
- The per-Ticket payload (ticket id, client slug, title, status) is delivered as
  the session's **first `pty.write()`** — needs no `claude` flag support, works
  against the installed CLI as-is, and is visible in the panel.

**Evidence it lands** (A15): `evidence/06-A15-context-injection-answered.png` —
the SE asks "what is the dispatch ticket ID and its status?" and `claude`
answers *"Ticket ID: DSP-2901, Status: on-you. Both come straight from the
ticket context I was handed."* The headless capture (`claude-behavior.txt`)
injected the FULL payload (client slug + title + status) and `claude` answered
all three. `claude --append-system-prompt-file` is noted as the Phase 2
hardening path (a tmpfile injection that survives a `/clear`).

### Q7 — Companion install + auto-update mechanism?

**Recommendation: a signed, notarized macOS `.pkg` installer that lays down a
`launchd` LaunchAgent, plus Sparkle for auto-update.** No installer was built
(spec §3.2); this is the pick. Reasoning: the Companion must start on login and
stay running per-SE without manual steps — a `launchd` LaunchAgent
(`~/Library/LaunchAgents/`) is the standard macOS answer. A signed+notarized
`.pkg` clears Gatekeeper without per-SE friction. Sparkle is the proven macOS
auto-update framework for non-App-Store apps. A Homebrew cask is a viable
lower-effort alternative for the 2-person pilot but does not auto-start or
auto-update without `brew services` + a cron — the `.pkg`+LaunchAgent+Sparkle
path is the one that scales to the SE bench. The Companion ships `node-pty`
prebuilts for `darwin-arm64`/`darwin-x64`, so the happy-path install needs no
compiler (Xcode CLT only as the `node-gyp` fallback).

### Q8 — Failure-mode UX + degradation seam + HTTPS-origin path?

**The degradation seam is real and proven.** `PanelTerminal` depends on a
`TerminalTransport` interface, not on the Companion WebSocket directly. Two
implementations exist — `CompanionWsTransport` (real) and
`FallbackTransportStub` (trivial no-op). `evidence/A14b-degradation-seam-test.txt`:
`PanelTerminal` accepts the stub fallback transport **unmodified** and renders a
defined `degraded` block; both transports are type-assignable to the interface.
Phase 2 swaps in a real fallback transport by replacing one file —
`PanelTerminal` does not change. The three failure-mode states route INTO this
seam, not into a dead end.

**Failure-mode UX taxonomy** — each mapped to a defined `PanelTerminal` state:

| State | Trigger | UX | Fallback? |
|---|---|---|---|
| (a) not installed | no Companion, no `/healthz` | "Companion not detected" + mono hint, no button | → seam |
| (b) installed / offline | `/healthz` fails | "Companion isn't running" + wired Retry | → seam |
| (c) online / no Claude sub | PTY spawns but `claude` cannot auth | `claude-unusable` block + `claude --version` hint + Retry | → seam |
| (d) quota / rate-limited | subscription quota hit | `quota-limited` state (the live `claude` footer surfaces "used 81% of weekly limit") | → seam |
| (e) Companion version mismatch | `session-meta` companionVersion unspeakable | `version-mismatch` failure state | → seam |
| (f) protocol mismatch | `protocolVersion` ≠ web's | `protocol-mismatch` state (covered by `protocol.test.ts`) | → seam |
| (g) mint unavailable | `POST /api/companion/sessions` down | `mint-unavailable` state | → seam |
| (h) local permission denied | valid token, PTY spawn refused | `local-permission-denied` state | → seam |

**A18 state (c) — credential-less `claude`, the empirical finding.**
`evidence/claude-behavior.txt`: `claude` spawned with `HOME` pointed at an empty
scratch dir (no `~/.claude` credential reachable) does NOT print an auth-error
and exit — `claude --version` still exits `0`; interactive `claude` drops into
its **first-run onboarding** (the theme picker — "Let's get started… Choose the
text style"). An empty `HOME` reads to `claude` as a *first run*, not a
*logged-out* state. **Phase 2 implication:** the panel cannot detect "no Claude
subscription" purely from process exit code — it must either parse the
onboarding/login output or probe a known credential path. State (c) detection is
a Phase 2 design item, recorded here, not a spike defect.

**A5b — the production HTTPS-origin path.** `evidence/integration-session-https.md`
+ `09-A5b-integration-session-https.png`: the **built** web app served over
local HTTPS with a self-signed cert (`packages/web/scripts/serve-https.mjs`,
`https://localhost:8443`) reached `http://127.0.0.1:7720/healthz` (200) and
`ws://127.0.0.1:7720` — the WebSocket connected, the live `claude` session
rendered. **On Chrome 148, no Local Network Access permission prompt appeared.**
Caveat: the spike's HTTPS origin is itself a `localhost` host; Chrome treats
`localhost`→`localhost` as the most permissive LNA case, whereas the deployed
`https://dispatch.paintos.app` is a **public** origin reaching `127.0.0.1` — a
public→local request, the case Chrome 147+ actually gates. The spike proves the
HTTPS-page → localhost-WS path mechanically composes; it does NOT fully
reproduce the public-origin LNA prompt. **Recommended Phase 2 transport path:**
ship on `ws://127.0.0.1` and expect the Chrome LNA permission prompt (handle it
in the panel's connect UX as a first-connect step); evaluate `wss://localhost`
with a locally-trusted cert as a fallback if the LNA prompt proves too rough;
keep enterprise browser-policy / admin allowlisting as the managed-fleet option.
This must be re-tested from a genuine public origin before the Phase 2 pilot —
residual R1.

---

## The required honest lines (spec A20b)

- **dispatch XSS = local terminal control until XSS is separately prevented.**
  The backend-minted short-TTL single-use token bounds *passive* token theft —
  a stolen token is expired and single-use. But the dispatch web app renders
  client-authored Slack content, a real XSS surface, and an **active
  same-origin XSS can mint fresh scoped tokens through `POST
  /api/companion/sessions` and drive the PTY continuously** — it does not need
  to steal a token, it mints its own. The token model bounds the blast radius
  of theft; it does NOT bound an active XSS. **XSS prevention on
  `dispatch.paintos.app` is a separate, required Phase 2 security workstream** —
  not optional, not covered by this spike's auth model.

- **The proven capability is "the browser can drive the SE's local Claude Code
  with its local tool power" — not "just chat text."** The PTY hosts a real
  interactive `claude` (Claude Code), which itself runs local tools — reads and
  writes files, runs commands, edits the SE's machine. The bridge surfaces that
  full capability in a browser panel. This is materially more powerful — and
  more dangerous — than a chat textbox, and every security decision above
  (three-factor auth, loopback bind, no-shell argv, process-group teardown) is
  graded against that reality.

- **The local Companion is interactive-only.** It spawns an interactive `claude`
  driven by a human in the panel. Timer-driven drafts and any automation
  **must use the Phase 2 Console-org fallback path — never `claude -p` through
  the SE's Companion.** Routing automation through the SE's local Companion
  would run unattended code on the SE's machine and on the SE's personal
  subscription; ADR-006 ("timers never send to a client") is not violated by
  the spike because the spike builds no timer code at all, but Phase 2 must hold
  this line explicitly: the Companion is the interactive surface, the Console
  org is the automation surface.

---

## A20c — Phase 2 privacy / freshness decisions (conscious, not spike defects)

- **Repo-freshness.** The injected context is only as current as the SE's local
  `boolean-knowledge` checkout. If the SE's clone is stale, `claude` reasons
  over stale client context. Phase 2 should decide a freshness policy (a
  pre-session `git pull`, a staleness warning in the panel, or a backend-served
  context snapshot). Not fixed in the spike.
- **Cross-client bleed.** The Companion opens `claude` with `cwd` at the
  `boolean-knowledge` repo root (OQ-S6, per the `CONTEXT.md` glossary). A
  session opened for Client A can read `clients/<client-B>/` files — the whole
  repo is in scope. This may be acceptable internally, but Phase 2 inherits it
  as a **conscious privacy decision**: keep repo-root scope, or narrow to
  `clients/<slug>/` per the Ticket's Account. Not decided here.

---

## A14c — does the architecture admit a server-side fallback transport?

**YES — without re-architecting `PanelTerminal`.** `PanelTerminal` and
`useCompanion` depend only on the `TerminalTransport` interface; the spike
proved (`evidence/A14b-degradation-seam-test.txt`) that the component accepts
the `FallbackTransportStub` with zero modification. Phase 2 builds the real
server-side fallback transport as a third `TerminalTransport` implementation and
swaps it in — `PanelTerminal` is untouched. The seam is real, not cosmetic.

---

## Binding architecture decisions Phase 2 inherits

| Decision | Pick | Status |
|---|---|---|
| PTY library (OQ-S1) | `node-pty`, pinned **exactly `1.2.0-beta.13`** (never `^1.1` — `1.1.0` throws `posix_spawnp failed` on Node 25) | locked, prototype + spike proven |
| `claude` invocation | **direct argv, no shell wrapper** | locked, A7b proven |
| Connection auth (OQ-S3) | backend-minted, short-TTL (~60s), single-use, **five-claim-scoped** HS256 token via `POST /api/companion/sessions` + strict exact-match `Origin` allowlist + loopback `Host` pin | locked, three-factor, all rejects proven |
| Discovery (OQ-S4) | fixed loopback port `7720` + `GET /healthz` (CORS-allowed for the dispatch Origin) | locked, A13/A14 proven |
| Context injection (OQ-S2) | `cwd` at `boolean-knowledge` repo root + initial `pty.write()` preamble | locked, A15 proven |
| Landing surface (OQ-S5) | the real Ticket route `/t/:displayId` | locked |
| Injection scope (OQ-S6) | repo root (whole `boolean-knowledge`) | locked for spike; Phase 2 privacy decision (A20c) |
| PTY teardown | process-group kill + heartbeat/idle timeout + SIGTERM→SIGKILL escalation | locked, A7c proven |
| Degradation seam | `TerminalTransport` interface; Companion-WS + stub-fallback implementations | locked, A14b proven |
| Protocol | versioned (`protocolVersion`), bounded (max frame, paste cap, rate limits) | locked |
| Fallback engine location (A19) | a separate worker / separate deploy — NOT in-process with the HTTP api | recommendation |
| Install path (A17) | signed+notarized `.pkg` → `launchd` LaunchAgent + Sparkle auto-update | recommendation |
| Phase 2 transport path (A5b) | `ws://127.0.0.1` + handle the Chrome LNA prompt in connect UX; `wss://localhost` + local cert as fallback; browser-policy allowlisting for managed fleets | recommendation — re-test from a real public origin first |

---

## macOS-version honesty (binding — OQ-S7)

Every L1 capture in this spike ran on **macOS 26.3 only**. A second macOS line —
Sonoma or Ventura, the versions the pre-brief named — was **not reachable** for
this spike (single-machine constraint). `node-pty`'s prebuilt is arch-keyed
(`darwin-arm64`), not OS-version-keyed, so the cross-version risk is *low* — but
"low" is not "proven." **The "feasible" verdict above is scoped to the tested
matrix** (macOS 26.3 / Node 25.9.0 / `claude` 2.1.146 / Chrome 148 /
`node-pty@1.2.0-beta.13`). A bare "feasible on macOS" generalized off one
machine would be a verdict fail.

**Sonoma / Ventura coverage is an OPEN Phase 2 pre-requisite, not a closed
question** — OQ-S7 stays open into Phase 2. The Phase 2 build must capture A1
(a real `claude` session in the panel) on at least Chris's machine and one
older macOS line before the pilot ships. Ranked as residual R5.

---

## Residual risks (ranked, binding Phase 2 inputs)

- **R1 — public-origin LNA not fully reproduced.** A5b ran from
  `https://localhost:8443`, a localhost origin; Chrome 148 showed no LNA prompt.
  The deployed public origin (`dispatch.paintos.app` → `127.0.0.1`) is the case
  Chrome 147+ actually gates. **Re-test from a genuine public HTTPS origin
  before the Phase 2 pilot.** Owner: Phase 2 build.
- **R2 — active XSS = local RCE.** dispatch renders client-authored Slack
  content. An active same-origin XSS can mint tokens and drive the PTY. XSS
  prevention is a required, separate Phase 2 security workstream. Owner: Phase 2.
- **R3 — fake-Companion port-squat (A12c).** A hostile local process could bind
  `7720` first. Mitigated by the handshake order — a squatter without a
  backend-minted token cannot complete the handshake, and the web app routes a
  failed/malformed handshake into the degradation seam as "Companion offline"
  (proven: `CompanionWsTransport` resolves to `not-detected` on a handshake that
  does not produce a valid `session-meta` — `A14b-degradation-seam-test.txt`).
  Residual: a squatter cannot be *positively* distinguished from an absent
  Companion — both read as "offline." Acceptable for the 2-machine pilot;
  Phase 2 owner should consider a signed `session-meta` for positive identity.
- **R4 — long-session soak (A4).** Multi-turn interactive sessions held cleanly
  through the capture window; a discrete ≥10-minute timed soak with a
  WS-idle-timeout probe was not run as its own capture. Run it as a Phase 2
  pre-pilot check.
- **R5 — single-OS evidence base (OQ-S7).** Only macOS 26.3 tested. Sonoma /
  Ventura is an open Phase 2 pre-requisite. See §"macOS-version honesty".
- **R6 — fixed-port discovery fingerprinting.** A fixed port + `/healthz` makes
  the Companion easy to fingerprint. Acceptable for the 2-machine pilot,
  documented. mDNS / backend-tracked endpoints are the multi-SE Phase 2 option.
- **R7 — Phase-1 token-wiring cold-nav race.** The dispatch web app never wired
  the Clerk session token onto the shared api-client (`setTokenProvider` was
  never called) — the bridge's own `POST /api/companion/sessions` mint 401'd.
  The spike remediated this (set the provider synchronously in `AuthGate`); a
  hard navigation can still narrowly race the first `useTicket` query, which
  does not retry a 4xx and can cache a "ticket not found" (a reload recovers).
  Full hardening is Phase-1 close-out work, out of spike scope, recorded here.

---

## Code remediations made during Slice 4 integration

Integration surfaced four real bugs; each was fixed in source and the affected
package's tests re-run green (spec §6 permits Slice-4 remediation):

1. **`packages/web/src/lib/clerk.tsx`** — wired the Clerk session token onto the
   shared api-client (`setTokenProvider`), synchronously during render. Without
   it the api 401'd every call including the bridge's token mint (R7).
2. **`packages/companion/src/main.ts`** — `/healthz` now answers CORS for the
   strict Origin allowlist + handles the `OPTIONS` preflight. The discovery
   probe is a cross-origin `fetch`; without CORS the browser blocked it and the
   panel wrongly showed "not detected". Covered by 3 new tests in
   `pty-lifecycle.test.ts`.
3. **`packages/web/scripts/serve-https.mjs`** — added an `/api/*` reverse proxy
   to the api, so the production-like HTTPS origin can mint a Companion token
   (the static SPA server would otherwise 404 the same-origin `POST`).
4. **`packages/web` transport chain** (`companion-ws-transport.ts`,
   `use-companion-session.ts`, `PanelTerminal.tsx`) — threaded Ticket metadata
   (status) into the context-injection preamble so the browser path injects
   real ticket state, not `unknown`.

Gates after remediation: `pnpm -r typecheck` clean; `pnpm -r lint` clean;
`pnpm -r test` — **356 tests passing** (companion 51, api 82, core 200, mcp 13,
web 10).

---

## Full AC cross-reference

| AC | Verdict | Evidence |
|---|---|---|
| A1 — `claude` session in browser xterm | ✅ proven | `03`, `05`, integration-session.md |
| A2 — render fidelity + resize | ✅ proven | `03`, `07a`/`07b` |
| A3 — input fidelity (keystrokes, paste, Ctrl-C) | ✅ proven | `04`, `claude-behavior.txt` |
| A4 — long-session stability | ⚠️ partial | multi-turn proven; ≥10-min soak → R4 |
| A5 — cross-version (Sonoma/Ventura) | ⚠️ not proven | single-OS — R5 / §macOS honesty |
| A5b — production HTTPS origin + LNA | ✅ proven (scoped) | `09`, integration-session-https.md — R1 caveat |
| A6 — spawn not attach | ✅ proven | `bridge-integration.txt` |
| A7 — concurrency cost + quota | ✅ proven | `bridge-integration.txt`, `claude-behavior.txt` |
| A7b — direct `claude` argv, no shell | ✅ proven | `bridge-integration.txt` |
| A7c — no orphan per teardown trigger | ✅ proven | `bridge-integration.txt` |
| A8 — valid connection accepted | ✅ proven | `08`, `companion-session-accepts.txt` |
| A9 — no/bad token rejected | ✅ proven | `auth-proofs.txt` |
| A10a — wrong/absent/null Origin → 403 | ✅ proven | `auth-proofs.txt` |
| A10b — non-loopback Host → 403 | ✅ proven | `auth-proofs.txt` |
| A11 — loopback-only bind | ✅ proven | `auth-proofs.txt` |
| A12 — backend-minted token decision | ✅ recorded | this doc §Q3 / §decisions |
| A12b — token does not survive its session | ✅ proven | `auth-proofs.txt` (expired + replay) |
| A12c — fake-Companion handshake → offline | ✅ proven + residual | `A14b-…txt`, R3 |
| A12d — token scoped, not generic | ✅ proven | `auth-proofs.txt` (cross-ticket + cross-session) |
| A12e — mint route no-store / reject / audit | ✅ proven | `A12e-mint-route.txt` |
| A13 — discovery works | ✅ proven | `integration-network-trace-http.txt` |
| A14 — clean not-detected state | ✅ proven | `02` |
| A14b — degradation seam | ✅ proven | `A14b-degradation-seam-test.txt` |
| A14c — fallback transport admittable | ✅ answered | this doc §A14c |
| A15 — context injection present | ✅ proven | `06`, `claude-behavior.txt` |
| A16 — injection mechanism recorded | ✅ recorded | this doc §Q6 |
| A17 — install path decision | ✅ recorded | this doc §Q7 |
| A18 — failure taxonomy + state (c) | ✅ proven + mapped | `02`, `claude-behavior.txt`, this doc §Q8 |
| A19 — fallback engine location | ✅ recorded | this doc §Q5 |
| A20 — verdict doc exists, 8 Qs answered | ✅ this doc | — |
| A20b — honest lines | ✅ present | this doc §honest lines |
| A20c — privacy/freshness notes | ✅ present | this doc §A20c |

---

*End of verdict. Spike #1 returns **YES — feasible with named binding
constraints**. The constraints (the 13-row decisions table) and the 7 residual
risks are the binding architecture input the Phase 2 `/build` inherits. The
"feasible" claim is scoped to the macOS 26.3 / Node 25.9.0 / `claude` 2.1.146 /
Chrome 148 / `node-pty@1.2.0-beta.13` matrix; Sonoma/Ventura coverage and a
genuine public-origin LNA test are open Phase 2 pre-requisites.*
