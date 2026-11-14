# Linking rehearsal checklist

The gate before any client links: no client runs `./scripts/setup-wizard.sh --stage link`
until every scenario below passes on the **Rehearsal deployment** (ADR-0006).
Decided in [#145](https://github.com/ostafford/eh-payroll-sync/issues/145); a
client whose Payroll IDs come from a Connecteam field (ADR-0011) is gated on
the Payroll ID path alone (part B).

Tick it off on every run. It rehearses the live-rollout path in the RUNBOOK
("Rolling out linking on a live deployment"), so follow that section's
commands exactly: a step that doesn't work as written is a RUNBOOK bug too.

**A failure** is fixed on a short-lived branch and merged by PR. Then re-run
the failed scenario and everything after it. Re-run the rollout steps only if
the fix touched them. File an issue for anything found, even once fixed.

**Proving "only the Payroll ID changed"** is the EH before/after diff:
`npm run eh-diff -- snapshot <EH id>...` before, `npm run eh-diff -- diff`
after. It prints field names only, never values, and exits `2` when anything
beyond `externalId` changed.

## Before you start

- [ ] The rehearsal deployment is on the last commit before linking
      (`d3082b9`, 2026-11-05), so the update in scenario 1 is the real one.
- [ ] Every fixture below exists, and every approval is still held (not approved)
      except F7's.
- [ ] Nobody else is using the rehearsal accounts during the run.

## Fixtures

Invented people only, with checksum-valid fake TFNs: the Pre-create check
skips ATO placeholder TFNs. Enter the EH side by hand in EH's UI. Note each
fixture's Connecteam user id and EH employee id on your own copy, not here.

| # | Fixture | EH side | Connecteam side |
|---|---|---|---|
| F1 (+F1b–d) | Linkable | full record; address and phone deliberately different from the pack | completed pack, same email and names |
| F2 | Ambiguous | two plausible records (same names, one shares the email) | completed pack |
| F3 | Near-miss | record with a matching TFN but a different email | pack, not on the Link list |
| F4 | Terminated rehire | terminated record, same name + date of birth | pack, not on the Link list |
| F5 | Plain new hire | none | pack |
| F6 | EH-only | record | none |
| F7 | Approved but never synced | record | approved before the update, while the queue is paused |
| F8 | Can't link: already linked to someone else | record carrying another Connecteam user's Payroll ID | pack with a matching email |

## Part A: the Link list path

Each scenario's expected result is what passes. Anything else fails it.

1. **Rollout.** Pause the queue, approve F7, then follow the RUNBOOK's rollout
   steps: `./scripts/update.sh` → `./scripts/setup-wizard.sh --stage link`.
   Save the Link list, then resume the queue.
   - [ ] `update.sh` says it put `BASELINE_KEY` (a new one, kept in `.dev.vars`)
         and ends with `✓ update complete`.
   - [ ] F1 (and F1b–d) are suggested; F2 needs a choice; F6 isn't listed;
         F8 shows "Can't link: already linked to someone else".
   - [ ] F7 is linked within a minute or two of resuming, with no profile edit.
2. **Canary.** `npm run eh-diff -- snapshot` F1–F1d's EH ids, approve them,
   wait for the sync, then `npm run eh-diff -- diff`.
   - [ ] The diff exits `0`: `externalId set` and nothing else for each.
   - [ ] The first 3 get a Link notice each; the 4th is counted in one
         Bulk summary about 3 minutes later (ADR-0013). No employee DMs.
   - [ ] `GET /status` shows each `ready` with `linked: true`.
3. **Changed units.** Snapshot F1 again. F1 edits their phone and bank account.
   - [ ] The diff names only the phone and bank fields; F1's differing EH
         address is untouched.
4. **No-op.** F1 re-saves their profile without changing anything.
   - [ ] Nothing is written (diff shows no new change) and no message is sent.
5. **Cleared field.** F1 blanks a synced field.
   - [ ] Nothing is sent to EH, and one admin notice names the cleared field.
   - [ ] F1's next unrelated edit doesn't repeat that notice.
6. **Held, then linked.** Snapshot F3's EH record. Approve F3.
   - [ ] F3 is held: one Existing-match notice, `ops.held` goes up by 1, and
         `GET /status` shows `waiting_on_admin` "held on approval…".
   - [ ] In `--stage link`, F3 is under To review; link them and save.
   - [ ] After F3's next profile edit (or the daily recheck), they're linked
         and the diff shows only `externalId` changed.
7. **"New hire, not this person".** Snapshot F4's terminated EH record. Approve F4.
   - [ ] F4 is held, and the notice says "Terminated in EH".
   - [ ] In `--stage link`, mark F4 "New hire, not this person" and save.
   - [ ] After F4's next profile edit (or the daily recheck), a new EH employee
         is created, and the diff of the terminated record shows no changes.
8. **Plain new hire.** Approve F5.
   - [ ] A full create (`matchType=None`) and the normal Success message and
         Admin success notice.
9. **Release everyone.** Approve every remaining fixture pack.
   - [ ] `/health`: `ops.pendingLinks` and `ops.held` are `0`, `ops.queueBacklog`
         drains to `0`, `ops.linked` matches the links made.
10. **Undo a link.** Follow the RUNBOOK's "Undoing a link by hand" on F1b.
    - [ ] Re-running the link stage relinks F1b, and no full sync runs
          (snapshot first; the diff shows only `externalId`).
11. **Lost baseline key.** Put a new `BASELINE_KEY` (RUNBOOK "Rotating keys").
    - [ ] F1's next edit re-baselines them with nothing sent, and the alerts
          channel gets one line about the key, once for everyone.
    - [ ] F1's edit after that pushes only the unit they changed.

## Part B: the Payroll ID field path (ADR-0011)

Run with `identity.externalIdFrom: { "customFieldId": <id> }` set in
`clients/self/field-map.json`, the field being a Connecteam **text** field
holding each fixture's EH Payroll ID. Follow the RUNBOOK rollout's "Payroll IDs
from a Connecteam field" steps.

1. **Copied ID matches and a key agrees.**
   - [ ] Linked, with no EH write: the diff exits `0` with no changes at all.
2. **Copied ID has a typo** (the person is in EH by TFN or email).
   - [ ] Held, and the notice says "Their Payroll ID in Connecteam isn't in EH; check it for a typo."
3. **Same ID on two Connecteam users.**
   - [ ] `npm run preflight` flags it, and the second one can't link.
4. **Blank ID for someone in EH whose record has a Payroll ID.**
   - [ ] Held, and the notice says "Copy their EH Payroll ID into **‹field›** in Connecteam."
5. **ID edited in Connecteam after the link.**
   - [ ] One admin alert; the stored key keeps working and nobody is re-keyed.

## Cleanup

- [ ] Keep the deployment and the new `BASELINE_KEY` (back up `.dev.vars`).
- [ ] Delete every fixture in EH (including F4's new record and F2's spare) and in Connecteam.
- [ ] Delete their `employee_map`, `pending_link` and `sync_log` rows in D1
      (`npx wrangler d1 execute eh-payroll-sync --remote --config wrangler.deploy.json --command "DELETE FROM … WHERE ct_user_id IN (…)"`).
- [ ] Delete `eh-snapshot.json`: it holds the fixtures' full EH records.
- [ ] Log the run below.

## Run log

Date, path, pass/fail per scenario, issues filed. No names, ids or values.

| Date | Path | Result | Issues filed |
|---|---|---|---|
| | | | |
