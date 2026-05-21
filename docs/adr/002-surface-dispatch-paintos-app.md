# ADR-002 — Surface on dispatch.paintos.app

**Status:** accepted (operator call, `/grill` 2026-05-20)

## Context

Boolean's Frontend Platform Playbook routes internal multi-tenant SE tools to
`app.boolean.com`; `paintos.app` is the per-client tenant surface. The parked
internal-support-platform playbook (§3 Move 6) followed that rule and placed the
SE-facing UI on `app.boolean.com`.

The operator directed the tool to live at `dispatch.paintos.app`, where a
prototype already exists with its Railway + Cloudflare wiring in the
`team-dispatch` repo.

## Decision

dispatch lives at `dispatch.paintos.app`, overriding the FPP surface-split rule.

## Consequences

- One documented exception to the Frontend Platform Playbook.
- dispatch is a standalone subdomain app with its own Clerk auth. It is not
  routed *under* a client tenant, so the multi-tenant-routing concern the FPP
  guards against does not apply here.
- Reuses the existing `team-dispatch` Railway project and Cloudflare CNAME.

## Tradeoff

Consistency with a binding playbook, against reusing existing infrastructure and
honoring a direct operator call. The override is narrow and documented.
