OBJECTIVE: Continue the `dispatch` build forward through Phase 2 → 3 → 4 using the `/build` protocol. Phase 1 (the spine — Slices 4–8 + 3 remediation cycles) shipped today as PR #4 squash-merged to main at `fb1d5a0`. The next session picks up the build — either kicks off Phase 2's `/build` cycle if spike #1 (Companion PTY/WebSocket feasibility) is resolved, or drafts a Phase 2 pre-brief while spike #1 runs so the spike has concrete architectural questions to answer. Quality bar verbatim from Cody: "real, verified progress and a clean handoff — never a rogue pile of unverified code." L1 evidence is binding; "should work based on the code" is an automatic fail. The Phase 1 build held that bar across 3 Codex/review remediation passes — Phase 2 must match.

Reference paths:
- `~/boolean-knowledge/builds/team-dispatch/CONTEXT.md` — THE SPEC. Glossary, ingestion rule, status ladder, locked decisions, open gates, the four-phase plan. §"Build phases" lines 114–133 lists Phase 2/3/4 in one paragraph each.
- `~/boolean-knowledge/builds/team-dispatch/docs/dispatch-build-0-to-100-checkpoint.md` — original 0-to-100 brief (the why). Gates: spike #1 (Companion PTY/WebSocket, ~3-5 days, Cody + Rory) and spike #2 (G1 persistent ingestion socket, ~2 weeks).
- `~/boolean-knowledge/builds/team-dispatch/.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/` — Phase 1's run dir. Frozen `spec.md` (28 ACs), `plan.md` (8 slices, ~1180 lines), `surface-map.md` (its "NOT Phase 1 — Phase 2" sub-sections are the closest thing to a Phase-2 scope sketch we have today), `peer-spec.md` (Norman's adversarial pass on Phase 1). Reference-only for Phase 2; a Phase 2 `/build` starts a new run dir.
- `~/boolean-knowledge/builds/team-dispatch/AGENTS.md` + `~/boolean-knowledge/builds/team-dispatch/CLAUDE.md` — repo conventions (pnpm monorepo, lint-enforced web→core/db boundary, commit-message format ending with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`).
- `~/boolean-knowledge/builds/team-dispatch/docs/adr/001-*.md` through `006-*.md` — six locked ADRs from Phase 1 (ADR-001 = the embedded "claude-code" terminal is the SE's own local Claude Code via a local Companion; ADR-006 = the timer never calls Slack write-back).
- `~/.claude/projects/-Users-cody/memory/MEMORY.md` — owner profile + operating-mode rules (execute don't ask, Cody never merges, L1 evidence binding, Codex checkpoints at 75% + post-qa, etc.).
- `~/boolean-knowledge/code-plans/team-dispatch-merges.log` — Phase 1 squash SHAs for git-revert recipes.
- Available skill for the next session: `/build` (Boolean's gated-pipeline harness Phase 1 used) — invocations `/build <north-star>`, `/build:setup`, `/build:grill`, `/build:design`, `/build:dev`, `/build:e2e`, `/build:review`, `/build:qa`, `/build:handoff`, `/build:auto`, `/build status`, `/build resume`. **Do NOT `/build resume` from the Phase 1 run dir** — its metadata was renamed to `metadata.stale.json` to silence the Stop hook; Phase 2 starts a fresh run.

Delta since last write:
- **Phase 1 shipped.** PR #4 squash-merged to main as `fb1d5a0` on 2026-05-21 15:11Z. Branch `build/dispatch-phase-1-slices-4-8` deleted on merge. Local main is at `fb1d5a0`. Final counts: 287 unit (core 200 / api 74 / mcp 13) + 26 e2e = 313 tests passing, zero flakes. typecheck + lint clean across 5 packages (web / api / core / db / mcp).
- **Phase 1 remediation history** (folded into the squash, not visible in main's log): three review/Codex cycles caught and fixed 1 P1 + 9 P2 + 2 P3 findings. The most consequential: DM/group-DM Account resolution via discovered Contacts (Slice 4 FIX 2, originally missed), ingestion idempotency made race-safe via `INSERT … ON CONFLICT`, outbox double-post window closed (reentrancy guard + atomic claim), undo TOCTOU wrapped in a `db.transaction` with guarded cancel + bails honestly to `undo-too-late`, undo of a status transition now restores SLA side-effect columns (`waiting_client_since_at`, `follow_up_1_sent_at`, `resolved_at`), reassignment one-pending-per-ticket enforced by a Postgres partial unique index (not just a transaction), machine-credential JWT claim-shape validation tightened, malformed ticket ids return 400 instead of a Postgres UUID-syntax 500.
- **OQ-2 resolved by Cody → per-SE Slack user tokens** (the heavier-auth option vs the bot default). Send path is real code in `packages/core/src/slack/write-back.ts`; needs `SLACK_USER_TOKEN_<clerkUserId>=xoxp-...` per SE in deploy env. Until tokens present, outbox marks rows `failed` with `last_error="no Slack user token configured for SE <id>"`. Trade-off noted at decision time: closer to Slack's automation-ToS edge than the bot path.
- **Clerk gate resolved → dispatch shares the Ops Dashboard Clerk application.** Cody's directive: "We already have a clerk auth gate setup for the ops website you should be able to find it in 1pw under Ops dashboard titles." Keys pulled from 1Password (`pk_test_*` / `sk_test_*` — Clerk dev instance) into `.env` at repo root (gitignored). Items in vault `Boolean Agents`: `Ops Dashboard - Clerk Publishable Key`, `Ops Dashboard - Clerk Secret Key`, `Ops Dashboard - Clerk User ID (Cody)` = `user_3DzgimkNCGSt10Uc4lIDmvhDeS8`. dispatch reads `publicMetadata.role` off the Clerk user — neither Cody nor Chris currently has `role=admin` on that shared Clerk app, so they resolve as `se` in dispatch (gates `/api/ingest/stub`, admin-immediate reassignment, MCP admin scoping). I declined to write publicMetadata on a shared production Clerk instance unilaterally — Cody to set in Clerk dashboard OR explicitly authorize me to set via the Clerk API.
- **Two operational close-outs from Phase 1, Cody-side, not build-blockers** (must be done before live production traffic):
  1. Drop per-SE Slack user tokens in env keyed by Clerk user id.
  2. `publicMetadata.role = "admin"` on Cody + Chris in the Ops Dashboard Clerk app.
- **Registry has unresolved items.** `~/boolean-knowledge/clients/_registry.yaml` has 2 `PENDING_*` channels (C&A Painting, Service Built — confirm Slack channel IDs) and a provisional SE on Select Painting & Coatings (Rensy vs Marcel — confirm). Until resolved, those Slack origins route to the `__unrouted__` quarantine account (designed safe behavior, surfaces in the "Unassigned" view).
- **Database state.** Local Homebrew Postgres on `:5432`. Both `dispatch_dev` and `dispatch_test` have migrations `0000_init.sql` through `0006_reassignment_one_pending.sql` applied. Test DB cleans up between runs. Registry seeded via `pnpm --filter @dispatch/db seed` (default REGISTRY_PATH now correct after the QA P3 fix; the `__unrouted__` quarantine account is seeded by the script).
- **Phase 2 is GATED on spike #1 — Companion PTY/WebSocket feasibility** (CONTEXT.md line 26 verbatim: "Phase 2 is fully gated on #1"). Spike #1 sketches the embedded `claude-code` terminal architecture: xterm.js over an authenticated localhost WebSocket talking to an SE-local Companion process that runs the SE's own Claude Code. The fallback is a server-side Boolean Anthropic Console org (Anthropic bans third-party web apps from routing API calls through user subscriptions — verified). Cody + Rory own this spike, ~3–5 days. NOT STARTED as of this checkpoint. Until it resolves, Phase 2's architecture is undecided.
- **Cody offered the choice during the session and did not pick yet:** draft a Phase 2 pre-brief from the locked design pieces in `surface-map.md`'s "NOT Phase 1 — Phase 2" sub-sections + CONTEXT.md §Build phases now, OR hold for spike #1. The `/checkpoint` invocation arg ("so it hits the ground running and continues / build protocol") suggests the next window should EITHER kick off `/build` for Phase 2 directly (if spike #1's verdict is in) OR start the pre-brief draft so spike #1 has concrete questions to answer.

In-flight work:
- **Local main:** `fb1d5a0` (Phase 1 squash). Working tree clean. No branches in flight, no drafts staged, no subagent dispatches paused, no Prismatic instances unpublished.
- **Production:** Railway service `team-dispatch` exists with the bespoke domain `dispatch.paintos.app`. Railway should auto-deploy `main` per its existing service config — Cody should verify the running app on first opportunity. No `preview_url_pattern` is configured in `~/boolean-knowledge/code-plans/team-dispatch.md` (no plan file exists for this repo). Phase-1 commit history under `~/boolean-knowledge/code-plans/team-dispatch-merges.log` (two entries — the night-1 Phase 1 foundation merge a607862, and today's Phase 1 spine merge fb1d5a0).
- **`.env` (gitignored, local-only):** real Clerk dev keys, `DATABASE_URL=postgresql://cody@localhost:5432/dispatch_dev`, `DSP_ID_START=2900`, `SLACK_SEND_WINDOW_SECS=10`. `SLACK_USER_TOKEN_*`, `SLACK_SIGNING_SECRET`, `MCP_SIGNING_SECRET`, `DISPATCH_API_URL`, `DISPATCH_API_KEY` are documented in `.env.example` but not set in `.env`. The MCP token mint helper exists at `packages/mcp/scripts/mint-token.ts`.
- **Phase 1 run dir** at `.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/` has `metadata.stale.json` (renamed at the start of this session so the Stop hook stays quiet). Reference-only. Phase 2 starts a fresh `.build-runs/build-dispatch-…/` dir on `/build:setup`.
- **No spike #1 doc exists yet.** When it's drafted it should land at `~/boolean-knowledge/builds/team-dispatch/docs/spike-1-companion-feasibility.md` (or similar in `docs/`).

Resumption command:

First action — orient (every fresh window does this regardless of path):
```
cd ~/boolean-knowledge/builds/team-dispatch && \
git status && git log -3 --oneline && \
ls docs/ && ls .build-runs/ && \
ls docs/ | grep -i spike
```
Verifies: main at `fb1d5a0`, working tree clean, the Phase 1 run dir still present (stale), and whether a `spike-1-companion-feasibility.md` (or similar) doc exists yet.

Then pick a path:

**Path A — Phase 2 `/build` immediately.** Trigger ONLY if a spike #1 verdict doc exists at `docs/spike-1-*.md` with a yes/no/how decision on the Companion PTY/WebSocket. Invoke:
```
/build "Build dispatch Phase 2 — the AI layer per CONTEXT.md §Build phases. Surface scope: embedded `claude-code` terminal in the ticket-detail right panel (xterm.js + local Companion over authenticated localhost WebSocket per ADR-001), boolean-knowledge context injection into Companion sessions, server-side fallback engine via Boolean's Anthropic Console org (Anthropic bans subscription-routing for third-party web apps), AI follow-up drafting, AI closeout drafting. Architecture decisions in the spike #1 verdict at <path-to-spike-doc> are binding. Quality bar: real verified progress, L1 evidence binding, never 'should work based on the code'. Codex cross-model checkpoints at ~75% scope and again post-qa. The dispatch repo already has its harness wired (Phase 1 ran cleanly through /build); /build:setup audits the existing harness rather than creating it. Branch off main; squash-merge to main on /land per Cody's discipline (Cody never merges, CC merges any desirable result)."
```
The /build skill kicks off `/build:setup` → `/build:grill` → `/build:design` → `/build:dev` (per slice if the design produces slices) → `/build:e2e` → `/build:review` → `/build:qa` → `/build:handoff`. Same pattern Phase 1 used.

**Path B — Phase 2 pre-brief while spike #1 runs.** Default if no spike #1 verdict doc exists. Draft `~/boolean-knowledge/builds/team-dispatch/docs/dispatch-build-phase-2-prebrief.md` in the shape of `docs/dispatch-build-0-to-100-checkpoint.md`. Capture from `CONTEXT.md` §Build phases and `surface-map.md`'s "NOT Phase 1 — Phase 2" subsections:
  - Embedded `claude-code` terminal panel (`PanelTerminal`, `.term` CSS, `Ic.terminal` toolbar icon, `panel === "terminal"` state machine) — design is already drawn in `Dispatch v2`.
  - AI reply drafting in the composer.
  - Companion process (xterm.js over localhost WebSocket per ADR-001).
  - `boolean-knowledge` context injection into Companion sessions.
  - Server-side fallback engine (Boolean Anthropic Console org).
  - AI follow-up + closeout drafting (the timer drafts nothing in Phase 1; Phase 2 wires the drafts).
  - The two gates a Phase 2 build must resolve: spike #1 (Companion feasibility, ~3-5 days) and Anthropic Console org provisioning.
The pre-brief turns into concrete questions for spike #1 ("does xterm.js over localhost-WebSocket work cross-platform?", "how does the SE's existing Claude Code session get reused vs spawned?", "what does the Companion auth surface look like — is the WebSocket token shared-secret per-SE or per-session?", "where does the server-side fallback engine sit — same Fastify service or separate worker?"). When the spike resolves, the pre-brief becomes the seed for the real `/build` north star (Path A).

After Path A or Path B, Cody-side close-outs to surface in the response footer:
1. Drop per-SE `SLACK_USER_TOKEN_*` env vars in production when SEs have authorized tokens.
2. Set `publicMetadata.role="admin"` on Cody + Chris in the Ops Dashboard Clerk app (or authorize me to do it via the Clerk API).
3. Resolve registry PENDING items (`~/boolean-knowledge/clients/_registry.yaml` — 2 PENDING_* channel ids, Rensy-vs-Marcel SE on SPC).

Verification the new window picked up correctly:
- `git rev-parse main` returns `fb1d5a05...`.
- `pnpm test` from repo root: core 200 + api 74 + mcp 13 = 287 unit pass; `pnpm e2e` returns 26 pass. (Optional smoke — only run if the new window wants confirmation; the squash-merged commit is the source of truth.)
- `cat .env | head -5` shows real Clerk keys present (publishable + secret, both `pk_test_` / `sk_test_` prefixed).
- The presence/absence of `docs/spike-1-*.md` determines Path A vs Path B.

Default if Cody is not at the keyboard when the new window opens: **Path B (pre-brief draft)** — reversible, unblocks spike #1 by giving it concrete architectural questions, and doesn't commit to Phase 2 architecture choices that depend on spike #1's answer.
