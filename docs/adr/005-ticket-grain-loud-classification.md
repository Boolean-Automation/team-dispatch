# ADR-005 — Ticket grain and loud classification

**Status:** accepted (`/grill` 2026-05-20)

## Context

dispatch ingests messages across 26 client channels, scaling toward 100. A
decision is needed on what becomes a Ticket and how aggressively to filter.

## Decision

**Grain:** one top-level client message = one Ticket. Thread replies attach to
the parent Ticket; they do not spawn new Tickets.

**Ingestion scope:** a Ticket is created from client channels, client DMs, and
group DMs containing a client. Never from internal team DMs, internal channels,
or internal group threads.

**Loud classification:** everything client-facing becomes a Ticket. AI labels
each Ticket's type (question, reply, thanks, OOO notice, etc.) for filtering and
sorting, but a low-signal label never suppresses Ticket creation. SEs dismiss
noise from the queue.

## Consequences

- Higher Ticket volume; the dashboard needs strong dismiss-noise and filter UX.
- A real client issue mis-classified as noise is the dangerous failure. Loud
  defaults against it: the cost of a dismissable "thanks" Ticket is trivial; the
  cost of a hidden client problem is not.
- The four-entity model is Ticket / Message / Account / Contact.

## Tradeoff

Queue noise, against missed client issues. Loud classification accepts the
cheaper error.
