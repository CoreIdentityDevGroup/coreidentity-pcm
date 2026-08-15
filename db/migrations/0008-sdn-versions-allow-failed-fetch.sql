-- Follow-up to 0006, caught while writing the ingestion script (not yet
-- built when 0006 was applied): pcm_sdn_list_versions.publish_date was
-- NOT NULL, but a failed fetch attempt (network error, parse error) has
-- no real publish_date to record -- inventing one would misrepresent what
-- happened. The design doc requires every fetch attempt to be recorded,
-- success or failure, so a silently broken ingestion job is visible
-- rather than just going quiet; that requires failure rows to exist at
-- all without a fabricated date.
--
-- Relax the column, add a CHECK instead: a 'success' row must still have
-- a real publish_date (unchanged guarantee for the freshness gate, which
-- only ever reads successful rows); a 'failed' row may have NULL.

ALTER TABLE pcm_sdn_list_versions ALTER COLUMN publish_date DROP NOT NULL;

ALTER TABLE pcm_sdn_list_versions
  ADD CONSTRAINT publish_date_required_on_success
  CHECK (fetch_status = 'failed' OR publish_date IS NOT NULL);
