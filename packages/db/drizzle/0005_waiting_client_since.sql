-- dispatch migration 0005 — add waiting_client_since_at to tickets
--
-- Stamped ONLY when a ticket transitions INTO 'waiting-client'.
-- Cleared (set to NULL) when the ticket transitions OUT of 'waiting-client'.
-- The SLA timer reads this instead of updated_at to measure the silence window
-- so that unrelated ticket mutations (effort-bucket sets, audit-only events)
-- do not silently reset the follow-up clock. (P2-3)
--
-- Idempotent: uses IF NOT EXISTS — safe to run multiple times.

ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "waiting_client_since_at" TIMESTAMPTZ;
