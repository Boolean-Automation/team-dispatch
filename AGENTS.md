# Agents — Repo Context for /build Pipeline

**Repo type:** dispatch — Boolean's internal client-support tool
**Generated:** 2026-05-21T04:32:34Z by /build:setup
**Slice 1 enriched:** 2026-05-21 by Vera (frontend/architecture)

## Purpose

dispatch is Boolean's internal tool for managing client support tickets.
Support engineers (SEs) work tickets through a kanban status ladder, reply to
clients via Slack, and track follow-up SLAs. The Phase 1 spine covers the
kanban dashboard, ticket detail, Slack write-back, and the status/SLA ladder.

Read `CONTEXT.md` for the operator brief and `docs/` for ADRs.
The `/build` plan lives at `.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/plan.md`.

---

## Stack (Phase 1)

| Layer | Choice | Version |
|---|---|---|
| Package manager | pnpm workspaces | 9.x |
| Language | TypeScript | 5.6.x |
| Frontend | React + Vite | React 18.3, Vite 5.x |
| Routing | React Router | 6.x |
| Data fetching | TanStack Query | 5.x |
| Styling | Plain CSS (Dispatch v2 design verbatim) | — |
| Backend | Node + Fastify | Node 20, Fastify 4.x |
| Validation | Zod | 3.x |
| DB | PostgreSQL (Railway managed plugin) | 16 |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.33.x |
| Auth | Clerk | @clerk/clerk-react 5.x, @clerk/backend 1.x |
| Background timers | node-cron (in api process) | 3.x |
| Slack write-back | @slack/web-api | 7.x |
| MCP | @modelcontextprotocol/sdk | 1.x |
| Tests | Vitest + Supertest | Vitest 2.x |
| Hosting | Railway — `team-dispatch` project, single Fastify service |

---

## Repo structure

```
team-dispatch/
  package.json            # pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json      # shared TS compiler options
  eslint.config.js        # flat config — no-restricted-imports enforces web→core/db boundary
  Dockerfile              # builds web + api; api serves web/dist
  railway.json            # Railway service config
  .env.example            # all required env vars documented
  dispatch/index.html     # OLD prototype — DO NOT TOUCH
  packages/
    web/                  # React + Vite SPA
      src/
        main.tsx          # entry — imports CSS, mounts App
        App.tsx           # QueryClient + BrowserRouter providers
        routes.tsx        # four routes: /, /t/:displayId, /settings, /analytics
        styles/           # Dispatch v2 CSS verbatim (shell, issues, ticket-detail, settings, analytics)
        shell/            # Rail, Topbar, StatusBar, Avatar, Ic, format helpers
        issues/           # IssuesPage, Board, Column, Card (kanban)
        ticket/           # TicketDetailPage (Slice 5 expands this)
        settings/         # SettingsPage stub
        analytics/        # AnalyticsPage stub
        lib/              # types.ts, seed.ts (Slice 1); queries.ts + api-client.ts (Slice 3)
    api/                  # Fastify HTTP app — thin layer over core (Slice 2+)
    core/                 # Headless business logic — the only place logic lives (Slice 3+)
    db/                   # Drizzle schema + migrations + seed (Slice 3+)
    mcp/                  # dispatch MCP — thin stdio HTTP wrapper (Slice 8)
```

---

## Conventions

### Architecture boundary (ENFORCED)
`packages/web` must NEVER import from `@dispatch/core` or `@dispatch/db`.
- Enforced by `eslint.config.js` (`no-restricted-imports`) — lint fails the build on violation.
- Enforced by package.json `dependencies` — web does not list core/db as deps.
- Web talks to the backend exclusively through the HTTP API client (`packages/web/src/lib/api-client.ts`, wired in Slice 3).

### TypeScript
- All packages extend `tsconfig.base.json` at the repo root.
- `moduleResolution: "bundler"` — use bare imports, no `.js` extensions needed.
- `strict: true` throughout.

### CSS
- The Dispatch v2 CSS files are the design contract — do NOT re-tokenize into a CSS framework.
- `shell.css` is loaded first (contains `:root` tokens, layout primitives).
- Screen-specific CSS files (`issues.css`, `ticket-detail.css`, etc.) add only what `shell.css` doesn't cover.
- Density toggle: `data-density="compact"` (default) / `"comfortable"` on `<body>`.

### Data fetching (Slice 1 → Slice 3)
- All board/query reads go through TanStack Query hooks.
- `refetchInterval: 25_000` on board queries — the live-update strategy for the 2-person pilot.
- `dataUpdatedAt` from TanStack Query drives the status-bar "last sync" label (real time, not cosmetic).
- Slice 1: `queryFn` returns the `SEED_TICKETS` array.
- Slice 3: `queryFn` replaced with `fetch("/api/tickets")` — no other change needed.

### Imports
- Use `../lib/types` for all shared TypeScript types in the web package.
- Use `../lib/seed` for seed data / engineer/account metadata in Slice 1.
- Never `import` across the core/db boundary from web.

### Naming
- React components: PascalCase, `.tsx`.
- Helpers / hooks: camelCase, `.ts`.
- CSS classes: kebab-case, matching the Dispatch v2 design exactly.

### Commit message format
- Subject: `dev(slice N): <description>`
- Body ends with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## /build phase calibration

- **Host agent:** Vera (frontend/architecture) for dev + visual phases.
- **Plan:** `.build-runs/build-dispatch-boolean-s-internal-client-20260521T043234/plan.md` — eight slices, each independently runnable.
- **Current slice:** Slice 1 complete (kanban dashboard on seed data).
- **Stop verifier:** anonymous claude (verify.sh).
- **L1 evidence required** at all evidence-producing phases — screenshot of real rendered UI, not "HTTP 200".
- **Gates honored:** G1 (persistent socket) not built. Phase 2/3/4 elements excluded per `surface-map.md`.

## Slice status

| Slice | Description | Status |
|---|---|---|
| 1 | Running app: kanban dashboard on seed data | ✅ Complete |
| 2 | Clerk auth gates the app | ✅ Complete |
| 3 | Backend + four-entity schema + live data | ⬜ Not started |
| 4 | Ingestion interface + Slack webhook feeder | ⬜ Not started |
| 5 | Ticket detail + reply + Slack write-back | ⬜ Not started (OQ-2 gate on send path) |
| 6 | Status ladder + business-hours SLA timer | ⬜ Not started |
| 7 | Internal thread + reassignment + effort bucket | ⬜ Not started |
| 8 | dispatch MCP skeleton | ⬜ Not started |
