-- Migration 0009: pending_link.baseline (#230, ADR-0014).
--
-- The Baseline taken when the admin confirms the pair in the link stage, so
-- every change after it reaches EH at the link. JSON of a key id plus one
-- keyed fingerprint per unit, never a value (ADR-0001, ADR-0009). NULL for a
-- pair confirmed before this (it takes its Baseline at the link, as before)
-- and for "New hire, not this person".

ALTER TABLE pending_link ADD COLUMN baseline TEXT;
