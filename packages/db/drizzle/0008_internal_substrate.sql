-- dispatch — internal_channels + internal_users tables
-- Slice A∪C — packet §Schema additions
--
-- internal_channels: registered Slack channels that belong to Boolean's own
--   workspace (not client channels). Messages from these channels are classified
--   as origin_class='internal' and generate no Ticket.
--
-- internal_users: Clerk user ids for Boolean staff. Used by the internal-author
--   policy branch in ingest-message.ts: when a message arrives in a client
--   channel but the authorRef is found in this set, it is treated as an SE
--   reply rather than a client message.
--
-- Both tables are seeded by scripts, NOT by this migration (Clerk IDs must not
-- be hardcoded in SQL). See packages/db/src/scripts/seed-internal-users.ts.

-- ── internal_channels ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS internal_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  TEXT NOT NULL UNIQUE,
  label       TEXT,            -- human-readable name (e.g. "#boolean-internal")
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE internal_channels IS
  'Boolean-internal Slack channel IDs. Messages from these channels are '
  'classified origin_class=internal and generate no Ticket.';

-- ── internal_users ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS internal_users (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id  TEXT NOT NULL UNIQUE,  -- Clerk user id (e.g. user_2abc...)
  slack_id  TEXT,                  -- Slack user id (optional; used for author matching)
  label     TEXT,                  -- human-readable name ("Cody", "Chris", …)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE internal_users IS
  'Boolean staff Clerk user IDs. When ingest-message sees an authorRef in this '
  'set inside a client channel, INGESTION_INTERNAL_AUTHOR_POLICY governs '
  'routing (default: route-complete).';

CREATE INDEX IF NOT EXISTS internal_users_slack_id_idx
  ON internal_users (slack_id)
  WHERE slack_id IS NOT NULL;
