-- Platform submission tracking (2026-08-24, replaces legal attestation).
-- Run against the pcm_assets database.
--
-- CoreG is an intermediary: it collects and reviews documentation itself
-- (stages 1-7, supported by the governance agents). Once securitization
-- (stage 7) completes, the package is submitted to an external platform
-- -- a party with no portal login -- for its own review. Tokenization
-- (stage 8) only proceeds on the platform's approval. These two tables
-- record that handoff and its outcome for accountability, the same way
-- pcm_ofac_results records CoreG's own screening: structured fields, a
-- recorded principal, a recorded timestamp -- not free-text notes.
--
-- Same database as pcm_assets/pcm_bank_assignments/pcm_valuations
-- (asset-centric evidence), so asset_id and submission_id below are real
-- foreign keys, unlike the cross-database plain-uuid pattern
-- pcm_legal_attestations used to need for its own asset_id.
CREATE TABLE IF NOT EXISTS pcm_platform_submissions (
  submission_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES pcm_assets(asset_id) ON DELETE RESTRICT,
  submitted_by   text NOT NULL,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  -- Point-in-time snapshot of what the platform actually received, NOT a
  -- set of references to be resolved later -- if the underlying KYC
  -- documents, valuations, or agreements change or get superseded after
  -- submission, this column must still show what was sent, not what
  -- those tables currently say. Populated by the submission route
  -- (api/routes/assets.js) with the actual field values read at
  -- submission time, not just doc_id/valuation_id pointers.
  manifest       jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pcm_platform_submissions_asset
  ON pcm_platform_submissions (asset_id);

-- One response per submission -- APPROVED or DENIED, no conditions,
-- same binary-no-default discipline the removed legal-attestation
-- outcome used (a regulatory-adjacent decision must be stated
-- explicitly, never inferred). Uppercase vocabulary, matching
-- pcm_ofac_results.review_outcome's existing style
-- (MANUAL_OVERRIDE_CONFIRMED, ATTESTATION_CONFIRMED), not the lowercase
-- approved/denied the deleted pcm_legal_attestations table used.
--
-- No countersign / dual control here, deliberately: the platform itself
-- is the second party to this decision. A single CoreG principal records
-- what the platform said; that's not a claim requiring internal
-- corroboration the way an out-of-band attestation was.
CREATE TABLE IF NOT EXISTS pcm_platform_responses (
  response_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES pcm_platform_submissions(submission_id) ON DELETE RESTRICT,
  decision       text NOT NULL CHECK (decision = ANY (ARRAY['APPROVED', 'DENIED'])),
  recorded_by    text NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcm_platform_responses_submission
  ON pcm_platform_responses (submission_id);

GRANT SELECT, INSERT ON pcm_platform_submissions TO pcm_app;
GRANT SELECT, INSERT ON pcm_platform_responses TO pcm_app;
