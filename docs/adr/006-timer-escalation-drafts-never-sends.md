# ADR-006 — Timer escalation drafts, never sends

**Status:** accepted (`/grill` 2026-05-20)

## Context

The Ticket status ladder advances on business-hours timers: 2 business days of
client silence triggers `Follow-up Required`, 3 more triggers `Closeout Follow-up
Required`. dispatch generates follow-up and closeout messages so SEs are not
writing them from scratch.

## Decision

Timers move Ticket **status** and **pre-draft** the follow-up or closeout
message. Timers never **send** to a client. Every client-facing send is pressed
by a human SE.

(V2 may allow an authorized Boolean agent to send; V1 does not.)

## Consequences

- A guardrail against an automated, unreviewed message reaching a client.
- The pre-drafted message uses two slot types: registry merge fields
  (`{{first_name}}`) and AI-generated fields (`{{recap}}`, written by reading the
  Ticket thread).
- The escalation cadence applies to ordinary `Waiting on Client` Tickets. A live
  P1 never sits on the lazy ladder.

## Tradeoff

A small loss of automation convenience, against the cost of one wrong automated
message to a client. Client-comms safety wins.
