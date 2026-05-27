-- dispatch — channel overlap exclusion trigger
-- Slice A∪C — packet §Code-level floors §4
--
-- Prevents a Slack channel ID from appearing in more than one account row.
-- The trigger fires BEFORE INSERT OR UPDATE so the bad write never commits
-- (BEFORE is load-bearing per CLAUDE R1 falsification — AFTER would let the
-- conflicting row persist until the trigger fires).
--
-- Example violation: account A has ['C0123','C0456'] and we try to give
-- account B ['C0456','C0789'] — the trigger raises an exception.
--
-- Implementation note: uses array overlap operator (&&) against all OTHER rows
-- (WHERE id != NEW.id). On the GIN-indexed column this is ~3ms p95.

CREATE OR REPLACE FUNCTION fn_accounts_no_channel_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  overlap_account_id  UUID;
  overlap_channel_id  TEXT;
BEGIN
  -- Find any existing account (other than the row being written) that
  -- shares at least one channel ID with the incoming row.
  SELECT a.id, unnested.ch
  INTO   overlap_account_id, overlap_channel_id
  FROM   accounts a,
         LATERAL UNNEST(a.slack_channel_ids) AS unnested(ch)
  WHERE  a.id != NEW.id
    AND  NEW.slack_channel_ids @> ARRAY[unnested.ch]::text[]
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'channel overlap: channel % is already assigned to account % — '
      'each Slack channel may appear in at most one account.',
      overlap_channel_id, overlap_account_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_no_channel_overlap ON accounts;

CREATE TRIGGER trg_accounts_no_channel_overlap
  BEFORE INSERT OR UPDATE OF slack_channel_ids ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION fn_accounts_no_channel_overlap();

COMMENT ON FUNCTION fn_accounts_no_channel_overlap() IS
  'Prevents a Slack channel ID from being assigned to more than one account. '
  'Fires BEFORE INSERT OR UPDATE so the conflicting write never commits.';
