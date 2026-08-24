-- trade_group_owner -> facilitator rename.
--
-- NOT purely additive, deliberately kept in its own migration file
-- separate from 0011: existing rows are updated immediately (this IS the
-- source of truth going forward), which means any code still checking
-- for the literal string 'trade_group_owner' (old authorize() calls, the
-- old pipeline.js hierarchy) stops recognizing Todd/Al as facilitators
-- the moment this runs. This migration must be applied together with the
-- application deploy that ships api/middleware/authorize.js's
-- normalizeRole() alias, not ahead of it -- do not run this standalone.
--
-- The alias for pre-existing signed tokens that still carry the literal
-- string "trade_group_owner" (issued before this deploy, valid for up to
-- 8h) lives entirely in the application layer, not here -- a JWT's claims
-- can't be retroactively rewritten, so the bridge has to be at
-- authorization-check time. See authorize.js's header comment for the
-- removal condition/date.
--
-- Statement order below was originally UPDATE-then-constraint, which is
-- wrong: pcm_staff_role_check only permitted the old three role values,
-- so the UPDATE violated its own table's constraint before the ALTER
-- TABLE loosening it ever ran. Found live on first apply attempt
-- (2026-08-24, prod), nothing was applied since the UPDATE's failure
-- rolled back cleanly. Fix: loosen the constraint first, then write the
-- data. Confirmed safe to keep ALTER TYPE ... ADD VALUE in the same
-- transaction as the UPDATE on Postgres 15.17 (prod's version) -- the
-- post-PG12 restriction only blocks *using* a newly added enum value in
-- the transaction that added it, and nothing here does that (pcm_staff.role
-- is plain text, not the enum).

BEGIN;

ALTER TABLE pcm_staff DROP CONSTRAINT pcm_staff_role_check;
ALTER TABLE pcm_staff ADD CONSTRAINT pcm_staff_role_check
  CHECK (role = ANY (ARRAY['facilitator'::text, 'program_manager'::text, 'intake_officer'::text]));

UPDATE pcm_staff SET role = 'facilitator' WHERE role = 'trade_group_owner';

-- pcm_user_role: a SEPARATE role representation from pcm_staff.role
-- (text + CHECK, fixed above) -- a genuine Postgres ENUM type, used only
-- by pcm_client_pipeline_audit.transition_role (populated by
-- routes/clients.js's POST / and by
-- api/services/pipeline.js's advancePipeline() on every stage
-- transition, both writing req.user.role verbatim). Missed in this
-- migration's first pass -- found live, not by re-reading the schema,
-- when a real advancePipeline() call with a 'facilitator' token threw
-- `invalid input value for enum pcm_user_role: "facilitator"`.
-- ADD VALUE, not a drop-and-recreate of the type: 'trade_group_owner'
-- stays valid for the same alias-window duration as everywhere else
-- (a pre-rename token's literal role string still gets written here
-- verbatim, by design -- see pipeline.js's transition_role write, which
-- records what the caller's token actually said, not a normalized
-- value) -- remove it in the same follow-up as authorize.js's
-- ROLE_ALIAS once every pre-deploy token has expired.
ALTER TYPE pcm_user_role ADD VALUE IF NOT EXISTS 'facilitator';

COMMIT;
