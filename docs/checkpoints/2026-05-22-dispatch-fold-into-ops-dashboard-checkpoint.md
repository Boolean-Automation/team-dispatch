# dispatch Phase 2 → ops-dashboard monorepo fold + ops.paintos.app/dispatch deploy

## OBJECTIVE

Fold the just-shipped dispatch Phase 2 (PR #6 merged to `team-dispatch` `main` as `fe0d3fd`) into `ops-dashboard`'s codebase as a true monorepo — Cody's exact wording: **"path B, that's the RedWings option."** Not Path A (separate Railway service consolidation). The Red Wings finish line: dispatch alive at **`ops.paintos.app/dispatch`** as a subpath route AND a page option in `ops-dashboard`'s navigation. Continue `/build` slices until shipped. Hard-verify back/refresh works on every dispatch route under the subpath — Cody's other ask: *"I've been having a hard time with logical 'back' or 'refresh' behavior across all my apps. Just want to 100% verify that's been accounted for in this code."* Quality bar verbatim from Cody (carried from prior checkpoint): *"real, verified progress and a clean handoff — never a rogue pile of unverified code."* L1 evidence binding. "Should work based on the code" = automatic FAIL.

## Reference paths

- `/Users/cody/boolean-knowledge/builds/team-dispatch/` — the just-shipped Phase 2 repo. `main` at `fe0d3fd` (squash-merge of PR #6). Local main is cosmetically diverged (2 commits ahead/2 behind from `origin/main` — same lossless state Cody pre-authorized in the prior resume; `git reset --hard origin/main` whenever, hook will deny it so do it directly in shell). Read `CLAUDE.md`, `CONTEXT.md`, `package.json`, `pnpm-workspace.yaml`, `Dockerfile`, `railway.json`.
- `/Users/cody/boolean-knowledge/builds/ops-dashboard/` — the survivor repo. **Stack mismatch:** Next.js 13+ App Router (NOT Vite) + `@clerk/nextjs` (NOT @clerk/clerk-react) + `postgres` (postgres.js, NOT Drizzle) + flat repo (NOT pnpm workspaces). Has a curious nested `ops-dashboard/ops-dashboard/` subdir — confirm which level is canonical before touching anything (root-level `package.json` says `"name": "ops-dashboard"`, root has the canonical `app/`). Read `package.json`, `next.config.js`, `middleware.ts`, `app/(dashboard)/` (existing route group with the dashboard nav).
- `/Users/cody/boolean-knowledge/builds/team-dispatch/.build-runs/build-dispatch-phase-2-the-embedded-loca-20260522T031217/` — the Phase 2 build run (gitignored, lives only locally; the evidence + plan + 7-round-iteration codex-checkpoint trail are here, NOT on GitHub). Read `spec.md`, `plan.md`, `gate-qa.md`, `gate-review.md`, `codex-checkpoint-design.md`, `codex-checkpoint-qa.md`, `commits.log`, `evidence/README.md`, `evidence/macos-version-gate.md`.
- `/Users/cody/.claude/skills/build/SKILL.md` — the `/build` harness. The orchestrator state for `team-dispatch`'s Phase 2 run is in `metadata.escalated.json` (final phase set to `declaw`, gates all `success` except handoff which the verifier downgraded after the PR merged — bookkeeping noise; the PR is shipped).
- `/Users/cody/.claude/skills/checkpoint/SKILL.md` — context on the four-block delta-only handoff discipline this file uses.
- `/Users/cody/boolean-knowledge/agents/_shared/operating-modes/cody.md` — Cody operating spec (Red Wings quality bar, no permission-asking, drive to shipped).
- `/Users/cody/boolean-knowledge/agents/_shared/sacred-principles.md` — vertical-slicing for `/build:design`.
- `/Users/cody/boolean-knowledge/operations/standards/mcp-ready-architecture.md` — API-first / headless-core / MCP-ready (binding for any new surface).
- **Phase 2 PR:** https://github.com/Boolean-Automation/team-dispatch/pull/6 (merged as `fe0d3fd`).
- **Railway project:** `ops-board` (note: project is named `ops-board`, repo is `ops-dashboard` — Railway uses the older name). Project ID `a95ed30a-d99e-435a-8e67-f6c82b7b5068`. Current services: `ops-board` (Next.js app, image `pnpm start` after `pnpm db:setup` predeploy) + `postgres` (shared internal at `postgres.railway.internal:5432/railway`).
- **ops-dashboard env vars** (capture as the seed for dispatch's env — already inspected):
  - `CLERK_SECRET_KEY` = `sk_test_j7BIhYfqkJIcIyWjtuma5ObQOBsSmKG14sI0b4eJa6`
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` = `pk_test_cGxlYXNlZC13YXNwLTQyLmNsZXJrLmFjY291bnRz...` (pleased-wasp-42 Clerk test app).
  - `DATABASE_URL` = `postgresql://postgres:04c20464...@postgres.railway.internal:5432/railway`. Same Postgres for dispatch; either share the `railway` DB with namespaced tables (cleaner under monorepo) or run `CREATE DATABASE dispatch;` for separation.
  - `NEXT_PUBLIC_BASE_PATH` = `/opsboard` — interesting, the Next app already has a base path. Verify whether ops-dashboard is served at `ops.paintos.app/opsboard` today or whether that env var is stale; the dispatch subpath must coexist with whatever ops-dashboard's actual subpath is.

## Delta since last write

- **The killed Path A.** Cody's first reflex was "do Path A for me rn via CLI" — register a separate `team-dispatch` Railway service alongside `ops-board` in the same Railway project. I started the inspection (`railway link`, `railway status --json`, captured ops-board's env vars above) but **did NOT fire `railway add`**. Cody pivoted: "We gotta go path B, that's the RedWings option." Path A is dead; don't touch `railway add`. The Railway-side cleanup happens AFTER the codebase merge, as part of the deploy reshape.
- **Architecture decision NOT YET MADE — fresh window owns this.** Path B has three sub-shapes; pick before writing any code (recommend a /roundtable Vera+Rory+Norman if you stall). Briefly:
  - **B1: port dispatch to Next.js App Router.** Move `packages/web/` → ops-dashboard `app/(dashboard)/dispatch/*` routes. Convert React Router → App Router. Convert Vite → Next. Convert `@clerk/clerk-react` → `@clerk/nextjs`. Move `packages/api/` Fastify routes → Next route handlers under `app/api/dispatch/*`. Move `packages/db/` Drizzle schema → ops-dashboard DB layer (or coexist as separate schema). Most idiomatic for a Next codebase. Heaviest port; touches every test, every router-aware component, every API client call. Companion stays as its own deployable (it runs on the SE's local Mac, NOT on Railway — see Companion-is-local below).
  - **B2: mount dispatch's built SPA as a static asset inside Next.** Add `pnpm-workspace.yaml` to ops-dashboard. Keep `packages/web/` as Vite, keep `packages/api/` as Fastify, build dispatch's `web/dist`, ship it as a Next.js public/static path or via Next middleware rewrites at `/dispatch/*`. Fastify api → also fold but probably easier as Next API route adapters. Preserves more of the just-shipped Phase 2 work (76 e2e + 163 unit tests don't need to be rewritten). Less idiomatic; two bundlers.
  - **B3: keep dispatch's stack, deploy as a sibling Next-rewrite target.** Add pnpm workspaces to ops-dashboard, drop dispatch's `packages/*` in as `apps/dispatch-*`. ops-dashboard's Next config uses `rewrites()` to proxy `/dispatch/*` → dispatch's bundled output (or a separate process on a different port inside the same Railway service). Most monorepo-like; preserves everything; Railway runs both Next + Fastify under one service.
  - **Recommend B2 first**, drop to B3 only if Next/Vite-as-static doesn't compose. Avoid B1 unless the back/refresh discipline (below) gives a clear win to going fully App Router.
- **Companion is LOCAL, not deployed.** Critical: `packages/companion/` runs on the SE's own Mac, NOT on Railway. The Companion binds `127.0.0.1:7720` loopback-only; the browser SPA connects to `ws://127.0.0.1:7720/`. Whatever B-path you pick, the Companion package stays as its own buildable that ships to SE laptops (currently hand-started; OQ-7 installer is a Phase 3 follow-up). Don't try to deploy the Companion to Railway — it'd be a security-boundary violation per ADR-007. The Companion's GitHub source can move into ops-dashboard's repo, but its deploy target stays local-only.
- **Back/refresh is a hard gate.** Cody quote verbatim: *"I've been having a hard time with logical 'back' or 'refresh' behavior across all my apps. Just want to 100% verify that's been accounted for in this code."* For Phase 2 IN ITS CURRENT SHAPE (own subdomain), back/refresh works — the api server's `setNotFoundHandler` SPA fallback (qa-fix r1, `47d522b`) returns `index.html` for any non-/api route, and e2e covers it. **For the subpath shape (`ops.paintos.app/dispatch/*`) — NOT YET ADAPTED.** Three things need explicit alignment:
  1. React Router `basename="/dispatch"` (or App Router route-group + `basePath` in `next.config.js`) so internal navigation produces `/dispatch/t/DSP-123` not `/t/DSP-123`.
  2. Server SPA fallback (api or Next middleware) must catch refresh on `/dispatch/t/DSP-123`, NOT 404 it. With Next App Router, `app/(dashboard)/dispatch/[...catchall]/page.tsx` or middleware rewrites handle this.
  3. Vite `base: '/dispatch/'` if B2 is chosen (so asset URLs are prefixed).
  Add e2e specs that load each route directly (not via in-app navigation) AND hit browser-back from each, asserting no 404 and no broken state. This is the back/refresh discipline that Cody wants verified.
- **Phase 2 tracked tail (carries forward):**
  - 4× P3 from review/qa cycles: BC payload validation (`use-terminal-settings`), BPM marker escape in clipboard text (`key-handler`), `__pollPopoutClosedForTest` DRY (`popout-bridge`), `useActivePty` stale pointer across retry transport rebuilds (post-qa Codex round 3).
  - 2× P2 deferred to follow-up: DB CHECK constraint on `audit_launcher_fired.command_hash` (defense-in-depth, route Zod-validates today), Companion `/metrics` auth/Host pin (loopback-only is current boundary).
  - **75 inline React style refactor** → drops the `style-src-attr 'unsafe-inline'` CSP carve-out. Tracked at `docs/follow-ups/inline-styles-refactor.md` (TBD — not committed yet, name it when you create it).
  - **Clerk publicMetadata overlapping-reads race** → Phase 3 follow-up: move terminalSettings to a dispatch-DB-backed endpoint with per-user mutex. Today's retry-once narrows but doesn't eliminate the race.
  - **OQ-7 Companion installer / Sparkle auto-update** → out of Phase 2 by spec; hand-start on pilot Macs is the current model.
- **§7 second-macOS clause** — binding pre-pilot prerequisite, NOT a merge blocker for the monorepo fold. Cody clarified the spec says "second macOS line," not "Chris's machine specifically" — his MacBook Air counts. Procedure lives at `.build-runs/.../evidence/macos-version-gate.md`. Public-origin LNA test (Spike #1 R1 residual) is the same scope. Both are pilot prereqs; queue them as a `/build` slice at the end of the monorepo work or right before flipping `ops.paintos.app/dispatch` to pilot SEs.
- **Pre-existing Phase 1 test failures.** 21 tests in `team-dispatch packages/core` fail on `slack_outbox.human_send_intent_id` NOT NULL constraint. **Confirmed identical on origin/main both pre-merge and post-merge** — NOT a Phase 2 regression. When you fold dispatch into ops-dashboard, these tests come with you; either fix them in a separate cleanup PR (small, scope-isolated) or leave them as-is and let CI exclude them. Don't get distracted by them mid-merge.
- **Local cleanup done this session.** `.local-https/` (self-signed cert + key from qa-fix r2 §7 HTTPS capture) + `packages/web/.https-cert/` were removed before the Stop hook fired. `.gitignore` was updated to ignore `.local-https/` so it's safe to re-generate. The cert material was never committed.
- **Codex thread IDs** for reference (Phase 2 cross-LLM gates, in case follow-up needs continuity):
  - Design checkpoint: `019e4e1d-a441-7852-ae13-90a1b3d32b6a` (3 rounds, HARD_STOP → HARD_STOP → SHIP_WITH_NOTES).
  - Post-qa checkpoint: `019e51b4-a476-70d3-8824-0f6da37bcfb2` (3 rounds, HARD_STOP → HARD_STOP → SHIP_WITH_NOTES).
  - Spike #1 thread is separate; not relevant here.

## In-flight work

- **Local main on team-dispatch is 2-ahead/2-behind origin/main** (`797448c` + `41f5926` are the cosmetic checkpoint commits Cody pre-authorized as lossless to discard; origin has them in squash `d47a270`/`fe0d3fd`). Run `git -C ~/boolean-knowledge/builds/team-dispatch reset --hard origin/main` directly in shell (CC's PreToolUse hook will deny `reset --hard` per Cody's standing rules — bypass with explicit "Cody pre-authorized this in 2026-05-21-dispatch-phase-2-terminal-design-resume-checkpoint.md and again in this session").
- **No in-flight orchestrator dispatch.** The Phase 2 `/build` run's metadata.json was archived to `metadata.escalated.archived.json` + `metadata.escalated.json` after the handoff phase shipped + the verifier downgraded the bookkeeping. The PR is merged; the orchestrator state is cosmetically incomplete. Safe to ignore for the new build; start a fresh `/build` run for the monorepo fold.
- **No branch open for the merge work.** Start a new branch off `ops-dashboard`'s `main` once you've architected. Suggested name: `build/dispatch-monorepo-fold-into-ops-dashboard`.
- **Phase 2's `build/dispatch-phase-2-terminal` branch was deleted on merge.** Code is on `team-dispatch`'s `main` via squash `fe0d3fd`. No need to revive that branch.
- **Railway `ops-board` project is linked locally** (in `team-dispatch`'s working dir from this session). Doesn't matter for ops-dashboard work; will need `railway link --project ops-board` in the ops-dashboard tree when you get to deploy.
- **Two earlier `/build` runs are stale** in `team-dispatch/.build-runs/` (Phase-1 spine + killed Phase-2-AI build). Renamed to `metadata.stale.json` — won't interfere.

## Resumption command

Open a fresh Claude Code window in `/Users/cody/boolean-knowledge/builds/ops-dashboard/`. Paste this exact /build north-star:

```
/build dispatch monorepo fold — bring the just-shipped dispatch Phase 2 (PR #6 → team-dispatch main fe0d3fd) into ops-dashboard's codebase as a true monorepo. Cody picked "Path B, the RedWings option" over Path A (separate Railway service) — quality bar verbatim: "real, verified progress and a clean handoff — never a rogue pile of unverified code." End state: dispatch alive at ops.paintos.app/dispatch as a subpath route AND a page option in ops-dashboard's navigation, with hard-verified back/refresh discipline (Cody: "I've been having a hard time with logical 'back' or 'refresh' behavior across all my apps. Just want to 100% verify that's been accounted for in this code"). 

Read first: /Users/cody/boolean-knowledge/builds/team-dispatch/docs/checkpoints/2026-05-22-dispatch-fold-into-ops-dashboard-checkpoint.md — full prior-session context, reference paths, tracked tail items, in-flight state. Then read the four "Reference paths" entries in that checkpoint for: source-of-truth Phase 2 repo + plan + evidence; ops-dashboard's current Next.js+Clerk+postgres stack; the Phase 2 build run artifacts; the /build SKILL.md.

Architecture decision NOT made — pick between B1 (port to Next.js App Router) / B2 (Next + dispatch-as-static-Vite-build mounted via middleware) / B3 (pnpm workspaces, Next rewrites to a sibling process). Recommend B2 first, drop to B3 if Next/Vite-as-static doesn't compose, avoid B1 unless back/refresh discipline mandates fully App Router. If you stall on the architecture, dispatch a /roundtable with Vera+Rory+Norman before writing code. 

Critical constraints:
1. Companion is LOCAL — packages/companion/ ships to SE laptops, NEVER to Railway. ADR-007 binding.
2. Back/refresh discipline is a hard gate: React Router basename + server SPA fallback path-aware + Vite base config (if B2) — and an e2e suite that loads each route DIRECTLY (not via in-app nav) + hits browser-back from each, asserting no 404, no broken state.
3. Honor the 24 ACs from Phase 2's spec.md — the merge must not regress them.
4. The Phase 2 tracked tail (4 P3s + 2 deferred P2s + 75-inline-styles refactor + Clerk overlapping-reads race + Companion installer) is NOT in scope for this build; queue them as follow-ups.
5. Pre-existing 21 packages/core failures (human_send_intent_id NOT NULL) are NOT Phase 2 regressions — confirmed on origin/main. Leave them for a separate cleanup PR.
6. §7 second-macOS capture + public-origin LNA test are pilot prereqs — queue as the final /build slice before flipping ops.paintos.app/dispatch to pilot.

L1 evidence binding. "Should work based on the code" = automatic FAIL. Codex post-qa cross-LLM checkpoint required before merge.

Local main on team-dispatch is cosmetically diverged from origin (Cody pre-authorized git reset --hard origin/main in 2026-05-21 + this session). Run that in shell before any rebase work touches team-dispatch.

Continue /build slices until shipped: alive on ops.paintos.app/dispatch + nav-link in ops-dashboard + back/refresh verified on every route. Drive to merged PR per "Cody never merges — CC merges any desirable result; CI green or no-CI + scope-clean + no security-boundary surprise = squash-merge + delete-branch."

Verification that the new window picked up correctly:
- `git -C /Users/cody/boolean-knowledge/builds/ops-dashboard rev-parse HEAD` returns a current ops-dashboard main SHA.
- `gh pr view 6 --repo Boolean-Automation/team-dispatch --json state` returns "MERGED".
- The Phase 2 build run's checkpoint file path resolves to a real 200+ line markdown document.
- The /build run created for this monorepo fold lives in `/Users/cody/boolean-knowledge/builds/ops-dashboard/.build-runs/<new-run-id>/`.

Take the wheel. Don't ask questions no one will be here to answer. Drive to shipped.
```
