# Client setup walkthrough

What a client's setup call looks like with `scripts/setup-wizard.sh`, stage by
stage: what the client does, what they should see, and how long it takes.
Written from the rehearsals (ADR-0006, #73). `docs/RUNBOOK.md` has the
reference detail behind each stage.

## Before the call

The client needs, ready to sign in to:

- **A Cloudflare account on the Workers Paid plan** (~$5/month). The sync uses
  Queues, which the free plan doesn't include.
- **Connecteam admin access**, to create an API key with **read** on users and
  onboarding, **write** on chat, and **write on custom fields** (the wizard
  creates fields and the award dropdown).
- **Employment Hero Payroll admin access**, to create an API key.
- **Their award installed in Employment Hero**, if they pay under one. Choosing
  an award is a payroll and legal decision, so the wizard doesn't do it.
- **An onboarding pack** in Connecteam that new employees complete.

The integrator needs the repo cloned and `npm` working.

**If the client's staff are already in Employment Hero,** run the preflight
before the deploy stage (it needs only the Connecteam and EH keys, the pack ID
and the business ID in `.dev.vars`):

```sh
npm run preflight
```

It's read-only. The first approval check syncs every approved pack at once, and
the sync finds an existing EH employee by Connecteam ID only, then EH matches by
TFN. So a hand-made EH record with a different TFN, an exemption code
(`111111111` and the like), or a TFN shared with another record gets a
**duplicate** or lands on the **wrong person**. The preflight lists each approved
person as already linked, new, merge, or something to fix, plus EH records that
already share a TFN or an email. Fix everything it flags, re-run until it says
"Safe to deploy", then deploy.

**Allow about 30 minutes:** ~10 for stages 1–10, a few for deploy and
webhook, and up to 15 for Cloudflare to start the first approval check
(the wizard can wait for it).

## Stage by stage

| # | Stage | The client… | They should see | Time |
|---|---|---|---|---|
| 1 | Cloudflare account | Signs in when a browser tab opens | Their own account name. **Check it**: the deploy goes to whatever account this shows | 1–2 min |
| 2 | Connecteam: API key | Creates a key, pastes it (hidden) | — | 1–2 min |
| 3 | Connecteam: custom publisher | Creates the "Employment Hero Sync (Automated)" publisher, pastes its ID | — | 1–2 min |
| 4 | Connecteam: alerts channel | Creates "EH Sync Alerts", picks it from the list | — | 1–2 min |
| 5 | Connecteam: onboarding pack | Picks the pack from the list | A webhook secret is created (or kept, on a re-run) | 1 min |
| 6 | Employment Hero: API key | Creates a key, pastes it (hidden) | — | 1–2 min |
| 7 | Award classifications | Says whether they pay under an award; confirms it's installed in EH | The classifications imported into the "EH Pay Rate Template" dropdown (or "Nothing to do" on a re-run) | 1 min |
| 8 | Connecteam field check | Reads the table; creates missing fields if offered; **attaches new fields to the onboarding pack** by hand | `28 ok · 0 required missing or wrong · 0 warnings` when everything is in place | 1–5 min |
| 9 | Field map | Nothing, unless their fields changed since a previous run | A new client: "Built your field map from your Connecteam fields". A re-run: "Nothing to change", or the differences to copy across | 1 min |
| 10 | Pay-run settings | Picks pay schedule, location and primary pay category from their EH lists, then the pay rate source | "Saved to …", then the tests pass | 1–2 min |
| 11 | Provision Cloudflare resources | Confirms (the only question in this stage) | ✓ Database created · ✓ Database set up (4 steps) · ✓ Queues ready | 1 min |
| 12 | Push secrets + deploy | Waits | ✓ Stored … (×3) · ✓ Deployed: the Worker's address · ✓ Health check passed | 1–2 min |
| 13 | Register the webhook | Edits a test profile when asked | The webhook listed as `enabled`, then "the Worker accepted a profile update" | 2 min |
| — | First approval check | Optionally waits | "✓ the first approval check ran" (up to 15 min on a first deploy) | 0–15 min |

**A copy of the run** is saved as `setup-wizard-<date>-<time>.log` in the repo
folder (git-ignored), as plain text with every API key and secret replaced by
`[redacted]`. Cloudflare's own output from stages 11–12 is kept beside it in
`setup-wizard-<date>-<time>-wrangler.log`. The screen clears at each stage, so if anything looked wrong,
ask the client to send you that file.

**After the wizard**, together: approve a test employee's onboarding pack and
watch them appear in Employment Hero. Once the first approval check has run,
that takes about a minute.

## Known rough edges

None left from the rehearsals (#73). If the client hits something new, the
session log (below) is the first thing to ask for.

**Re-running the wizard on a live deployment** is safe for the webhook since
#82. It keeps the existing secret and updates the existing webhook instead of
adding one. A run from a **fresh clone** (no `.dev.vars`) still generates a new
secret, so profile edits get a `401` for the few minutes between its deploy and
its webhook stage.

## Rehearsal record

### 2026-10-02: first rehearsal (ADR-0006)

Empty Cloudflare account → working Sync, webhook and Correction path, in the
one set of demo accounts. It rebuilt the `self` deployment in place, from a
separate `EH_Webhook-rehearsal` folder (the project's name until ADR-0008). Its findings became #55, #57, #60–#70.

### 2026-10-03: re-run, stages 1–10

There is one set of accounts (Connecteam, EH business `555455`, Cloudflare),
and they run the live Sync. So the re-run used a fresh clone, walked stages
1–10 with the existing API keys, and **stopped at stage 11** (answered No) so
the live Sync wasn't touched. Plan: #73.

| Stage | Result |
|---|---|
| 1–6 | All values collected correctly and matching the live deployment, except a **newly generated webhook secret** (evidence for #82) |
| 7 | `140 options; 0 missing. Nothing to do` |
| 8 | `28 ok · 0 required missing or wrong · 0 warnings`; nothing to create |
| 9 | Kept the map: `= 28 fields identical`, award kept |
| 10 | Weekly / Connecteam / Permanent Ordinary Hours + award: the saved map is **identical** to the tuned map, no JSON edited; 429 tests pass |
| 11 | Stopped (No). Afterwards: Connecteam fields, webhooks, Cloudflare D1 and the live Worker all unchanged |

- **Time:** about 10 minutes for stages 1–10.
- **Browser links:** all worked.
- **Feedback:** the text felt cramped and "too terminal-like". It needs more
  spacing and more explanation of how each question connects to the other
  steps (#64). The screen clears per stage and nothing is logged, so stages
  1–8 couldn't be reviewed afterwards (#83).

**Not covered by this re-run** (proven elsewhere):
- deploy, webhook and the first-check wait (first rehearsal, #68, #69)
- the "replace a map from another account" path (#76)
- creating fields on a fresh account (#78's live create test)
