-- POF verification becomes recorded, not performed (2026-08-17, Todd's
-- third correction to Intake Officer scope). Legal now performs proof-of-
-- funds verification as part of the same official review that produces
-- the legal attestation -- there is no separate Program-Manager-performed
-- POF determination anymore. This migration adds the fields needed to
-- RECORD that outcome, on pcm_pof_records, not pcm_legal_attestations.
--
-- Deliberately NOT folded into pcm_legal_attestations (Option A,
-- considered and rejected): pcm_legal_attestations is asset-scoped
-- (0013a/0013b -- assignment is by asset type), but POF is client-scoped
-- -- a client's proof of funds isn't per-asset. Folding them would mean
-- either duplicating the same POF verification across every asset a
-- client holds (real risk: the same POF document showing "verified" on
-- one asset's attestation and not on another), or making
-- pcm_legal_attestations client-scoped too, undoing the deliberate
-- asset-scope decision 0013a/0013b already made. Extending
-- pcm_pof_records in place keeps POF attached to the thing it's actually
-- about.
--
-- attestation_id links this POF outcome to the specific legal-attestation
-- review event that produced it -- a REAL foreign key (both tables live
-- in the pcm_clients database, unlike pcm_assets' asset_id references
-- elsewhere in this migration set, which are cross-database and can't be
-- real FKs). This is provenance ("which review actually decided this"),
-- not a re-verification requirement -- once a client's POF outcome is
-- recorded and its linked attestation is countersigned, that outcome
-- satisfies GATE_REQUIREMENTS.kyc_verification for every asset that
-- client holds, not just the one whose review produced it. Re-verifying
-- the same POF document per asset would be exactly the duplication this
-- design avoids.
--
-- No separate countersigned_by/countersigned_at pair here, deliberately
-- (Todd, explicit): "Legal performs POF verification as part of the same
-- official review that produces the approval, so it is one review event.
-- A second countersign on the same underlying review is redundant dual
-- control, and redundant controls degrade into rubber-stamping." The
-- confirmation that matters is the linked attestation's own countersign
-- -- GATE_REQUIREMENTS.kyc_verification checks pcm_pof_records.outcome
-- together with pcm_legal_attestations.status via the attestation_id
-- join, not a second independent confirmation step on this table.
--
-- outcome reuses the 'approved'/'denied' vocabulary already established
-- on pcm_legal_attestations.outcome (0015), for consistency -- same
-- binary, no conditions, no default: a regulatory decision must be
-- stated explicitly, never inferred.
ALTER TABLE pcm_pof_records
  ADD COLUMN outcome text
    CHECK (outcome IS NULL OR outcome = ANY (ARRAY['approved', 'denied'])),
  ADD COLUMN entered_by text,
  ADD COLUMN entered_at timestamptz,
  ADD COLUMN attestation_id uuid REFERENCES pcm_legal_attestations(attestation_id);

-- Old verified/verified_at/verified_by/verification_notes columns
-- (migration predates this branch) are left in place, not dropped or
-- backfilled -- they're the record of the old Program-Manager-performed
-- model for whatever POF records already went through it, and dropping
-- them would destroy that history. New code stops writing to them; it
-- writes outcome/entered_by/entered_at/attestation_id instead. Historical
-- rows with verified=true and outcome=NULL are pre-this-model records,
-- not broken data.
