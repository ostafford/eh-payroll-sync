# A client's own Payroll IDs can be the match key, fixed at first sync

## Status

accepted

## Context

The sync used the Connecteam `userId` as every employee's **Payroll ID** (EH's `externalId`) and looked EH up by it. A client with ~180 **Pre-existing employees** had already copied each one's EH Payroll ID into a Connecteam field by hand (#165). For them, a link that wrote the `userId` would hit the "different Payroll ID" refusal (#150) for everyone, and overwriting would break IDs the client relies on.

We considered two options:

- **The copied ID only fills the link list.** It replaces fuzzy matching at setup. After that, the sync tracks them by the stored EH employee id and never touches EH's Payroll ID. Rejected: the lookup, read-back and collision paths all key on `externalId`, so these people would need a second identity path.
- **The copied ID becomes the Payroll ID.** Chosen. The sync has one key everywhere, and a link finds EH already holding it, so it writes nothing.

## Decision

- **Setting.** `identity.externalIdFrom` is `"userId"` (the default) or `{ customFieldId }`, which must be a Connecteam text field. The value is trimmed and matched exactly. Blank falls back to the `userId`, per person.
- **Linking by it.** On first approval, if the key finds exactly one EH employee, they're linked (#150's "already carries this Payroll ID" path, so no EH write), but only when at least one of the **Pre-create check**'s keys also agrees: email, TFN, or name + DOB (ADR-0010). Otherwise they're held. A typo'd ID that lands on another real employee would otherwise send later edits, bank details included, into the wrong pay record.
- **No match.** The key finds nobody, so the Pre-create check runs as for anyone else. On a hit, they're held (the notice suggests a typo). If clear, they're created with the copied ID as their Payroll ID.
- **Fixed at first sync.** `employee_map` stores the key used at the first successful sync or link, and the stored key wins from then on. A later edit, clear or new value in the Connecteam field never re-keys anyone: it raises one admin alert to change both systems by hand if intended. Rows that existed before this are backfilled with their `userId`.

## Consequences

- For a client using the setting, a Pre-existing employee whose EH record already has a Payroll ID can't be linked through the link list (that would overwrite it). The fix is to fill in their Connecteam field.
- Two Connecteam users given the same ID reach the existing collision paths ("linked in sync", "Payroll ID elsewhere"), and the read-only check before go-live lists them first.
