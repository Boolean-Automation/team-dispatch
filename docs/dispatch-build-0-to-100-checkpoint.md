# dispatch build — 0-to-100 handoff checkpoint

## OBJECTIVE

Drive the dispatch.paintos.app build from zero toward done via Boolean's `/build` pipeline, autonomously and overnight. dispatch is Boolean's internal client-support tool: every inbound client message becomes a ticket, SEs triage / reply / time-track in one place, replacing a Slack-scattered + Airtable-task workflow. The grill and design phases are already done — spec artifacts and a finished four-surface design exist. Before running `/build`, the new window MUST patch a fail-open verifier bug in the build harness so the pipeline cannot silently pass unverified work during an unattended run. Cody's words: "go from 0-100... I want the script constantly checking the spec and not going rogue... let's work towards security." He is away overnight — run autonomously, pause only at the gates named in the Resumption command.

## Reference paths (read these first)

- `/Users/cody/boolean-knowledge/builds/team-dispatch/CONTEXT.md` — THE SPEC. Glossary, ingestion rule, ticket status ladder, locked decisions, open gates, the four-phase build plan. Everything the build is checked against.
- `/Users/cody/boolean-knowledge/builds/team-dispatch/docs/adr/` — six ADRs (001-006). ADR-001 (AI via local Companion) and ADR-005 (ticket grain + loud classification) are load-bearing.
- `/Users/cody/boolean-knowledge/builds/team-dispatch/docs/pylon-design-reference.md` — captioned Pylon reference R0-R10, each mapped to a dispatch surface.
- `/Users/cody/Downloads/Dispatch v2/` — the finished Claude Design output. All four surfaces as JSX + CSS + HTML (shell, ticket-detail, settings, analytics) plus rendered HTML. The UI the dev phase builds from.
- `/Users/cody/boolean-knowledge/skills/cc-skills/build/SKILL.md` — the `/build` harness (v1.2). Read before running. The relay is a thin layer over `build-orchestrate.sh`; the script owns state.
- `/Users/cody/boolean-knowledge/skills/cc-skills/build/scripts/build-orchestrate.sh`, `verify.sh`, `stop-verifier.sh` — the scripts to patch (fail-open verifier).
- GH issues `Boolean-Automation/team-dispatch#1` (Companion-bridge spike) and `#2` (G1 runtime-host spike) — the two architecture walls autonomy cannot resolve.
- `/Users/cody/boolean-knowledge/operations/projects/internal-support-platform/playbook.md` — the parked origin playbook. The grill thread (now in CONTEXT.md + the ADRs) is canonical over it on any conflict.
- team-dispatch repo today = a single-file React/Firebase prototype at `dispatch/index.html`. Palette/visual reference only; the production build is greenfield (Clerk auth, real backend, four-entity DB, the `dispatch` MCP).

## Delta since last write

