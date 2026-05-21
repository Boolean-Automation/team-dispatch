-- migration 0006: reassignment one-pending-per-ticket
--
-- Adds a DB-level partial unique index that prevents concurrent-pending
-- reassignments for the same ticket under READ COMMITTED isolation.
-- The SELECT-then-INSERT in the service is a fast-path early error;
-- this index is the structural correctness guarantee (P2-A).
--
-- Clean up any duplicate pending rows first (should be zero in practice
-- because the service-level guard was present, but run defensively):
DELETE FROM reassignments r1
  USING reassignments r2
  WHERE r1.id > r2.id
    AND r1.ticket_id = r2.ticket_id
    AND r1.status = 'pending'
    AND r2.status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS "reassignments_one_pending_per_ticket"
  ON "reassignments" ("ticket_id")
  WHERE "status" = 'pending';
