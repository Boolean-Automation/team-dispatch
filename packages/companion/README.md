# @dispatch/companion

The dispatch **Companion** — a small local process that surfaces the SE's own
`claude` CLI inside the dispatch web UI over an authenticated localhost
WebSocket. ADR-001's architecture: dispatch never holds a Claude credential;
the Companion spawns the SE's already-installed `claude`, the same model as
VS Code's integrated terminal running `claude`.

This package is **Spike #1** — a feasibility spike that proves the
PTY-over-WebSocket bridge. It is started by hand on the pilot machines; there is
no installer (Phase 2).

## What it does

- Binds a WebSocket server to `127.0.0.1` **only** (never `0.0.0.0`).
- Spawns `claude` in a `node-pty` PTY via a **direct argv array** — no shell
  wrapper of any kind.
- Authenticates every connection with **three** checks at the WebSocket
  `upgrade` boundary, before any PTY spawns:
  1. a backend-minted short-TTL single-use HS256 connection token, scoped to
     the Clerk user + ticket + session + origin;
  2. a strict exact-match `Origin` allowlist (absent / `null` Origin rejected);
  3. a loopback `Host`-header pin (the DNS-rebinding defense).
- Opens `claude` with `cwd` at the `boolean-knowledge` repo root and injects
  the Ticket + Account as an opening context preamble.
- Runs a per-session heartbeat / idle timeout and tears the PTY down with a
  **process-group kill** + `SIGTERM`→`SIGKILL` escalation — no orphaned
  `claude`, shell, or child process leaks.

## Run it

```bash
# from the repo root
pnpm --filter @dispatch/companion dev
```

Required env (see the repo `.env.example`):

- `COMPANION_TOKEN_SECRET` — shared HS256 secret. The dispatch api mints
  connection tokens; the Companion verifies them. **Required** — the Companion
  will not start without it. Generate: `openssl rand -hex 32`.
- `COMPANION_PORT` — fixed loopback port. Default `7720`.
- `BOOLEAN_KNOWLEDGE_ROOT` — the repo root the Companion opens `claude` at.
  Default `~/boolean-knowledge`.
- `COMPANION_ALLOWED_ORIGINS` — comma-separated strict Origin allowlist.

## node-pty version pin (load-bearing)

`node-pty` is pinned **exactly** to `1.2.0-beta.13`. The `1.1.0` `latest` tag
throws `posix_spawnp failed.` at PTY spawn on Node 25 — proven by the prototype.
Do **not** float `node-pty@^1.1`. node-pty prebuilts are Node-line-sensitive;
re-verify the pin whenever the Companion's Node version moves. macOS ships
prebuilt `darwin-arm64` / `darwin-x64` binaries — no compiler is needed on the
happy path; Xcode CLT is only the `node-gyp` fallback.

## Tests

```bash
pnpm --filter @dispatch/companion test
```

`auth.test.ts`, `protocol.test.ts`, and `pty-lifecycle.test.ts` are supporting
evidence. The binding L1 evidence (a real `claude` session rendering in the
browser) is captured in the spike's evidence phase.
