-- dispatch — accounts.highlights_synced_at
-- Slice A∪C — packet §Schema additions
--
-- Distinguishes operator edits (via PATCH /api/accounts/:id/highlights, which
-- sets updated_at) from script writes (sync-highlights-from-knowledge.ts, which
-- sets highlights_synced_at). The sync script skips rows where
-- updated_at > highlights_synced_at so operator overrides are preserved.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS highlights_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.highlights_synced_at IS
  'Set by sync-highlights-from-knowledge.ts when it last wrote highlights. '
  'NULL means not yet synced. Script skips rows where updated_at > highlights_synced_at '
  '(operator edit wins over script write).';
