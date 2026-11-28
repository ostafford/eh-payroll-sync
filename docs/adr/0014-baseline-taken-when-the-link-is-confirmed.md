# The Baseline is taken when the admin confirms the link, not at approval

## Status

accepted. Amends ADR-0009 (when the Baseline is first taken) and ADR-0013 (the Link summary's wording).

## Context

ADR-0009 took a Pre-existing employee's first **Baseline** at the link, from their Connecteam pack as it was at that moment. Anything they changed before then was absorbed into it and never sent. That covers the edit that triggers the link, and every edit made while the link was blocked. On the demo, the test person's postcode edit that triggered their link never reached EH (#217). On the live client, everyone held by a can't-link alert lost every edit they made while blocked (#214).

We considered three options (#220):

- **Take the Baseline when the admin confirms the pair in the link stage.** Chosen.
- **After linking, push the units that differ from EH's current record.** EH values the client trusts could then be overwritten by older Connecteam data.
- **List the differing fields in the Link notice for the admin to fix by hand.** Every person needs a hand fix, and nothing reaches EH by itself.

## Decision

- **At confirmation.** For each pair the admin confirms, the link stage maps the pack and compares it with EH's bulk-list record. It lists each **unit** that differs, by EH's on-screen label, never a value. A group is one choice, named with the fields in it that differ ("Residential address (Postcode)"); Use Connecteam's sends the whole group, as ADR-0009 sends groups. Each choice defaults to **Keep EH's**. The Baseline is taken then and stored on `pending_link.baseline`, a JSON of fingerprints like `employee_map.baseline`. A unit marked **Use Connecteam's** is recorded as blank at confirmation (known, with no fingerprint), so the link sends it.
- **The pay-run set is left out** of that Baseline. The link stage doesn't read pay rates, and EH's pay isn't in its bulk list to compare. At the link the pay-run set is new to the Baseline, so it's baselined without being sent, as before. A pay-rate change made while the link waited isn't sent.
- **At the link.** After the Payroll ID checks and write, the Link notice is claimed and sent. It names the units about to be sent: "Sent from Connecteam: Job title." `completeLink` then records them as Linked with the stored Baseline. The existing changed-units sync then runs as for any Linked employee's edit. It sends every unit changed since confirmation, posts the cleared-field follow-up, and baselines new units. Its own Correction, follow-up and success messages go out as configured.
- **A pair confirmed before this change** has no stored Baseline. It takes one at the link, as before. A re-run of the link stage with `BASELINE_KEY` gives every kept pair one, so the upgrade steps are to re-run the link stage for all waiting pairs.
- **The Link summary** (ADR-0013) now says that anything changed in Connecteam since the link was confirmed was sent, as well as the Payroll ID. Notices naming sent units roll up in a burst like a plain one, because a re-run for many stuck people would otherwise flood the channel.

### Side effects, and why each is safe to re-run (ADR-0007)

1. **The Payroll ID write**: unchanged. EH is checked first, so a retry that finds it there skips the write.
2. **The Link notice**: claimed before it's sent, as before, so a retry skips it. It's sent before `completeLink`, so a crash after it can't lose the link. Its claim is keyed by when the pair was confirmed as well as by person and EH employee, so a pair undone by hand and confirmed again still gets its own notice (found on the demo, 2026-11-28). The link's audit row names the units it goes on to send, by unit name only.
3. **`completeLink`**: one D1 batch, as before. With a stored Baseline it saves no payload hash and no event time, so a retry of the same job isn't stopped as identical or stale before the changed units are sent.
4. **The changed-units write**: an upsert keyed by the Payroll ID, so a re-send carries the same values. A retry after a crash or a failed write finds the person Linked, so it runs only this sync, against the stored Baseline, which moves only once EH accepts the write.
5. **The sync's messages**: claimed by payload hash, as for every Linked employee's sync.

## Consequences

- The edit that triggers a link, and every edit made while it was blocked, reaches EH at the link.
- Onboarding-pack entries made after confirmation are sent at the link too. That's accepted: they're newer data from the employee.
- If EH rejects a unit named in the Link notice, the notice still says it was sent. The Correction that follows says otherwise.
- A stored Baseline made with a different `BASELINE_KEY` from the Worker's (a link stage run with another `.dev.vars`) can't be compared, so the link treats it as none: the Baseline is taken at the link, as before, and their edits since confirmation aren't sent.
- The link stage reads whole EH records and packs (TFN and date of birth included) in memory to compare them. Only names and fingerprints are printed or written (ADR-0001).
- EH's on-screen labels are a table in `src/sync/labels.ts`. A field missing from it shows its API name until it's added.
- Each side is compared in the form EH's bulk list holds it in (#232), so a unit that differs only in format isn't listed. A detail that can't be compared reliably is left out rather than listed, so it keeps EH's, the default: a value that's an object or a list, a phone number `phoneAu` can't read, an overseas number against a local one, and a country code against a name other than Australia. `scripts/lib/link-details.ts` lists each case.
