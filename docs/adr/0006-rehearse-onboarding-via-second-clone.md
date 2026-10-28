# Rehearse client onboarding via a second local clone, not a multi-tenant slot or a branch

## Status

accepted

## Context

Before ever running `scripts/setup-wizard.sh` with a real client, we want to prove
the wizard and `RUNBOOK.md` actually work end-to-end from a genuinely fresh
state — not just that the sync logic works, which the long-lived `self`
deployment already proves daily. `self` itself was never bootstrapped by the
wizard as it exists today: it was built up by hand across many sessions, and
several of its own past incidents (a stale `wrangler.jsonc` placeholder, an
accidental TFN collision between two test employees, a silently-broken custom
publisher) were found by accident in production use, not by a deliberate
rehearsal.

This repo already has a built-in mechanism for running more than one client
from one deployment — `clients/<slug>/` + `FIELD_MAP_CLIENT` +
`src/mapping/registry.ts` — and a plain `git branch` was also considered as a
lighter-weight way to keep a second, parallel setup without a second GitHub
repository.

## Decision

Rehearse onboarding using a **second local clone of the same repo/remote** (no
new GitHub repo, no long-lived branch), deployed as its own Cloudflare
Worker/D1/queues (`eh-payroll-sync-rehearsal`) against brand-new Connecteam and
Employment Hero accounts. That clone's `.dev.vars`, `wrangler.jsonc` IDs, and
`clients/self/field-map.json` tuning stay local and uncommitted — mirroring
the fill-locally-never-commit pattern `self`'s own deploys already use. Real
bugs found during the rehearsal are fixed on a short-lived branch off `main`
and merged via PR (docs-only wording fixes may go straight to `main`), so
every future client clone benefits immediately.

For the one feature that's genuinely tied to a live scheduled job —
`.github/workflows/health-watch.yml`, whose `HEALTH_URL` is a single
repo-level variable and whose `schedule:` trigger only ever runs off the
default branch — the drill temporarily repoints `HEALTH_URL` at the rehearsal
Worker, confirms the failure email fires, then reverts it to `self`'s URL.

## Considered options

- **`clients/<slug>/` + `FIELD_MAP_CLIENT` (the existing multi-tenant path)**:
  rejected. This is explicitly the secondary code path ("if you ever run
  several clients from one deployment") — a real client's wizard run never
  touches `registry.ts` or `FIELD_MAP_CLIENT`, so rehearsing through it
  wouldn't actually prove the thing we care about: that a fresh `git clone` →
  wizard → `clients/self/field-map.json` flow works.
- **A dedicated second GitHub repository**: rejected as unnecessary overhead.
  It would need every fix ported back into the canonical repo by hand instead
  of a direct PR, for no benefit over a second local clone of the same remote.
- **A long-lived branch on this repo**: rejected — `health-watch.yml`'s
  `schedule:` trigger doesn't run off non-default branches at all, and a
  branch that must be kept rebased against `main` to stay meaningful
  reintroduces the same "not actually a fresh client state" problem the
  rehearsal exists to avoid.

## Consequences

- The rehearsal deployment is kept running after this first pass (not torn
  down), so it's reusable for the next feature or the next client, at the cost
  of an ongoing Cloudflare Workers Paid charge (~$5/mo) plus whatever the
  Connecteam/EH test accounts cost.
- `self`'s health-watch briefly stops monitoring `self` during the `HEALTH_URL`
  swap for the drill — acceptable for a short, deliberate window, not
  something to leave in place.
- Expect a small batch of issues/PRs from this pass, the same shape as the
  `#41`–`#52` batch already in the project's history.
