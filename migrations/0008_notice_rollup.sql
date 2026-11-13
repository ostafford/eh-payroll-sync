-- Migration 0008: notice_rollup, behind the Bulk summary (#193, ADR-0013).
--
-- One row per person per notice kind ('existing_match' or 'link'): when their
-- latest Existing-match or Link notice was sent or rolled up. The queue consumer counts
-- recent rows to tell a burst; rolled_up = 1 means the person waits for the
-- cron's Bulk summary instead of a message of their own. summary_at is the
-- summary they were picked for, so a tick that crashed mid-summary never
-- counts them twice. Identifiers and times only, never a value (ADR-0001).

CREATE TABLE notice_rollup (
  kind        TEXT    NOT NULL,
  ct_user_id  INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  rolled_up   INTEGER NOT NULL DEFAULT 0,
  summary_at  INTEGER,
  PRIMARY KEY (kind, ct_user_id)
);

CREATE INDEX idx_notice_rollup_kind_at ON notice_rollup (kind, at);
