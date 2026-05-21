# Ingestion Contract

## Guarantees

### Idempotency (hard guarantee)

`ingestMessage()` is idempotent on `(channelId, eventTs)`. Delivering the same event twice — a webhook retry, an operator double-submit, or the post-G1 socket replaying on redeploy — creates **exactly one** Ticket (for a top-level message) or **exactly one** Message (for a thread reply), never two.

This guarantee is **persisted**: the dedup key survives a process restart.

- Top-level messages: `tickets.source_channel_id` + `tickets.source_event_ts` carry a unique index. A duplicate event returns the existing Ticket id — it does not error and does not insert a new row.
- Thread replies: `messages.slack_ts` is the dedup key. A duplicate reply returns the existing Message id.

This guarantee holds regardless of which adapter (Slack webhook, stub feeder, future socket) delivered the event. The core owns idempotency — feeders are not required to be well-behaved.

### Source-agnostic interface

All adapters produce an `IngestionEvent` and call `ingestMessage()`. The Slack Events-API webhook and the stub feeder are fully interchangeable behind this contract. The post-G1 persistent socket (deferred to a later phase) drops in behind it unchanged.

## Best-effort only

### Message ordering

Phase 1 makes **no hard in-order delivery guarantee**. Events are processed in the order they arrive. Out-of-order delivery can occur under Slack retry pressure or on process restart.

### Orphan replies (graceful handling, not guaranteed ordering)

When a thread reply arrives before its parent top-level message has been ingested, `ingestMessage()`:

1. Logs the orphan condition (structured log entry with `channelId`, `eventTs`, `threadTs`).
2. Returns an `orphan-reply` result — does not error, does not crash.
3. Does **not** silently drop the reply.
4. Does **not** fabricate a parent Ticket.

The reply is lost in Phase 1 if the parent never arrives. A durable reordering buffer (store orphan replies and replay them when the parent is ingested) is **explicitly deferred** — not built in Phase 1. The G1 socket inherits this same contract unchanged: it benefits from real idempotency on `(channelId, eventTs)` but not from a hard ordering guarantee.

## Classification rules (spec §5.1)

| Origin | Action |
|---|---|
| Top-level message in a registered **client channel** | One Ticket on the matching Account (`origin_class = client`) |
| Top-level message in a registered **internal channel** | No Ticket created |
| Top-level message from an **unknown origin** | One Ticket, unassigned, `origin_class = unknown` |
| **Thread reply** (any origin) | One Message on the parent Ticket; no new Ticket |
| DM / group-DM author matching a **discovered Contact** | Ticket on Contact's Account (`origin_class = client`) |
| DM / group-DM author matching **no Contact** | Ticket, unassigned, `origin_class = unknown` |

Every client-facing message becomes a Ticket regardless of message type (loud classification — A12). A low-signal message creates a dismissable Ticket; it is never silently swallowed.

## Undo semantics

Every mutating call to `ingestMessage()` that creates a Ticket returns an `undoToken`. Posting the token to `POST /api/undo` reverses the creation. Undo is surfaced in the UI as a toast.
