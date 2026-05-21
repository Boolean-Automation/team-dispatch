-- dispatch — slack_outbox migration
-- Slice 5: durable pre-send buffer for the OQ-4 / §5 undo window (FIX 6).
--
-- The outbox_status enum was created in 0000_init.sql — do NOT re-create it.
-- This migration only creates the slack_outbox table and its indexes.

-- ── slack_outbox ──────────────────────────────────────────────────────────────
--
-- A durable outbox row is inserted (status = 'pending') when the SE presses
-- Send. An undo within the 10s window marks it 'canceled'. The outbox worker
-- polls 'pending' rows past scheduled_at and moves them to 'sent' or 'failed'.
-- The idempotency_key + status transition guard prevent a double post if the
-- worker restarts mid-send.

CREATE TABLE "slack_outbox" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"        UUID NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "message_id"       UUID NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "idempotency_key"  TEXT NOT NULL UNIQUE,
  "channel_id"       TEXT NOT NULL,
  "payload"          JSONB NOT NULL,
  "status"           "outbox_status" NOT NULL DEFAULT 'pending',
  "scheduled_at"     TIMESTAMPTZ NOT NULL,
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "last_error"       TEXT,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "sent_at"          TIMESTAMPTZ
);

CREATE INDEX "slack_outbox_status_scheduled_idx"
  ON "slack_outbox" ("status", "scheduled_at")
  WHERE "status" = 'pending';

CREATE INDEX "slack_outbox_message_idx"
  ON "slack_outbox" ("message_id");
