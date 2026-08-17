-- trade_group_owner -> administrator rename.
--
-- NOT purely additive, deliberately kept in its own migration file
-- separate from 0011: existing rows are updated immediately (this IS the
-- source of truth going forward), which means any code still checking
-- for the literal string 'trade_group_owner' (old authorize() calls, the
-- old pipeline.js hierarchy) stops recognizing Todd/Al as administrators
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

UPDATE pcm_staff SET role = 'administrator' WHERE role = 'trade_group_owner';

ALTER TABLE pcm_staff DROP CONSTRAINT pcm_staff_role_check;
ALTER TABLE pcm_staff ADD CONSTRAINT pcm_staff_role_check
  CHECK (role = ANY (ARRAY['administrator'::text, 'program_manager'::text, 'intake_officer'::text]));
