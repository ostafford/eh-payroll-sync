# Linked employees sync only what changed since their baseline, permanently

## Status

accepted

## Context

A **Pre-existing employee** was entered and paid in EH by hand before go-live. Their Connecteam onboarding pack was filled in around the same time, but since then the client has kept EH up to date, not the pack. A normal sync sends the whole mapped profile on every edit, and EH's unstructured endpoint keeps only what it's sent. So the first sync after approval would overwrite months of hand-kept EH data with the pack's old values, and a TFN merge means it happens silently (#131, #135).

We considered three options:

- **Full sync after the link.** Simple, but it's the overwrite this whole effort exists to prevent.
- **Per-field ownership** (EH owns some fields permanently, Connecteam owns the rest). Out of scope for this effort: it's a choice about every employee, not just pre-existing ones.
- **Diff against a baseline.** Send only what the employee actually changed in Connecteam after the link. Chosen.

## Decision

Once a Pre-existing employee is linked (their first approval sets only the Payroll ID), they're a **Linked employee** for good. Every later sync sends only the **units** whose Connecteam value differs from their **Baseline**. They never go back to a full-profile sync, and v1 has no unlink.

- **Units.** A unit is a single field, or a group EH needs sent whole (#135): bank account 1, residential address, emergency contact 1, super, tax declaration, the pay-run set. A change to any value in a group sends the whole group.
- **Baseline.** One fingerprint per unit, taken at the first approval. Fingerprints are HMAC-SHA-256 with a Worker secret and never values (ADR-0001): an unkeyed hash of a 9-digit TFN can be brute-forced. They're stored on `employee_map` (`baseline`: unit → fingerprint plus the key id; `linked_at` marks the row as linked).
- **Moving forward.** A unit's fingerprint updates only after EH accepts the write that carried it. On a Correction it keeps the old one, so the next edit sends it again. Units that weren't sent don't change.
- **Never pushing stale data by accident.** Each of these is recorded in the baseline **without being sent**:
  - a baseline made with a different key id (a rotated or lost secret), with one admin-channel line;
  - a unit the baseline doesn't have yet (a field added to the field map later).
- **Clearing.** A unit that changed from a value to blank (or a group that's now partly blank) isn't sent, because nothing clears an EH field safely (#135). The admin gets one follow-up to clear it by hand, and the baseline moves.
- **Scope of checks.** Mapping issues count only inside changed units. Read-back compares only the units that were sent. Constants are never sent. The pay-run set is sent only when the Connecteam pay rate changes, worked out against EH's current record as #102 does.
- **Order.** `last_payload_hash` still skips identical bursts first. If the hash differs but no unit does, the sync ends as skipped ("no change since the link") and stores the new hash.

## Consequences

- EH is the source of truth for a Linked employee, apart from what they change in Connecteam afterwards. A wrong value in EH stays wrong until someone edits that field in Connecteam or fixes it in EH.
- Losing the baseline secret doesn't overwrite anyone, but every Linked employee is re-baselined against their current pack. Edits made in Connecteam since their last accepted sync, and not yet pushed, are absorbed into the new baseline and not sent.
- Undoing a link is a manual D1 fix, documented in the RUNBOOK.
