-- dispatch — GIN index on accounts.slack_channel_ids
-- Slice A∪C — packet §Schema additions
--
-- Enables fast array-containment queries:
--   WHERE slack_channel_ids @> ARRAY['C0123...']::text[]
-- Used by the Stage 2 classifier (classifyChannel) to look up an account from
-- an incoming Slack channel ID in a single SQL hit.

CREATE INDEX IF NOT EXISTS accounts_slack_channel_ids_gin
  ON accounts USING GIN (slack_channel_ids);

COMMENT ON INDEX accounts_slack_channel_ids_gin IS
  'GIN index for @> containment queries. Stage 2 classifier (loadRegistryFromDb) '
  'uses WHERE slack_channel_ids @> ARRAY[channelId] to route inbound messages.';
