# @dispatch/companion

The dispatch **Companion** — a small local process that surfaces the SE's own
login shell inside the dispatch web UI over an authenticated localhost
WebSocket. Per ADR-007, dispatch never holds an Anthropic credential; the
Companion spawns a bare `$SHELL -l` and any `claude` invocation is the SE's
own already-installed CLI, started by the web-side **launcher** typing macro.

> **Superseded behavior (ADR-001).** The first iteration of this README
> described the Companion spawning `claude` directly with an injected ticket
> context preamble. That design is **gone**. Phase 2 split the responsibilities:
> the Companion only runs a shell; the dispatch web app types the launcher
> command into that shell. See ADR-007 for the rationale.

## Overview

- Headless local process: WebSocket server bound to `127.0.0.1` only
  (never `0.0.0.0`), plus `/healthz` + `/metrics` on the same loopback port.
- Owns zero secrets. No Anthropic credential, no Clerk credential, no OAuth.
  The only secret it reads is `COMPANION_TOKEN_SECRET` — the HS256 shared
  secret used to verify backend-minted single-use connection tokens.
- Spawns one `node-pty` PTY per `(ticket_id, pty_id)` pair on demand. Capped
  at `MAX_PTYS_PER_TICKET` (default 3) per ticket. Idle PTYs whose WS
  has been closed for longer than `SWEEPER_IDLE_MS` (default 60 s) are
  reaped by the background sweeper.
- Refuses to start on Windows — the security model (process-group teardown,
  loopback binding semantics, env fence) is POSIX-only.

## How it runs

```bash
# from the repo root
pnpm --filter @dispatch/companion dev
```

Required env (see the repo `.env.example`):

- `COMPANION_TOKEN_SECRET` — shared HS256 secret. The dispatch api mints
  connection tokens; the Companion verifies them. **Required** — the
  Companion will not start without it. Generate: `openssl rand -hex 32`.
- `COMPANION_PORT` — fixed loopback port. Default `7720`.
- `BOOLEAN_KNOWLEDGE_ROOT` — the cwd the spawned shell starts in.
  Default `~/boolean-knowledge`.
- `COMPANION_ALLOWED_ORIGINS` — comma-separated strict exact-match Origin
  allowlist.
- `MAX_PTYS_PER_TICKET` — per-ticket PTY cap (default `3`).
- `SWEEPER_TICK_MS` / `SWEEPER_IDLE_MS` / `SWEEPER_GRACE_PAUSE_MS` /
  `KILL_GRACE_MS` — sweeper + teardown timing (sensible defaults).

The PTY's argv is **`$SHELL -l`** (login shell). When `$SHELL` is unset the
Companion falls back to `/bin/zsh`. The shell is spawned via a direct argv
array — no `/bin/bash -lc`, no `sh -c` wrapper. There is **no opening
context preamble**: the spawned shell is bare and lands at
`BOOLEAN_KNOWLEDGE_ROOT`.

## Wire protocol

Per-`(ticket_id, pty_id)` PTY map; the same WebSocket multiplexes multiple
PTYs for one ticket. Frames live in `src/protocol.ts`; key ones:

- `hello` (server → client) — on connect, advertises protocol version,
  capability set, and `companion_started_at` epoch. A change in the epoch
  invalidates every previously-cached `pty_id`.
- `pty.open` (client → server) — opens a new PTY for this ticket. Server
  replies with `pty.opened { pty_id, request_id }`, or
  `pty.error { code: "cap-exceeded" }` when the per-ticket cap is hit.
- `pty.data` (both directions) — UTF-8 byte stream. Server-→client carries
  shell output, client-→server is keystrokes.
- `pty.resize` (client → server) — sets cols/rows on the named pty_id.
- `pty.close` (client → server) — closes the named pty_id; the Companion
  responds with `pty.exit { code, signal }`.

Per-PTY authorization: every `pty.write` / `pty.resize` / `pty.close`
frame is checked against the connection's owner — a PTY opened by one
connection cannot be poked by another.

## Security

- **Loopback bind.** `127.0.0.1` only; the listener never binds `0.0.0.0`.
- **Three-factor WS upgrade auth** (before any PTY spawns):
  1. backend-minted short-TTL single-use HS256 connection token, scoped
     to the Clerk user + ticket + connection + origin;
  2. strict exact-match `Origin` allowlist (absent / `null` Origin is
     rejected);
  3. loopback `Host`-header pin (the DNS-rebinding defense).
- **Env allowlist + deny-suffix fence.** The spawned shell sees only an
  explicit allowlist of env names (PATH, HOME, USER, SHELL, TERM, LANG,
  LC_ALL, …). On top of that, the deny fence drops anything matching
  `*_SECRET`, `*_KEY`, `*_TOKEN`, `*_PASSWORD`, `ANTHROPIC_*`, or
  `CLAUDE_*` — even if accidentally allowlisted. The SE's `claude` CLI
  reads its own keychain on first run; the Companion never touches it.
- **Direct argv.** `node-pty` spawns `$SHELL` with a literal argv array
  (`['-l']`). No shell-string interpolation, no `sh -c` wrapping, no
  shell-metachar exposure.
- **Process group teardown.** Every PTY runs in its own process group.
  Teardown is `SIGHUP` → grace pause → `SIGTERM` → `KILL_GRACE_MS` →
  `SIGKILL`. No orphaned shells, no leaked child processes.
- **Idle-sweeper reaper.** PTYs whose owning WebSocket has been closed
  for longer than `SWEEPER_IDLE_MS` are killed on the next sweep tick.
- **Windows-refuses fence.** The Companion exits with a clear error on
  any non-POSIX platform — the security model is POSIX-only and the
  Windows path was never built per ADR-007.

## Local dev

```bash
# Run the Companion against a real dispatch api (mints tokens):
COMPANION_TOKEN_SECRET=$(openssl rand -hex 32) \
  pnpm --filter @dispatch/companion dev

# Unit tests (auth, protocol, lifecycle, env fence, multi-PTY map):
pnpm --filter @dispatch/companion test
```

The unit suite covers the three-factor auth, the protocol frames, PTY
lifecycle teardown, the env fence, and the per-ticket PTY map. The
binding L1 evidence (a real shell session rendering in the browser, with
the launcher typing macro injecting a `claude` invocation) is captured in
the Phase 2 evidence phase.
