# dispatch build — Phase 2 pre-brief (the AI layer)

**Status:** PRE-BRIEF. Phase 2 is GATED on spike #1 (Companion PTY/WebSocket feasibility, ~3–5 days, Cody + Rory). This doc exists so the spike has concrete architectural questions to answer; when the spike returns a verdict, this file becomes the seed for the real `/build` north star.

**Authored:** 2026-05-21, post Phase 1 merge (`fb1d5a0`).
**Canonical sources:** `CONTEXT.md` §Build phases, `docs/adr/001-ai-delivery-local-companion.md`, `docs/adr/006-timer-escalation-drafts-never-sends.md`, the Phase 1 run dir's `visual/surface-map.md` (especially the "NOT Phase 1 — Phase 2" sub-sections under Surface 3 — Ticket Detail). On conflict, CONTEXT.md + the ADRs win.

---

## OBJECTIVE

Build dispatch Phase 2 — the AI layer — as the next vertical slice on top of the Phase 1 spine. Phase 1 ships Tickets, the unified dashboard, the status ladder, and human-authored reply with Slack write-back. Phase 2 wires AI into that surface: an embedded Claude session next to each Ticket, AI-drafted replies in the composer, AI-drafted follow-up and closeout messages produced when the timer advances status. The architecture is locked by ADR-001 (interactive AI rides the SE's own Claude Code subscription via a local Companion; automation rides a Boolean-held Anthropic Console org). The shape is drawn in the `Dispatch v2` design (`PanelTerminal`, `.term` CSS, `Ic.terminal` toolbar icon, `panel === "terminal"` state machine). The wiring does not exist yet, and the feasibility of the Companion bridge is open.

Quality bar (verbatim, Cody): "real, verified progress and a clean handoff — never a rogue pile of unverified code." L1 evidence is binding. "Should work based on the code" is an automatic fail. Phase 1 held that bar across three Codex/review remediation passes; Phase 2 must match.

---

## Reference paths (read these first)

- `~/boolean-knowledge/builds/team-dispatch/CONTEXT.md` — the spec. §Build phases (lines 114–133) names Phase 2 in one paragraph. §"Open gates" line 95 names the Companion spike explicitly.
- `~/boolean-knowledge/builds/team-dispatch/docs/adr/001-ai-delivery-local-companion.md` — interactive AI architecture. The embedded window is the SE's own local Claude Code, run by a local Companion, surfaced as xterm.js over an authenticated localhost WebSocket. dispatch never holds a Claude credential. Boolean's Anthropic Console org is the server-side Agent SDK fallback.
- `~/boolean-knowledge/builds/team-dispatch/docs/adr/006-timer-escalation-drafts-never-sends.md` — timers move status and pre-draft messages, never send. The drafts in Phase 1 are stubbed; Phase 2 wires the AI generation. Slot types: registry merge fields (`{{first_name}}`) + AI-generated fields (`{{recap}}` written by reading the Ticket thread).
- `~/boolean-knowledge/builds/team-dispatch/.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/visual/surface-map.md` — Phase 1 run dir, reference only. The "NOT Phase 1 — Phase 2" sub-sections under Surface 3 (Ticket Detail), lines 166–192, enumerate every Phase 2 surface element with the exact JSX component names and CSS classes the dev phase will wire.
- `~/boolean-knowledge/builds/team-dispatch/.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/visual/design-system.md` lines 311–313 — the embedded terminal tokens (`.term` bg `#07101F`, mono 11.5px, `Ic.terminal` toolbar icon).
- The Phase 1 squash is `fb1d5a0`. `git log --oneline` from main shows only two commits — Phase 1 foundation (`a607862`) and Phase 1 spine (`fb1d5a0`). The Phase 2 build branches off `fb1d5a0`.

---

## What Phase 2 delivers

Five concrete inclusions, each grounded in a source above.

### 1. Embedded `claude-code` terminal panel

- Right-panel mode 3 in `Dispatch v2`'s `ticket-detail.jsx` — `PANELS.terminal`, the `PanelTerminal` component, `panel === "terminal"` state machine on `App`. (`surface-map.md` line 170–174.)
- The `Ic.terminal` toolbar icon — already drawn as one of three primary right-toolbar icons (Info / Activity / Terminal). Phase 1 either omitted or stubbed it. Phase 2 wires it.
- `.term` styling — `#07101F` background, mono font, 11.5px. Already in `ticket-detail.css`.
- The "`session 5a82`" sub-label on the panel header when terminal mode is active — the session id surfaces the Companion handshake (see §"Spike #1 questions" below).
- xterm.js as the terminal emulator inside the React component.
- An authenticated localhost WebSocket from the browser to the SE-local Companion process. The Companion runs the SE's own `claude` CLI in a PTY and pipes the PTY through the WebSocket. ADR-001 names this "the same model as VS Code's integrated terminal running `claude`."

### 2. The Companion process

- Per-machine, per-SE local install. macOS first (the pilot is Chris + Cody), Linux later if needed.
- Owns: the PTY, the WebSocket server bound to `localhost`, the auth surface that proves the dispatch tab is allowed to talk to it, the `claude-code` invocation with the right working directory and environment, the per-session lifecycle (spawn / attach / kill).
- Discovery — how the dispatch web app knows the Companion is running and which port to hit. (Spike #1 question.)
- Auto-update — required because Cody, Chris, and (later) the SE bench should never have to manually upgrade. (Out of scope for the spike; in scope for the build.)
- ADR-001 consequence: "Adds a local-process build surface: install, auto-update, the PTY/WebSocket bridge, localhost auth. Per-machine dependency."

### 3. `boolean-knowledge` context injection into Companion sessions

- When the SE clicks into the Terminal panel on a Ticket, the Companion opens `claude` at the `boolean-knowledge` repo root (so the SE has the entire org knowledge in context per ADR-003).
- The Ticket + Account are injected as the opening context — minimum: client slug, Ticket id (`DSP-####`), Ticket title, status, the thread up to the cursor.
- Injection mechanism: probably an initial prompt the Companion types into the PTY, or a tmpfile + `--file` flag, or an env var. (Spike #1 question — depends on what the `claude` CLI accepts.)
- Source: CONTEXT.md glossary "Embedded Claude Window — opens `claude` at the `boolean-knowledge` repo root with the Ticket + Account injected as context."

### 4. Server-side fallback engine (Boolean Anthropic Console org)

- Required by ADR-001: "The tool must degrade to the server-side fallback when the Companion is absent. It must never hard-fail."
- Powers two things the Companion cannot:
  - **Automation** — classification of incoming Tickets (the AI type label: question / reply / thanks / ooo / other), follow-up message generation, closeout message generation. These run server-side without a human at the keyboard, so they cannot ride an SE subscription.
  - **Interactive fallback** — when an SE clicks Terminal but has no Companion installed (or it is offline), dispatch falls back to a server-routed Claude session. UX: same xterm.js panel, but the WebSocket terminates at the dispatch Fastify service instead of the local Companion.
- Architecture decision pending — does the fallback engine live in the existing `packages/api` Fastify service, or as a separate worker? (Spike #1 question; bears on co-tenancy of HTTP and long-running model calls.)
- Provisioning: a Boolean-owned Anthropic Console org with per-SE workspaces. Not provisioned yet (gate #2 below).
- Source: ADR-001 + Move 1 cost line in CONTEXT.md ("interactive window rides SE subscriptions; classification + automation ride a Boolean Console org").

### 5. AI follow-up + closeout drafting (timer-side)

- The Phase 1 timer advances status (`Waiting on Client` → `Follow-up Required` → `Closeout Follow-up Required`) and raises a notification. It does not draft anything.
- Phase 2 wires the draft generation. When the timer advances a Ticket to `Follow-up Required`, an AI draft is generated server-side (Console org, automation tier) and attached to the Ticket as a pre-filled composer payload. The SE opens the Ticket, sees the draft in the composer, edits if needed, presses send (still posts to Slack via the Phase 1 write-back path).
- Two slot types per ADR-006: registry merge fields (`{{first_name}}` from the Contact / Account) and AI-generated fields (`{{recap}}` written by reading the Ticket thread).
- ADR-006 invariant: **timers never send to a client.** Phase 2 must not introduce an automated send path even if the draft is "good enough."

### 6. AI reply drafting in the composer

- The composer in `ticket-detail.jsx` is human-text-only in Phase 1 (`surface-map.md` line 177).
- Phase 2 adds a draft-generation affordance — a button or icon that asks the Companion (if present) or the fallback engine (if not) to produce a draft reply based on the Ticket thread + Account Highlights + client knowledge.
- The SE owns the send. Replies still post as the SE who pressed send (CONTEXT.md, ADR-001 alignment).

---

## Gates Phase 2 must resolve

Two. Until both clear, Phase 2 does not start `/build`.

### Gate A — Spike #1 (Companion PTY/WebSocket feasibility)

- ~3–5 days, Cody + Rory.
- Verdict: yes / no / how. A "no" routes back to architecture; a "how" produces the binding decisions §"Spike #1 questions" below enumerates.
- NOT STARTED as of 2026-05-21.
- Output: a `docs/spike-1-companion-feasibility.md` (or `docs/spike-1-*.md`) with answers to the questions below. That doc becomes a Phase 2 build-input.

### Gate B — Anthropic Console org provisioning

- A Boolean-owned Anthropic Console org with per-SE workspaces. Not provisioned. Required before any automation (classification, follow-up draft, closeout draft, interactive fallback) can run.
- Owner: Cody (org creation), Cody + each SE (workspace provisioning).
- Move 1 in CONTEXT.md "Open gates" — the cost line, redone with model-tiered Anthropic spend — needs the Console org to produce real numbers.
- Can run in parallel with Spike A.

---

## Spike #1 questions (concrete, answerable)

Phase 2's architecture depends on these. The spike's job is to return one answer per question, with evidence.

1. **xterm.js + localhost WebSocket cross-platform.** Does the xterm.js → WebSocket → PTY pipeline work on macOS Sonoma + Ventura at minimum? Render fidelity (cursor, scrollback, ANSI colors, resize), input fidelity (keyboard shortcuts, paste, control sequences), and stability over a long-running `claude` session. Reference implementations exist (VS Code, ttyd, Wetty); the spike confirms the shape works for dispatch's specific case (`claude` CLI inside a browser-hosted xterm.js).

2. **Session reuse vs spawn.** When the SE has Claude Code already open in a real terminal, does dispatch's embedded session attach to that or spawn a fresh one? Probably spawn (the `claude` CLI's session model is per-process), but confirm. If spawn, what is the cost of N concurrent sessions per Ticket the SE has open?

3. **Localhost WebSocket auth surface.** What stops a malicious page in another tab from connecting to the Companion's localhost socket? Options: (a) shared-secret token per-SE, stored in the dispatch web app via Clerk and exchanged on connect; (b) per-session token minted by the dispatch backend; (c) `Origin` header check against `dispatch.paintos.app`. Likely (a) or (b) + Origin pinning. Spike picks one and proves it.

4. **Companion ↔ web app discovery.** How does the dispatch tab learn that the Companion is running and which port? Fixed port + health-check? mDNS / `_dispatch-companion._tcp`? The dispatch backend tracks per-SE Companion endpoints? Cross-OS implications.

5. **Fallback engine location.** Does the server-side Agent SDK fallback live in `packages/api` (the existing Fastify service) or as a separate worker? Concerns: long-running model calls vs HTTP request lifecycle, memory pressure, restart blast radius. Likely a separate worker (or a separate Fastify instance with its own deploy), but Spike #1 confirms or pushes back.

6. **`claude` CLI context injection.** What is the cleanest way to pre-load the Ticket + Account into a fresh `claude` session? Initial prompt typed via PTY? `--context-file` flag? Environment variable? Whatever the spike picks becomes the contract the Companion implements.

7. **Companion install + auto-update mechanism.** macOS launch agent (`launchctl`)? Homebrew cask? Signed `.pkg` installer? Mac App Store? Auto-update via Sparkle or a custom mechanism? The spike does not have to build it, but it should pick a path so the build phase knows what it is shipping.

8. **Failure mode UX.** What does the Terminal panel show when (a) the Companion is not installed, (b) the Companion is installed but offline, (c) the Companion is installed and online but the SE has no Claude subscription? Each maps to a UX state and (sometimes) a fallback engine invocation.

---

## What Phase 2 does NOT build

Lifted from CONTEXT.md "Out of scope (V1)" and the phase split:

- Phase 3 — clock in/out, billable toggle, Clockify sync, per-SE hours bar chart, per-client economics rollup. The `.clock-grp` controls and the effort write-path stay deferred.
- Phase 4 — Chris/Cody KPI tabs, response/resolution time charts, client-health formula, per-SE performance. The Analytics surface stays stub-only.
- Self-serve Triggers rule builder (Settings/Triggers, pylon R2). Phase 1 routing remains registry-driven owning-SE rule.
- Bidirectional Slack-channel mirroring of the internal thread (OQ-3). Internal thread stays dispatch-native.
- Email ingestion. Folds in once Slack ingestion is proven; not Phase 2.
- Org chart / auto-assign to direct reports (V2).

---

## Open questions for the operator (Phase 2-specific)

- **OQ-P2-1 — fallback engine model tier.** The interactive Companion rides the SE's subscription. The fallback engine and automation ride the Boolean Console org. Which model? Sonnet 4.6 default, Opus 4.7 for closeout drafting, Haiku 4.5 for type-label classification? Spike #1 cost line (Move 1) needs this picked before the org bill is real.

- **OQ-P2-2 — context-injection privacy.** Does every Companion-opened session inject the *entire* `boolean-knowledge` repo, or only `clients/<slug>/` for the Account on the Ticket? CONTEXT.md says repo root, but the operator may want narrower scoping for client work (avoid bleeding cross-client context into a session).

- **OQ-P2-3 — fallback engine ↔ Companion handoff.** If the SE starts a session on the fallback engine (no Companion) and then installs the Companion mid-session, does the session migrate? Probably no (sessions are stateful and the histories don't compose), but confirm.

- **OQ-P2-4 — type-label backfill.** Phase 1 stores the `type` field on every Ticket but defaults it to `other` (no AI in Phase 1). When Phase 2 ships the classifier, should it backfill labels on existing Phase 1 Tickets, or only label going forward? Cost (Console org bill) + UX (sudden re-labels) both bear on this.

- **OQ-P2-5 — pilot expansion.** Phase 1 pilots to Chris + Cody. Phase 2 adds the Companion install on each pilot machine. Does Phase 2 still pilot to Chris + Cody only, or does it expand to the SE bench (Dan, Heiler, Brett, …)? The Companion install surface gets exercised harder with more SEs, but the more SEs, the more Console org workspaces to stand up.

---

## In-flight work (status at this checkpoint)

- **Local main:** `fb1d5a0` — Phase 1 squash. Working tree clean. No branches in flight.
- **Production:** Railway service `team-dispatch`, bespoke domain `dispatch.paintos.app`. Auto-deploys `main` per the existing service config. Phase 2 build will deploy when the branch lands.
- **Phase 1 close-outs Cody-side** (not Phase 2 blockers but must precede live production traffic):
  1. Per-SE `SLACK_USER_TOKEN_<clerkUserId>=xoxp-…` env vars on Railway when each SE has authorized a token.
  2. `publicMetadata.role="admin"` on Cody + Chris in the Ops Dashboard Clerk app (or explicit authorization for CC to set via the Clerk API).
  3. Registry PENDING resolution — `~/boolean-knowledge/clients/_registry.yaml` has 2 PENDING_* channel ids (C&A Painting, Service Built) and a provisional SE on SPC (Rensy vs Marcel).
- **Spike #1 status:** NOT STARTED. No doc at `docs/spike-1-*.md`. Cody + Rory own. ~3–5 days when started.
- **Console org:** NOT PROVISIONED. Cody owns.

---

## Resumption command — when spike #1 returns a verdict

The new CC window should:

1. Verify: `cd ~/boolean-knowledge/builds/team-dispatch && git status && git log -3 --oneline` — main at or ahead of `fb1d5a0`, working tree clean.
2. Read the spike #1 verdict doc (`docs/spike-1-*.md`). The verdict's answers to the eight questions above are binding architecture for the build.
3. Confirm Gate B (Anthropic Console org provisioned) with Cody. If not, Phase 2 can start the parts that do not depend on the fallback engine (the embedded terminal + Companion bridge), and the fallback engine waits for the org.
4. Invoke:

```
/build "Build dispatch Phase 2 — the AI layer per CONTEXT.md §Build phases.
Surface scope: embedded claude-code terminal in the ticket-detail right panel
(xterm.js + local Companion over authenticated localhost WebSocket per ADR-001),
boolean-knowledge context injection into Companion sessions, server-side fallback
engine via Boolean's Anthropic Console org (Anthropic bans subscription-routing
for third-party web apps — verified), AI follow-up drafting, AI closeout drafting,
AI reply drafting in the composer. Architecture decisions in the spike #1 verdict
at <path-to-spike-doc> are binding. Phase 1 close-outs (per-SE Slack user tokens,
admin role on Cody/Chris in Clerk, registry PENDING resolution) are tracked
separately and not Phase 2 blockers. Quality bar: real verified progress, L1
evidence binding, never 'should work based on the code'. Codex cross-model
checkpoints at ~75% scope and again post-qa. The dispatch repo already has its
harness wired (Phase 1 ran cleanly through /build); /build:setup audits the
existing harness rather than creating it. Branch off main (fb1d5a0 or later);
squash-merge to main on /land per Cody's discipline (Cody never merges; CC merges
any desirable result on green CI + scope-clean + no security-boundary surprise)."
```

5. The /build skill kicks off `/build:setup` → `/build:grill` → `/build:design` → `/build:dev` (per slice) → `/build:e2e` → `/build:review` → `/build:qa` → `/build:handoff`. Same pattern Phase 1 used.

6. Honor the Codex checkpoints — at ~75% scope and post-qa, pause and emit a Codex review prompt for Cody (diff range + relevant ADRs + a directed correctness/security ask).

7. **Stop ONLY at:** a Codex checkpoint, a fresh architecture wall the spike did not cover, or shipped. Work through everything else.

---

## Verification the new window picked up correctly

- `git rev-parse main` returns `fb1d5a0…` or a descendant.
- `pnpm test` from repo root: core 200 + api 74 + mcp 13 = 287 unit pass; `pnpm e2e` returns 26 pass. (Optional smoke — the squash-merged commit is the source of truth.)
- `cat docs/spike-1-*.md | head -20` returns the spike #1 verdict.
- `.env` at repo root has real Clerk dev keys (`pk_test_*`, `sk_test_*`).
- This pre-brief reads as the seed; the spike #1 verdict reads as the binding architecture decisions.

---

*End of pre-brief. This file becomes the seed for the real Phase 2 `/build` north star once spike #1 clears.*
