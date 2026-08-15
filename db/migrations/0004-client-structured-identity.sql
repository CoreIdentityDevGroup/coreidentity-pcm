-- SDN sanctions screening design (docs/SDN-Sanctions-Screening-Design.md),
-- intake changes section.
--
-- Adds structured given_name/family_name and date_of_birth to pcm_clients.
-- OFAC's SDN data carries firstName/lastName and dateOfBirthList structured
-- (confirmed live, UID 2674 "Abu ABBAS": <firstName>Abu</firstName>
-- <lastName>ABBAS</lastName>, <dateOfBirth>10 Dec 1948</dateOfBirth>) --
-- before this migration, intake only ever captured a single free-text
-- full_name string with no DOB at all, which is the single biggest weak
-- point named in the design doc's matching section. DOB is the strongest
-- disambiguator available for common-name collisions and OFAC provides it;
-- this migration is what makes it possible to eventually use it.
--
-- Nullable at the DB level, not NOT NULL: exactly one client exists in
-- production at the time of this migration (Allan Rivera, client_id
-- 6ba6021d-b96d-4ee1-9817-e5fe3dcf43ea, created 2026-08-12) and their real
-- date_of_birth is not known to this migration -- inventing one would be
-- fabricating production data, which is worse than leaving the column
-- null. given_name/family_name for this one row ARE backfilled below,
-- because they're a real, lossless derivation from the full_name already
-- on file (a plain space split of "Allan Rivera"), not an invention.
--
-- Required-ness for all NEW intake is enforced at the application layer
-- (api/routes/clients.js POST /, same pattern already used for
-- full_name/email/country_of_origin -- see the explicit `if (!x) return
-- 400` checks there, not a DB constraint), not via NOT NULL here. This
-- matches this codebase's existing convention rather than introducing a
-- new one.
--
-- Decision to do this now rather than defer: schema changes get
-- materially harder once real clients exist. With one test client, this
-- is nearly free.

ALTER TABLE pcm_clients ADD COLUMN IF NOT EXISTS given_name text;
ALTER TABLE pcm_clients ADD COLUMN IF NOT EXISTS family_name text;
ALTER TABLE pcm_clients ADD COLUMN IF NOT EXISTS date_of_birth date;

-- Backfill the one existing row -- real derivation from full_name on file,
-- not fabricated data. date_of_birth intentionally left NULL (unknown).
--
-- Discovered while applying this live: full_name is actually "Allan
-- Rivera " with a trailing space (confirmed via hex dump of the column --
-- 13 bytes, not 12), so an exact-string WHERE full_name = 'Allan Rivera'
-- matched zero rows on first attempt. Match on trim(full_name) instead --
-- itself a small, live demonstration of exactly the untrimmed-input
-- problem the SDN matching engine's normalization step has to handle.
UPDATE pcm_clients
SET given_name = 'Allan', family_name = 'Rivera'
WHERE client_id = '6ba6021d-b96d-4ee1-9817-e5fe3dcf43ea'
  AND trim(full_name) = 'Allan Rivera'
  AND given_name IS NULL;
