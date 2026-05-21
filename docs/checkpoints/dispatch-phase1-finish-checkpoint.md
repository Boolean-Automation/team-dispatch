OBJECTIVE: Drive the dispatch Phase 1 spine to shipped. dispatch is Boolean's internal client-support tool — greenfield, repo `~/boolean-knowledge/builds/team-dispatch`, deploys to dispatch.paintos.app. Phase 1's foundation (dev Slices 1-3 of 8) is built, verified, and merged to `main`. Your job: continue dev Slices 4-8 per the existing plan, then e2e/review/qa, then /land. Cody's words: "keep going to finish line." Quality bar (Cody, verbatim): "real, verified progress and a clean handoff — never a rogue pile of unverified code" — L1 evidence (real screenshots, real test output) is binding; "should work based on the code" is an automatic fail.

REFERENCE PATHS (read first):
- ~/boolean-knowledge/builds/team-dispatch/.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/plan.md — THE instruction set: 8 vertical slices, 148 files, exact Create:/Modify: lines. Slices 1-3 done; 4-8 are your work. (gitignored — local-only to this machine.)
- (same run dir)/spec.md — frozen Phase 1 contract, 28 acceptance criteria A1-A28.
- (same run dir)/visual/surface-map.md — BINDING over the raw design: which UI elements are Phase 1 vs deferred (no Phase-2 embedded terminal, no Phase-3 clock/billable controls). visual/source/ holds the Dispatch v2 JSX/CSS to port.
- (same run dir)/peer-spec.md — Norman's adversarial review (already folded into plan.md; read for risk context).
- ~/boolean-knowledge/builds/team-dispatch/docs/dispatch-build-night1-handoff.md — fuller night-1 state (committed on main).
- ~/boolean-knowledge/builds/team-dispatch/docs/dispatch-build-0-to-100-checkpoint.md — the original brief (the why).
- ~/boolean-knowledge/builds/team-dispatch/CONTEXT.md + docs/adr/001-006*.md — domain glossary + 6 locked ADRs.
- ~/boolean-knowledge/builds/team-dispatch/AGENTS.md — repo conventions: stack, structure, the lint-enforced web-to-core/db boundary, commit-message format.
- ~/boolean-knowledge/clients/_registry.yaml — the client registry authored in Slice 3.

DELTA SINCE LAST WRITE:
- dev Slices 1-3 are MERGED TO main (PR #3, squash a607862): pnpm monorepo (packages/ web|api|core|db|mcp), kanban dashboard, Clerk auth with per-route-class guards, four-entity Postgres schema + headless core + read API. The branch build/dispatch-phase-1-spine was deleted on merge.
- Tests green at merge: core 16/16, api 14/14. Local Postgres (Homebrew, port 5432) already has dispatch_dev + dispatch_test.
- The /build orchestrator run is STALE — its metadata recorded the now-deleted branch. Its run-dir metadata.json was renamed to metadata.stale.json so the Stop hook stays quiet. Do NOT run `/build resume`. Drive Slices 4-8 directly off plan.md, same slice-by-slice discipline used for 1-3.
- Context only: the fail-open verifier bug in the /build harness was patched + verified 19/19 this session (separate work in boolean-knowledge/skills/cc-skills/build/scripts/, already pushed). Not part of this build.
- TWO operator gates — do NOT guess, Cody must answer:
  1. Clerk app — Slices 4-8 and live auth need a real Clerk application. Cody creates it in the Clerk dashboard, sets VITE_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY in .env, seeds Chris+Cody as publicMetadata.role=admin. Until then auth runs graceful-passthrough and the board 401s (correct behavior, not a bug).
  2. OQ-2 Slack write-back identity — Slice 5 HARD-STOPS at the live chat.postMessage step until Cody picks: a Boolean bot posting attributed-to-the-SE (plan default, ToS-clean) vs per-SE Slack user tokens. Codex flagged this as the one carry-forward.
- _registry.yaml has 2 PENDING_* channels (C&A Painting, Service Built — confirm Slack channel IDs) and a provisional SE on Select Painting & Coatings (Rensy vs Marcel — confirm). Cody to resolve.

IN-FLIGHT WORK:
- main @ a607862 carries Slices 1-3. Standalone kanban demo on seed data (no backend): commit aa3a2c4.
- Slices 4-8 NOT built — 4: ingestion interface + Slack webhook feeder + Contact discovery. 5: ticket detail + reply + Slack write-back (OQ-2 gated). 6: status ladder + business-hours SLA timer. 7: internal thread + reassignment + effort bucket. 8: dispatch MCP skeleton.
- e2e / review / qa phases not run.
- No half-mutations: main clean, working tree clean, the feature branch merged-and-deleted.

RESUMPTION COMMAND (run as the first action):
Build dispatch Phase 1 to the finish line:
1. `cd ~/boolean-knowledge/builds/team-dispatch && git checkout main && git pull`. Confirm HEAD is a607862, `ls packages/` shows api/core/db/web, then `pnpm install && pnpm test` -> expect core 16/16 + api 14/14 green. That confirms a correct pickup.
2. `git checkout -b build/dispatch-phase-1-slices-4-8`.
3. Read plan.md (run-dir path above). Implement Slices 4 then 5 then 6 then 7 then 8 one at a time: one general-purpose subagent per slice (model: sonnet), each builds its slice's file list, verifies (typecheck + the slice's tests + L1 evidence — a real screenshot or real test output), and commits `dev(slice N): ...` ending the body with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. surface-map.md is binding — no Phase-2/3/4 elements.
4. Slice 5: build the ticket-detail + reply UI and the durable slack_outbox table, but HARD-STOP before the live chat.postMessage send — that needs Cody's OQ-2 decision. If unanswered, build everything else in Slice 5 and leave the live-send wiring stubbed with a clear TODO.
5. Run a Codex cross-model checkpoint (mcp__plugin_ship_codex__codex, sandbox read-only) after ~Slice 6 (about 75% scope) and again after qa — review plan vs code, incorporate findings before continuing.
6. After Slices 4-8: dispatch subagents for e2e tests, a code review, and qa — each with L1 evidence; fix what they find.
7. /land the branch (push -> PR -> lint/typecheck/test gates -> squash-merge).
Stop only at shipped or a real wall (the two operator gates above, or a verification you genuinely cannot pass — work through transient failures). Cody is reachable for the two gated decisions; for everything else make the call and keep moving. Do NOT `/build resume` — the orchestrator run is stale; plan.md is the authority.
