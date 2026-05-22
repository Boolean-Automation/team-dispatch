# ADR-007 — Primary/Parachute execution model

**Status:** accepted (`build/dispatch-phase-2-terminal` roundtable, 2026-05-21)

Supersedes ADR-001.

## Context

dispatch's embedded surface is a real terminal, not a Claude window (ADR-001
supersede note). That terminal needs an execution host — something that owns a
PTY and a login shell. Two viable hosts exist, and SEs run on two operating
systems. A local Companion gives Mac/Linux SEs native, fast, offline-resilient
execution on their own machine. Windows has no native Companion. SEs also work
away from their primary machine and still need to solve client problems.

The killed Phase-2-AI build's failure mode was a server-side AI engine holding
an Anthropic credential. Any execution host dispatch builds must not reintroduce
that — a host that is pre-authed for `claude` *is* the killed AI engine wearing
a terminal costume.

## Decision

dispatch runs one **Primary/Parachute execution model** behind a single
`TerminalTransport` seam (`transport: 'companion' | 'remote'`).

- **Primary — the local Companion.** A process on the SE's own machine. Spawns
  `$SHELL -l` over a PTY. Native, fast, resilient to network loss. The default
  execution host for every Mac/Linux SE. Phase 2.
- **Parachute — Option B.** A Fly-Machines server-side **ephemeral container**.
  It is the host an SE drops into when off their native machine, and it is the
  **primary host for Windows SEs** (no native Windows Companion is built). Same
  `TerminalTransport` seam, `transport: 'remote'`. Phase 3.

**Binding credential rule.** No Anthropic API key ever lives in Boolean
infrastructure — not in the Companion, not in a Fly-Machines container, not in
Clerk metadata. If a session needs Claude, the SE runs `claude` and
**device-flow-authenticates themselves**, per container session. Containers are
**never pre-authed**. Container env allowlists are as strict as the Companion's
— shell ergonomics only, never signing or Anthropic secrets. A pre-authed
container is the architectural drift that re-creates the killed AI engine; this
rule is the structural fence against it.

## Consequences

- One transport seam, two interchangeable hosts. dispatch's UI renders the same
  xterm.js terminal regardless of which transport is live.
- Windows SEs are supported without a native Windows Companion build — the
  parachute carries them.
- Each parachute session costs a fresh SE device-flow auth. That friction is
  the price of holding zero Boolean-side Anthropic credential, and it is
  accepted, not engineered away.
- Option B is on the critical path for an entire SE operating system, not a
  rare fallback — so it is built and operated to the **primary** reliability
  bar, not a parachute-grade one.

## Tradeoff

A consciously-accepted two-tier experience. Mac/Linux SEs get local-laptop
latency and offline resilience; Windows SEs get cloud latency and a hard
network dependency. We accept the tier split rather than build and maintain a
native Windows Companion — but we refuse to let the split excuse a flimsy
Option B. The credential rule's per-session auth friction is accepted in full
against the cost of Boolean ever holding an Anthropic key.
