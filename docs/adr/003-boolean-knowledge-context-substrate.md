# ADR-003 — boolean-knowledge is the client-context substrate

**Status:** accepted (`/grill` 2026-05-20)

## Context

dispatch and its embedded Claude window need client knowledge: how a client's
systems work, prior issues, conventions. Airtable is no longer where Boolean
maintains client data. The `boolean-knowledge` repo is.

A naive design would build a retrieval layer (vector store, embeddings, RAG) to
feed client context into the AI window.

## Decision

Client context is the `boolean-knowledge` repo, read directly. The embedded
window opens `claude` at the **repo root** so the orientation `CLAUDE.md` and the
whole knowledge base are in frame. The Companion injects the Ticket's Account as
opening context so the session knows which client it is on. Cross-client patterns
stay visible because the entire repo is readable.

No vector store, no embeddings, no RAG.

## Consequences

- "Auto-load SNL context" reduces to a working directory plus a context-injection
  prompt — no retrieval infrastructure to build or maintain.
- Every SE machine must keep `boolean-knowledge` cloned and synced. This is
  already true via the fleet bootstrap and the 2-minute launchd sync.
- dispatch needs a structured **client registry** derived from the repo (slug,
  domains, Slack channel IDs, owning SE).

## Tradeoff

A dependency on repo freshness and structure, against eliminating an entire
retrieval-infrastructure build. The repo is already the maintained source of
truth, so the dependency is one Boolean already owns.