- **The /build verifier fails OPEN — fix before any run.** Audit 2026-05-20 found three spots where, if the independent verifier is missing, crashes, or returns garbled output, the pipeline records the phase as PASS and continues: (1) `build-orchestrate.sh` `run_verify()` — a missing verifier returns 0, and a crash is swallowed by `|| true` plus a hardcoded `TASK_COMPLETE: verifier unavailable`; (2) `stop-verifier.sh` — no parseable verdict prints "allowing Stop" and passes; (3) the env var `BUILD_STOP_VERIFIER_BYPASS=1` triggers a `recursion guard — auto-pass` that skips the verifier entirely. Fix: all three must fail CLOSED — an unanswerable verifier halts and escalates to the operator, never auto-passes. Same-class secondary fixes: `execution-drill.sh` only loops back on exit code 2 (exit 1 is treated as pass — map any non-zero to fail); and the iteration cap is inconsistent (`build-orchestrate.sh` `MAX_RETRIES=3` vs `stop-verifier.sh` blocking at `>=2` — reconcile to one number). Verify each spot first-hand before editing — this is a shared harness; a bad edit breaks every future build.
- **Design is done, all four surfaces.** `~/Downloads/Dispatch v2/` has shell + ticket-detail + settings + analytics. Cody confirmed "we're good on design."
- **The Codex checkpoint is instruction-layer only.** `build/SKILL.md` v1.2 adds a "Cross-LLM checkpoint review (Codex)" section: at each major milestone (~25% of scope / a phase boundary) the run pauses and emits a Codex review prompt for Cody. It is NOT enforced by `build-orchestrate.sh` — the relay must honor it manually. Hard-wiring it into the orchestrator is a tracked follow-up.
- **AI architecture (ADR-001):** the embedded "Claude window" is the SE's own local Claude Code, run by a local Companion (xterm.js over an authenticated localhost WebSocket). Anthropic bans third-party web apps from routing API calls through user subscriptions — verified, so a server-side Boolean Anthropic Console org is the fallback engine. The Companion is a Phase 2 build, gated on spike #1.
- **TDD is real.** Cody's "cannonball test" was a stale term for TDD. `operations/standards/tdd-discipline.md` exists and loads into the dev phase; `debugging-discipline.md` loads into e2e/qa; `git-guardrails.py` is wired as a hook; the phase-guardrail hook (role isolation) and the anonymous phase verifier are real and wired in `~/.claude/settings.json`.
- **Two HITL walls autonomy cannot resolve:** spike #1 (Companion PTY/WebSocket feasibility, ~3-5 days, Cody + Rory) and spike #2 (G1 — does the persistent Slack ingestion socket live in the IPP or its own service, ~2 weeks, Cody + Rory). Phase 2 is fully gated on #1; Phase 1's Slack ingestion is partly gated on #2.
- **Honest scope:** one overnight does not finish dispatch (greenfield, four surfaces). Realistic target: verifier patched, then the foundation + Phase 1 spine (scaffold, Clerk auth, the four-entity schema, the kanban UI from Dispatch v2, the `dispatch` MCP skeleton) built and gated, parked at the first Codex checkpoint or spike wall. Do not over-promise a finished app.

## In-flight work

- `team-dispatch` is its own git repo (NOT covered by boolean-knowledge auto-push). `CONTEXT.md`, `docs/adr/001-006`, `docs/pylon-design-reference.md`, and this checkpoint are written to the working tree but uncommitted. `/build` will cut a branch — commit the spec files onto it.
- GH issues #1 and #2 are filed and open. No Phase 1 issues filed yet; file them at the start of Phase 1.
- `build/SKILL.md` is at v1.2 (Codex section added). The three scripts are UNPATCHED — the fail-open holes are still live.
- No build started: no `.build-runs/` directory exists; team-dispatch holds only the prototype `dispatch/index.html`.

## Resumption command

Cody is away overnight and authorized autonomous 0-100. Execute; do not ping him except at the gates in step 6.

1. `cd /Users/cody/boolean-knowledge/builds/team-dispatch` — the `/build` harness anchors to the repo root; always run from inside the repo.
2. **Patch the fail-open verifier.** Read `build-orchestrate.sh`, `verify.sh`, `stop-verifier.sh` first-hand, confirm the three spots named in the Delta block, then make the verifier fail CLOSED — an unanswerable verifier halts and escalates, never auto-passes. Fix the `execution-drill.sh` exit-code mapping and reconcile the iteration cap to one number. Verify the patch by confirming a simulated verifier failure now halts instead of passing.
3. `echo $BUILD_STOP_VERIFIER_BYPASS` — confirm it is empty in this session before running anything.
4. Read `build/SKILL.md`, then run `/build` with the north star: "Build dispatch, Boolean's internal client-support tool — Phase 1 the spine, per CONTEXT.md." Grill is already done (CONTEXT.md + ADRs + issues exist); the design phase consumes `~/Downloads/Dispatch v2/`.
5. Honor the Codex checkpoints: at each major milestone, pause, write a Codex review prompt for Cody (diff range + the relevant ADRs + a directed correctness/security ask), and stop there.
6. **Stop ONLY at:** a Codex checkpoint, a genuine architecture wall (spike #1 or #2), or shipped. Work through everything else — transient failures, named cheap tests, routine decisions.

Quality bar (Cody's): real, verified progress and a clean handoff — never a rogue pile of unverified code. The verifier failing closed is non-negotiable. The first thing Cody should see in the morning is the verifier patch, `/build status`, and a Codex checkpoint prompt.

Verification you picked up correctly: `CONTEXT.md` reads as the spec; the three verifier holes are confirmed present, then patched; `/build status` shows a clean run.
