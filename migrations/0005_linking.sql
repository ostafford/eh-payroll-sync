-- Migration 0005: storage for linking Pre-existing employees (ADR-0009, ADR-0010).
--
-- pending_link: the links the admin confirmed in the setup wizard's link stage,
-- waiting for that person's first approval. Identifiers only (ADR-0001), and a
-- table of its own so the full-sync path can never pick a row up as linked. A
-- NULL eh_employee_id is "New hire, not this person": the Pre-create check lets
-- that person's create go ahead.
--
-- employee_map.linked_at marks a Linked employee (set once, at the link).
-- employee_map.baseline is their Baseline: JSON of a key id plus one keyed
-- fingerprint per unit, never a value.

CREATE TABLE pending_link (
  ct_user_id     INTEGER PRIMARY KEY,
  eh_employee_id TEXT,
  confirmed_at   INTEGER NOT NULL
);

ALTER TABLE employee_map ADD COLUMN linked_at INTEGER;
ALTER TABLE employee_map ADD COLUMN baseline TEXT;
