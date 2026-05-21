# dispatch — E2E test suite

Playwright-based end-to-end tests covering the Phase-1 user-facing surfaces.

## Auth strategy: graceful-passthrough

When `VITE_CLERK_PUBLISHABLE_KEY` is unset (no `.env*` file in `packages/web/`),
the app's `RequireAuth` wrapper lets every visitor through without a Clerk
sign-in. The rail footer renders the seeded "Dan" identity.

This is the E2E auth strategy for Phase 1. Tests run entirely in this mode —
no live Clerk session is required or used.

## Running the suite

```bash
# From the repo root:
pnpm e2e
```

Playwright's `webServer` config in `playwright.config.ts` automatically starts:
1. The Vite dev server on port 5173 (no Clerk key → graceful-passthrough).
2. The API server on port 3000, pointed at `dispatch_dev`.

Both servers are reused if already running.

## Specs

| File | Surface | Coverage |
|------|---------|----------|
| `issues-board.spec.ts` | Surface 2 — Kanban board | A22, A23, A24-shell |
| `ticket-detail.spec.ts` | Surface 3 — Ticket detail | A24 (detail), phase-1 fidelity |
| `internal-thread.spec.ts` | Surface 3 — Internal thread | A21, OQ-3 |
| `route-stubs.spec.ts` | Surfaces 4 & 5 — Settings + Analytics | stub shell fidelity |
| `density-toggle.spec.ts` | Surface 2 — Density toggle | plan §Slice 1 |
| `companion-bridge.spec.ts` | Companion bridge (Spike #1) | A8/A9/A10a/A10b/A11/A12b/A12d auth matrix + PTY-over-WS pipe |
| `companion-mint-route.spec.ts` | `POST /api/companion/sessions` (Spike #1) | route wiring + Clerk gate (live-server reachable parts) |
| `companion-panel.spec.ts` | `PanelTerminal` (Spike #1) | A14 — terminal mode + clean failure state through the seam |

## Companion-bridge tests — what they prove, and the deliberate fences

The three `companion-*` specs are the **persistent regression layer** for the
Spike #1 Companion bridge. They re-run in CI forever.

- **`companion-bridge.spec.ts`** is a *Node-level* e2e (no browser `page`). It
  spawns the **real** `@dispatch/companion` modules — the real three-factor
  `authenticateUpgrade`, the real `BridgeSession` PTY↔WebSocket duplex, the real
  `protocol.ts` frame contract — against a **benign PTY command** (`/bin/sh`,
  `/bin/cat`), and connects with real `ws` clients over a real loopback socket.
  It proves the auth-rejection matrix (no/bad/expired/replayed/cross-scope
  token → 401; wrong/`null` Origin → 403; non-loopback/spoofed `Host` → 403),
  the accept path, and the PTY pipe (stdout bytes arrive over the WS, typed
  keystrokes echo back, a `resize` frame reflows the PTY columns). The bridge
  test harness lives in `companion-helpers.ts`.

- **`companion-mint-route.spec.ts`** hits the **live** api server (port 3000)
  and proves the mint route is wired, is Clerk-gated (unauthed → 401), and is a
  `POST` (a `GET` is not accepted).

- **`companion-panel.spec.ts`** drives the real `/t/:displayId` browser surface,
  opens terminal mode via the `claude-code` toolbar button, and proves the panel
  reaches a **clean, explicit failure state** with no Companion running (A14) —
  it does not hang or throw. The failure path routes *into* the degradation
  seam, not a dead end.

**CRITICAL — no e2e test spawns or drives an interactive `claude` session.**
CI has no `claude` auth and an interactive `claude` never exits — it would hang
the run. The bridge tests use a benign PTY command. A live `claude` session
rendering in the browser xterm.js panel was proven by the dev phase's one-off
L1 evidence (`.build-runs/.../evidence/`); it is not a CI test.

## Fixture path

`ticket-detail.spec.ts` and `internal-thread.spec.ts` navigate to `/t/DSP-2876`.
When the api server returns an error (or 401), `TicketDetailPage` falls back to
`FIXTURE_TICKET` (gated on `import.meta.env.DEV`). This makes ticket-detail tests
reliable without requiring a live Clerk session.

The fixture displayId is `DSP-2876` — changing it breaks these tests.

## Database

Tests that touch the board (`issues-board.spec.ts`) read from `dispatch_dev`
via the API server. The webServer config always sets:

```
DATABASE_URL=postgresql://cody@localhost:5432/dispatch_dev
```

`dispatch_test` is for Vitest unit/integration tests only. E2E never touches it.

## Screenshots and traces

- Screenshots: `e2e/test-results/` (per-test on failure; per-spec on all runs
  via `screenshot: "on"` in playwright.config.ts)
- HTML report: `e2e/playwright-report/`
- Traces: `e2e/test-results/` on first retry

## Acceptance criteria not covered in E2E (with reasons)

| Criterion | Reason not covered |
|-----------|--------------------|
| A9-A13 (ingestion) | Requires POSTing to `/api/ingest/stub` with live DB + Slack signing secret — covered by Vitest API integration tests |
| A15-A19 (status ladder transitions) | Timer-driven transitions require time manipulation; covered by Vitest core unit tests |
| A20 (Slack write-back) | Requires live Slack token + OQ-2 resolution; covered by API integration test stubs |
| A25 (undo affordance) | Undo toast asserted implicitly via mutation flow; full undo round-trip is a Vitest API test |
| A26-A27 (reassignment + reinforcement) | Requires authenticated multi-user session; covered by Vitest core tests |
| A28 (full end-to-end spine) | Full spine = all of A9-A27 together; covered by API integration tests, not a UI flow |
| A2-A3 (MCP) | MCP is a stdio server, not a browser surface |
| Companion mint happy path (A12e — scoped token + `Cache-Control: no-store`, inaccessible-ticket 403) | Needs a valid Clerk session JWT; the e2e api process runs with `CLERK_SECRET_KEY=""` and there is no cross-process Clerk-verifier injection seam. Covered by the Supertest suite `packages/api/test/companion.test.ts` (8 tests, in-process mock verifier). |
| Companion `degraded`-via-`fallback-transport.stub` state (A14b) | `RightPanel` renders `PanelTerminal` with the real WS transport — no prod injection hook for the stub. Covered by the web component test `packages/web/src/ticket/terminal-transport.test.tsx`, which renders `PanelTerminal` with the stub and asserts the `degraded` UI. |
| Live `claude` session render in the xterm.js panel (A1-A5b) | Needs `claude` auth + an interactive session that never exits — would hang CI. Proven by the dev-phase one-off L1 evidence recordings; not a CI test. |
