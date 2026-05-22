# ADR-001 — AI delivery via a local Companion

**Status:** superseded by ADR-007 (`build/dispatch-phase-2-terminal` roundtable, 2026-05-21)

## Supersede note

> The framing below — dispatch as an "embedded Claude window" / an "AI delivery"
> surface — is **replaced** by ADR-007's embedded local terminal driven by a
> local Companion. dispatch makes **no AI claim** and holds **no Anthropic
> credential**. The Companion spawns the SE's **own login shell** (`$SHELL -l`),
> not `claude` directly. If an SE wants Claude, they run `claude` themselves
> inside the terminal and device-flow-auth as themselves. The server-side Agent
> SDK fallback engine described under "Decision" below is **killed** — there is
> no Boolean-held Console org for interactive or automation AI. ADR-001 stays in
> the record as immutable history; ADR-007 is the live decision.

## Context

dispatch needs an embedded, per-Ticket Claude window so SEs keep an AI session
next to the problem it is solving instead of jumping between windows. The
operator's goal is for that AI to run on each SE's own Claude subscription.

Research (Mark, 2026-05-20) confirmed Anthropic **bans** third-party web apps
from offering "log in with Claude" or routing API calls through users' Pro/Max
subscriptions (enforced from 2026-01-09, full enforcement 2026-04-04). The Claude
Agent SDK is API-key-only for third-party apps. A Claude Pro subscription and an
Anthropic API key are separate billing products.

## Decision

The embedded window is the SE's **own locally-installed Claude Code**, run by a
local **Companion** process and surfaced as an xterm.js terminal in the dispatch
web UI over an authenticated localhost WebSocket. dispatch never holds a Claude
credential and never offers a Claude login — the same model as VS Code's
integrated terminal running `claude`.

A Boolean-held Anthropic Console org with per-SE workspaces provides a
**server-side Agent SDK fallback** for sessions where the Companion is absent and
for automation (classification, follow-up/closeout drafting).

## Consequences

- Interactive AI cost stays on SE subscriptions and is ToS-clean.
- Adds a local-process build surface: install, auto-update, the PTY/WebSocket
  bridge, localhost auth. Per-machine dependency.
- The tool must degrade to the server-side fallback when the Companion is
  absent. It must never hard-fail.
- Boolean still maintains a small Console-org bill for automation AI.

## Tradeoff

Companion fragility and build cost, against ToS compliance and ~$0 interactive
AI cost. The fallback removes the single-point-of-failure risk.
