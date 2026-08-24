-- Phase C: client rules-acknowledgment record. Run against the
-- pcm_clients database (pcm_clients and pcm_rules_content both live
-- there, so client_id and rule_type below are real foreign keys).
--
-- Clients have no login -- Todd's decision is that staff RECORD that a
-- client acknowledged, not that a client clicked something themselves.
-- Following pcm_ofac_results' pattern: structured fields, a recorded
-- principal, a recorded timestamp -- not a flag that gets overwritten.
--
-- pcm_rules_content has three independent rows (kyc_instructions,
-- pof_instructions, rules_of_the_road), each separately versioned -- an
-- acknowledgment is per rule_type, not one blanket "agreed to the
-- rules" event. One row per (client_id, rule_type) acknowledgment.
--
-- HOW OBTAINED, not just THAT: acknowledgment_method + method_reference
-- mirror the counsel_name/review_date/reference shape that made the
-- (now-removed) legal attestation meaningful -- a staff assertion alone
-- ("I recorded that they agreed") isn't evidence; the record needs to
-- show what the assertion is based on. acknowledgment_method is
-- constrained to the known channels this actually happens through
-- ('other' as an explicit escape hatch, not a silent default).
-- method_reference is nullable -- a verbal acknowledgment may have
-- nothing to point to beyond the staff principal's own account.
--
-- rules_version is a POINT-IN-TIME SNAPSHOT of which version of that
-- rule_type's content was shown/agreed to -- not a live pointer.
-- pcm_rules_content currently has no append-only history (REMAINING-
-- WORK-QUEUE.md, Phase D's flagged gap): if a row's content is edited
-- in place, this table will correctly show WHICH version number a
-- client agreed to, but the actual text of that version is not
-- recoverable once overwritten. That gap belongs to pcm_rules_content's
-- own missing history, not to this table -- but it directly limits what
-- this table can prove until it's fixed. Written here so whoever
-- eventually builds the append-only history sees the dependency.
CREATE TABLE IF NOT EXISTS pcm_rules_acknowledgments (
  acknowledgment_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL REFERENCES pcm_clients(client_id) ON DELETE RESTRICT,
  rule_type            text NOT NULL REFERENCES pcm_rules_content(rule_type),
  rules_version        integer NOT NULL,
  acknowledgment_method text NOT NULL
    CHECK (acknowledgment_method = ANY (ARRAY['signed_document', 'email_confirmation', 'verbal', 'other'])),
  method_reference      text,
  recorded_by          text NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcm_rules_acknowledgments_client
  ON pcm_rules_acknowledgments (client_id);

GRANT SELECT, INSERT ON pcm_rules_acknowledgments TO pcm_app;
