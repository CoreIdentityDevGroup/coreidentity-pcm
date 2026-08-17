-- Legal-review attestation, modeled on the OFAC out-of-band attestation
-- shape (pcm_ofac_results' PENDING_ATTESTATION -> ATTESTATION_CONFIRMED
-- pattern), not inserted into that table -- different domain, same
-- two-step entry/countersign mechanic. Records that external counsel (no
-- portal account -- named by text, not a staff_id) reviewed and approved;
-- the platform never performs the review itself. Entered by an Intake
-- Officer, countersigned by a DIFFERENT principal (Administrator, per
-- this session's separation-of-duties decision) before it satisfies the
-- kyc_verification gate.
--
-- Purely additive -- safe to apply ahead of the code that uses it, same
-- as db/migrations/0010's password-reset table. Unlike the role-rename
-- migration (0012), nothing here changes behavior for anyone until the
-- routes/gate check that read it are deployed.
CREATE TABLE IF NOT EXISTS pcm_legal_attestations (
  attestation_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES pcm_clients(client_id) ON DELETE RESTRICT,
  counsel_name     text NOT NULL,
  review_date      date NOT NULL,
  reference        text NOT NULL,
  entered_by       text NOT NULL,
  entered_at       timestamptz NOT NULL DEFAULT now(),
  countersigned_by text,
  countersigned_at timestamptz,
  status           text NOT NULL DEFAULT 'pending_countersign'
    CHECK (status = ANY (ARRAY['pending_countersign', 'confirmed']))
);

CREATE INDEX IF NOT EXISTS idx_pcm_legal_attestations_client
  ON pcm_legal_attestations (client_id);

GRANT SELECT, INSERT, UPDATE ON pcm_legal_attestations TO pcm_app;
