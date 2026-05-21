# dispatch build — night-1 handoff (resume from here)

**Written:** 2026-05-21, end of the autonomous overnight `/build` run.
**Supersedes nothing** — this is a delta on top of `dispatch-build-0-to-100-checkpoint.md`.
Read the checkpoint for the why; read this for the where-we-are.

---

## TL;DR

The fail-open verifier bug is **patched and verified** (the non-negotiable). The `/build`
pipeline ran grill → visual → design → dev, and is **parked mid-dev** with the foundation
built: **dev Slices 1–3 of 8 are done and verified.** Slices 4–8 and the e2e/review/qa/handoff
phases remain. Two items genuinely need Cody before the build can finish.

---

## 1. The verifier patch — DONE, verified 19/19

Separate from the build, in `boolean-knowledge/skills/cc-skills/build/scripts/`
(auto-pushed to GitHub). Three scripts now fail **closed** — a missing, crashed, hung, or
garbled verifier **halts and escalates**, never auto-passes:

- `build-orchestrate.sh` — `run_verify()` + the `cmd_complete` verifier handler; the
  `recursion-guard auto-pass` and the `verifier unavailable` fallback are gone.
- `stop-verifier.sh` — the "no parseable verdict → allow Stop (fail open)" path and the
  missing/non-executable-verifier path now `block`.
- `verify.sh` — the bypass-context guard emits `TASK_BLOCKED` + exit 3 instead of exit 0.
- Secondary: `execution-drill.sh` exit-code mapping (any non-zero ≠ pass); iteration cap
  reconciled to `MAX_RETRIES=3` across both scripts.

Verified with a harness (`/tmp/build-patch-backup/verify-patch-test.sh`): 19/19 — simulated
verifier failures now halt where the originals advanced. Originals backed up at
`/tmp/build-patch-backup/*.orig`.

## 2. The /build run

- **task_id:** `build-dispatch-boolean-s-internal-client-20260521T043234`
- **state:** `phase=dev`, branch `build/dispatch-phase-1-spine` (local only — **not pushed**).
- **grill** → `spec.md` (Phase 1 spine, 28 acceptance criteria). Verifier PASS.
- **visual** → `visual/` (Dispatch v2 design system + surface-map + source). Verifier PASS.
- **design** → `plan.md` (8 vertical slices, 148 files). Norman peer review → 4 gaps closed.
  **Codex cross-model checkpoint #1** → REVISE (9 findings) → all 9 closed → **GO**.
  execution-drill 148 PASS. Verifier PASS.
- **dev** → Slices 1–3 built (see §3). Parked here.

Artifacts: `.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/`
(`spec.md`, `plan.md`, `peer-spec.md`, `gate-design.md`, `verifier-log.md`, `visual/`,
`dev-slice1-evidence.png`, `dev-slice3-evidence.png`).

## 3. dev — what is built (Slices 1–3 of 8)

Branch commits: `0b61b73` spec · `a9f36ca` gitignore · `1557c78` setup ·
`aa3a2c4` slice 1 · `1fae6bd` slice 2 · `1ce5ca1` slice 3.

| Slice | What | State |
|---|---|---|
| 1 | pnpm monorepo (`web`/`api`/`core`/`db`/`mcp`); kanban dashboard on seed data | ✅ verified — screenshot, build+typecheck clean |
| 2 | Clerk auth; four per-route-class guards; `GET /api/me` | ✅ verified — 8/8 mocked-SDK tests, build clean. Live flow pending a Clerk app |
| 3 | `packages/db` four-entity + support schema; `packages/core` services + registry; read API; board reads live API | ✅ verified — 30/30 tests, migrations applied to local Postgres |
| 4 | ingestion interface + Slack webhook feeder | ⬜ |
| 5 | ticket detail + reply + Slack write-back | ⬜ **gated** — OQ-2 (see §5) |
| 6 | status ladder + business-hours SLA timer | ⬜ |
| 7 | internal thread + reassignment + effort bucket | ⬜ |
| 8 | dispatch MCP skeleton | ⬜ |

**Honest state of the app at HEAD:** Slice 3 wired the board to the Clerk-gated API, so
without a Clerk app the board renders empty (correct auth behavior — a 401, not a bug).
The standalone running kanban is at Slice 1's commit `aa3a2c4` (`git stash` not needed —
just check out that SHA, `pnpm i && pnpm dev`). The full live stack needs the two items in §5.

## 4. How to resume

```
cd /Users/cody/boolean-knowledge/builds/team-dispatch
bash ~/boolean-knowledge/skills/cc-skills/build/scripts/build-orchestrate.sh status
```

The run is at `phase=dev`. Continue dev by implementing **Slice 4**, then 5–8, per
`.build-runs/.../plan.md` — one slice per subagent, commit per slice, then report
`build-orchestrate.sh complete dev --verdict=success` once all 8 slices are in. After dev:
e2e → review → qa → handoff. There is a **Codex checkpoint** at each ~25% scope boundary
and before handoff — honor it (`mcp__plugin_ship_codex__codex`).

## 5. Needs Cody — two real gates

1. **Clerk application.** Slices 2–8 need a real Clerk app: create it in the Clerk
   dashboard, put `VITE_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` in `.env`, seed Chris
   and Cody as `publicMetadata.role = "admin"`. Until then auth/board can't run end-to-end.
2. **OQ-2 — Slack write-back identity.** Slice 5 will **hard-stop** at the live
   `chat.postMessage` step until you choose: a Boolean bot posting *attributed to* the SE
   (`username`/`icon` override — the plan's default, ToS-clean) vs. per-SE Slack user
   tokens (literal authorship, heavier token custody). Codex flagged this as the one
   carry-forward; the plan gates dev on it.

**Minor — `clients/_registry.yaml` (in boolean-knowledge, already pushed):** two channels
are `PENDING_*` (C&A Painting, Service Built — confirm Slack channel IDs) and Select
Painting & Coatings has a provisional SE (Rensy vs Marcel — confirm).

## 6. Not pushed

`build/dispatch-phase-1-spine` is **local-only** on this machine. `_registry.yaml` (in
`boolean-knowledge`) is pushed via the knowledge-repo auto-push. Push the team-dispatch
branch when ready, or let the pipeline's handoff phase do it.
