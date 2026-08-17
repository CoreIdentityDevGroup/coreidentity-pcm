-- Legal returns a binary approval or denial, no conditions -- the
-- attestation records which. Run against the pcm_clients database
-- (pcm_legal_attestations lives there).
--
-- NOT NULL with no default: every attestation from this point forward
-- must state an outcome explicitly -- there is no sensible default
-- between approved/denied for a regulatory decision.
ALTER TABLE pcm_legal_attestations
  ADD COLUMN outcome text
    CHECK (outcome = ANY (ARRAY['approved', 'denied']));

ALTER TABLE pcm_legal_attestations ALTER COLUMN outcome SET NOT NULL;
