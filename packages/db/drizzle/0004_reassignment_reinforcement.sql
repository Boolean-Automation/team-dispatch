-- dispatch — reassignments + reinforcements migration
-- Slice 7: creates the reassignment handshake table and the reinforcement
-- collaborator join table (spec §3.11, A26/A27).
--
-- The "reassignment_status" enum was created in 0000_init.sql — do NOT
-- re-create it here.

-- ── reassignments ─────────────────────────────────────────────────────────────
--
-- Holds the pending-handoff state for the reassignment handshake (A26).
-- While status = 'pending', tickets.assignee does NOT change.
-- On accept: status → 'accepted', tickets.assignee moves to recipient.
-- On reject: status → 'rejected', tickets.assignee unchanged.
-- Admin reassignments write status = 'accepted' directly (no pending phase).
-- Phase 1 has no auto-expiry.

CREATE TABLE "reassignments" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_id"    UUID NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "proposer"     TEXT NOT NULL,
  "recipient"    TEXT NOT NULL,
  "status"       "reassignment_status" NOT NULL DEFAULT 'pending',
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "resolved_at"  TIMESTAMPTZ
);

CREATE INDEX "reassignments_ticket_idx" ON "reassignments" ("ticket_id");
CREATE INDEX "reassignments_recipient_idx" ON "reassignments" ("recipient");

-- ── reinforcements ─────────────────────────────────────────────────────────────
--
-- Many-to-many: Ticket × collaborator (Clerk user id).
-- Adding a reinforcement puts the Ticket in the collaborator's Shared Issues
-- view without changing tickets.assignee (A27).

CREATE TABLE "reinforcements" (
  "ticket_id"    UUID NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "collaborator" TEXT NOT NULL,
  "added_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "reinforcements_pk"
  ON "reinforcements" ("ticket_id", "collaborator");

CREATE INDEX "reinforcements_collaborator_idx" ON "reinforcements" ("collaborator");
