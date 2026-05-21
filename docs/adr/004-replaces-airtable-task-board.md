# ADR-004 — dispatch replaces the Airtable task board for client work

**Status:** accepted (`/grill` 2026-05-20)

## Context

An in-flight Boolean project was making the internal Boolean Tasks Airtable base
(`appjOw5JCzSpC6hqI`) the task source of truth, with `/mytask` and `/createtask`
as the velocity layer. dispatch creates a task per client message, which collides
with that project.

## Decision

dispatch is the system of record for **client-support work**. The Ticket is the
unit. A Ticket is born from a client message or created by hand. The Airtable
task board is retired for client-support work.

Non-client / internal task management (build work, ops to-dos) is **explicitly
out of dispatch's scope** and is unaffected — it stays wherever it currently
lives.

## Consequences

- `/mytask` and `/createtask` against the Airtable client-task surface are
  superseded by dispatch.
- The boundary is clear: client work in dispatch, internal work elsewhere. A
  Ticket always has, or can have, an Account.
- The per-client economics rollup (playbook §9.4) instruments on the Ticket's
  effort bucket tag.

## Tradeoff

A second migration of the task surface, against ending the split-brain of "tasks
in Airtable, client conversations in Slack." Consolidation onto the message that
generated the work is the point of the build.
