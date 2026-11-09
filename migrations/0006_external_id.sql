-- Migration 0006: each employee's match key, fixed at their first sync (ADR-0011).
--
-- external_id is the Payroll ID (EH `externalId`) the sync first wrote or
-- linked for this person. Once set, every lookup, upsert and read-back uses
-- it, so a later edit to the Connecteam field it came from can't re-key them.
--
-- Backfill: until now the key was always the Connecteam userId, so a row EH
-- has accepted a write for (it has an EH id) was synced with its userId. A
-- row without one (a Held employee, someone never synced) stays NULL and
-- takes the mapped key at its first sync.

ALTER TABLE employee_map ADD COLUMN external_id TEXT;

UPDATE employee_map
SET external_id = CAST(ct_user_id AS TEXT)
WHERE external_id IS NULL AND eh_employee_id IS NOT NULL;
