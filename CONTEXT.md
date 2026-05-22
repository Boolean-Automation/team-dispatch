# CONTEXT — dispatch

Internal client-support work surface for Boolean Automations. Replaces the
Slack-scattered, Airtable-tracked support workflow with one place: every inbound
client message becomes a Ticket; SEs triage, discuss internally, reply, and
time-track in-app; an embedded terminal sits next to each ticket; admins get
KPI visibility. Lives at `dispatch.paintos.app`. Ships its own MCP.

dispatch makes **no AI claim** and holds **no Anthropic credential**. The
embedded surface is a genuine terminal running the SE's own shell — if an SE
wants Claude, they run `claude` in it themselves (see ADR-001 supersede /
ADR-007).

Origin: `/grill` session 2026-05-20, building on the parked
`operations/projects/internal-support-platform/` playbook in `boolean-knowledge`.
**This grill thread is canonical over that playbook wherever they conflict.**

The `team-dispatch` repo currently holds a single-file React/Firebase prototype
(`dispatch/index.html`). The production build is greenfield: keep the repo and its
Railway + Cloudflare wiring, keep the prototype as a visual reference for the
per-SE hours bar chart, rebuild the app with Clerk auth and a real backend.

---

## Glossary (ubiquitous language)

- **Ticket** — one unit of client work. Born from one top-level client message
  (Slack or email) OR created by hand. Thread replies attach to the parent
  Ticket; they do not spawn new Tickets.
- **Message** — a single inbound or outbound client-facing communication on a
  Ticket.
- **Internal Thread** — per-Ticket internal discussion, dispatch-native, never
  sent to the client. Where SEs talk through a client issue without forwarding
  client messages around Slack.
- **Account** — a client. Economics rollup lives here. Client knowledge lives in
  `boolean-knowledge/clients/<slug>/`.
- **Contact** — a person at a client. Auto-discovered from client-channel
  membership and email-domain resolution; not manually maintained.
- **Companion** — a lightweight process installed on each SE's machine. Hosts the
  embedded terminal by running the SE's own login shell (`$SHELL -l`) over a PTY.
  It spawns a shell, never `claude` directly; it holds no Anthropic credential.
- **Embedded Terminal** — an xterm.js terminal in the dispatch UI, wired to the
  Companion (or, on the parachute, to a Fly-Machines container). Runs a real
  login shell on the SE's machine. The SE runs whatever they want in it —
  including `claude`, which they launch and device-flow-auth as themselves. A
  per-SE configurable launcher (`claude` is the default) sets the first command.
- **Parachute** — Option B: a Fly-Machines server-side ephemeral container that
  is a second `TerminalTransport`. The host an SE drops into off their native
  machine, and the primary host for Windows SEs. Never pre-authed (ADR-007).
- **Reinforcement** — a collaborator added to a Ticket. They see it under "Shared
  Issues." Ownership does not change.
- **Reassignment** — a full handoff of Ticket ownership. Pending until the
  recipient accepts. Admin (Chris/Cody) reassignments land immediately.
- **Effort bucket** — mandatory tag on a Ticket's logged effort:
  `client-specific` / `platform-shared` / `one-time-build` (playbook §9.4).
  Capture is V1 and non-deferrable; untagged history is permanently lost.

### Ticket status ladder

`New` → `On You` (assigned, SE owes action) → `Waiting on Client` (a reply was
sent) → `Follow-up Required` (2 business days silent) → `Follow-up 1 Sent` →
`Closeout Follow-up Required` (3 more business days silent) → `Closed`.

- A client reply while `Waiting on Client` flips the Ticket to `On You`.
- A client reply on a `Closed` Ticket reopens it to `On You`.
- `Complete` is a manual promotion, separate from the timer ladder.

### Business hours

The SLA clock runs 6am–5pm PST, Monday–Friday. It pauses outside that window and
on weekends. Tracked metrics: **response time** and **resolution time**.

### Ingestion rule

A Ticket is created from a top-level message in: a client channel, a client DM,
or a group DM containing a client. Never from internal team DMs, internal
channels, or internal group threads. Email ingestion is restricted to registered
client domains. Classification is "loud" (see ADR-005).

---

## Decisions locked

See `docs/adr/` for the architecture decision records.

- ADR-001 — *superseded by ADR-007.* Original framing: AI delivery via local
  Companion. Kept as immutable history.
