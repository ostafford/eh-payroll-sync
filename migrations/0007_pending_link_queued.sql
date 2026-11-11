-- Migration 0007: pending_link.queued_at (#155).
--
-- The sweep queues an approved, never-synced person who has a pending link
-- (e.g. after an old dead-letter) once per confirmed link: this marks when it
-- did. Re-confirming the link clears it, so the sweep queues them again. NULL
-- for every existing row, so each is queued once after this migration.

ALTER TABLE pending_link ADD COLUMN queued_at INTEGER;
