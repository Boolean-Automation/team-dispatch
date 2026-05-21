-- dispatch — follow_up_1_sent migration (idempotent)
-- Slice 6 / FIX 4: follow_up_1_sent_at column + follow-up-1-sent enum value.
--
-- NOTE: Slice 3 (0000_init.sql) front-loaded both of these into the initial
-- schema intentionally, so this migration exists for migration-sequence
-- completeness only. Both statements are written idempotently so applying
-- this file to an already-migrated database is a safe no-op.
--
-- Postgres requires ALTER TYPE ... ADD VALUE outside a transaction block,
-- so these two statements are intentionally separated.

-- Add the column if it was somehow not created in 0000_init.sql.
-- (On a standard deployment this is already present — IF NOT EXISTS makes it safe.)
ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "follow_up_1_sent_at" TIMESTAMPTZ;

-- Extend the enum if the value is not already present.
-- IF NOT EXISTS was added in Postgres 9.3 and is available on Postgres 16.
ALTER TYPE "ticket_status"
  ADD VALUE IF NOT EXISTS 'follow-up-1-sent';