- ADR-002 — Surface on `dispatch.paintos.app` (documented FPP override).
- ADR-003 — `boolean-knowledge` is the client-context substrate (no Airtable, no RAG).
- ADR-004 — dispatch replaces the Airtable task board for client work.
- ADR-005 — Ticket grain + loud classification.
- ADR-006 — Timer escalation drafts, never sends.
- ADR-007 — Primary/Parachute execution model. Local Companion is the primary
  execution host; Option B (Fly-Machines container) is the parachute and the
  Windows primary. No Anthropic key in Boolean infra; SEs device-flow-auth
  `claude` themselves.

Also locked:
- Scope: the full vision is V1. Pilot users = Chris and Cody before SE rollout.
- Replies post as the SE who pressed send. V2 may let a Boolean agent send.
- Undo/back affordance on every mutating action.
- API-first / MCP-ready: dispatch ships a `dispatch` MCP as a thin wrapper over
  an HTTP core.

---

## Open gates (not yet decided — do not guess these)

- **G1 — runtime host** for the persistent Slack ingestion socket: IPP module vs
  standalone Railway service. 2-week spike (playbook §2). `[GATED]`
- **Companion spike** — PTY-over-WebSocket bridge feasibility. 3–5 day spike.
  Gates Phase 2 issue commitment.
- **Move 1 — cost** — real Pylon bill vs projected internal cost. dispatch
  carries **zero** Anthropic spend (no Boolean Console org; SEs run `claude` on
  their own auth). The Phase 3 parachute adds a Fly-Machines container bill.

---

## Out of scope (V1)

- Non-client / internal task management. dispatch tracks client work only;
  internal/build/ops tasks stay where they are.
- Customer-facing portal or knowledge base.
- Org chart + auto-assign to direct reports (V2).

---

## Build phases

Phase order. Each phase is a vertical slice; issues file per-phase.

- **Phase 1 — the spine.** *Shipped.* Slack ingestion → Tickets → unified
  dashboard → status ladder → in-app reply with Slack write-back. The
  replacement for the current workflow. Clerk auth, four-entity schema, client
  registry, routing, the `dispatch` MCP, undo-everywhere. A Claude Design pass
  on the unified dashboard sat between Phase 1 spec and dev.
- **Phase 2 — the embedded local terminal.** The local Companion runs `$SHELL
  -l` over a PTY; an xterm.js terminal on the WebGL renderer (Webgl / Search /
  WebLinks / Serialize / Unicode11 addons), VS-Code-grade rendering, JetBrains
  Mono with ligatures, 10k scrollback to IndexedDB, selection-aware copy/paste.
  Bottom-slide-up panel + dock-right toggle, ticket-scoped, drag-resize
  splitter, popout-to-window. A Settings → Terminal page exposes a per-SE
  configurable launcher (`claude` default) and four other controls. Multi-PTY
  data model built; renders as one terminal in v1. No AI claim, no Anthropic
  credential. Gated on the Companion spike.
- **Phase 3 — parachute + Windows.** Option B: a Fly-Machines server-side
  ephemeral container as a second `TerminalTransport` (`transport: 'remote'`).
  The host for off-machine work and the primary host for Windows SEs (no native
  Windows Companion is built). Same renderer, same strict env allowlist,
  never pre-authed — the SE device-flow-auths `claude` themselves per session
  (ADR-007).
- **Phase 4 — time + economics.** In-app clock in/out, billable toggle,
  clockout-description capture, Clockify API sync, the per-SE hours bar chart
  (1.5h default per Ticket, SE-adjustable), §9.4 per-client effort capture.
- **Phase 5 — admin KPIs.** Chris/Cody KPI tabs, response + resolution time,
  client health (formula owned by Norman), per-SE performance.
- **Cross-cutting** from Phase 1: the MCP, the notification center (reassign
  handshake + reinforcements + follow-up alerts), undo-everywhere, the per-Ticket
  internal thread.
- Email ingestion folds into the Phase 1 ingestion layer as a second source once
  Slack ingestion is proven.

> ADR-006 (timer escalation drafts, never sends) stays factually intact. With no
> AI drafting layer, escalation timers do two things only: advance Ticket status
> on the business-hours ladder and notify the owning SE. Any follow-up or
> closeout message is composed by the SE.
