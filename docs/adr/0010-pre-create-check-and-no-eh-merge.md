# Every create runs our Pre-create check and turns off EH's merge

## Status

accepted

## Context

EH's unstructured create silently **merges** into an existing employee when the TFN matches, or when name + date of birth + email all match. It overwrites that record with what we send and says nothing (#131, #135). A client who entered people in EH by hand before go-live would lose those records the moment the person is approved in Connecteam. Our collision guard only notices *after* the write, and only when the merged record was already linked to someone else.

We considered three options:

- **Trust EH's merge.** It's silent and can't be undone, and the client would never know.
- **Our own check, with EH's merge left on.** A miss (a typo in one key, or an employee the filter doesn't return) still overwrites silently.
- **Our own check, with EH's merge turned off** (`?matchType=None`). Chosen. A miss becomes a visible duplicate, which an admin can clean up.

## Decision

Before every create, for every client, with no config switch, the sync runs the **Pre-create check**: up to three filtered `GET /employee/unstructured` calls, one after another. Any one of these is a hit:

- **email** matches (case-insensitive);
- **TFN** matches (ATO placeholder TFNs are skipped);
- **first name + surname + date of birth** all match. A name alone isn't a hit.

These are EH's own merge keys, made looser on purpose so a hand-entered record with one typo is still caught. Terminated employees count as a hit, flagged as terminated.

- **On a hit:** nothing is written. The person becomes a **Held employee** (`existing_match` on `employee_map`, no EH id; a `sync_log` row). The admin gets one claimed **Existing-match notice** listing every candidate and which keys matched or disagreed, never the values. The employee gets nothing.
- **When clear:** the create goes out with `matchType=None`, so EH can never merge. The after-write collision guard stays as a backstop.
- **Resolving a hit:** the admin re-runs the wizard's link stage. They either link the Held employee to a candidate, or confirm "New hire, not this person" (a link-list row with no EH id, which lets the create go ahead). The daily recheck enqueues the person afterwards, and a profile edit does it immediately.

## Consequences

- Each new hire costs up to three extra EH reads. Linked and already-synced employees cost nothing extra.
- If the check misses someone, we get a duplicate EH employee instead of a lost record. Duplicates are visible in EH and someone can clean them up.
- Whether EH's filters return terminated employees isn't known yet (#135 couldn't terminate anyone through the API). Until it's tested, a rehire may get past the check and create a duplicate, never a merge.
