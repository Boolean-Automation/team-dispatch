-- dispatch — effort_bucket CHECK constraint migration
-- Slice 7: forbids a ticket reaching 'closed' or 'complete' with a null
-- effort_bucket (spec §3.4, A7). The service-layer guard in ticket-service.ts
-- rejects such transitions before they reach the DB; this constraint is the
-- defence-in-depth backstop.
--
-- The constraint reads: either the status is NOT 'closed'/'complete', OR
-- effort_bucket must be non-NULL. Existing rows are valid (0 violators confirmed
-- before applying — see slice-7 verification notes).

ALTER TABLE "tickets"
  ADD CONSTRAINT "tickets_effort_bucket_required_on_close"
  CHECK (
    "status" NOT IN ('closed', 'complete') OR "effort_bucket" IS NOT NULL
  );
