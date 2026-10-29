# Rename the project and its Cloudflare resources to eh-payroll-sync before the first client deploy

## Status

accepted

## Context

The project was called `EH_Webhook`, and every deployment's Cloudflare
resources were named after it: Worker and D1 `eh-webhook`, queues
`eh-webhook-sync` and `eh-webhook-dlq`, relay `eh-webhook-integrator-relay`.

The name described the project badly. "Webhook" is only one of its triggers
(the onboarding poll and the daily recheck are others, ADR-0002 and ADR-0005).
"EH" alone is the term the glossary says to avoid, since the target is
specifically Employment Hero **Payroll**.

Each client deploys into their own Cloudflare account, so these names show up
in the client's dashboard and in their webhook URL
(`<worker>.<subdomain>.workers.dev`). After a client deploys, renaming means a
new Worker URL to re-register in Connecteam and a new, empty D1 to migrate into.
No client had deployed yet, which made this the cheapest point to rename.

## Decision

Rename everything, the repo and the deployed resource names, to
`eh-payroll-sync`:

| Was | Now |
| --- | --- |
| Worker / D1 `eh-webhook` | `eh-payroll-sync` |
| Queue `eh-webhook-sync` | `eh-payroll-sync-queue` |
| Queue `eh-webhook-dlq` | `eh-payroll-sync-dlq` |
| Relay `eh-webhook-integrator-relay` | `eh-payroll-sync-relay` |
| Relay issue titles `[eh-webhook] …` | `[eh-payroll-sync] …` |
| GitHub repo `ostafford/EH_Webhook` | `ostafford/eh-payroll-sync` |

"Connecteam" is left out of the name: every deployment is a Connecteam
integration, so the name only needs to say where the data goes.

Dated history entries (the rehearsal record in `client-setup-walkthrough.md`)
keep the old names, because they describe what existed at the time.

## Considered options

- **Rename only what people read (repo, README, banners), and keep the resource
  names.** Rejected: the client sees the resource names in their own account.
- **Defer the rename until after go-live.** Rejected: after the first client
  deploys, the rename stops being free and becomes a migration.
- **Shorter names (`ct-eh-sync`).** Rejected: "ct" and "eh" are insider
  shorthand a client may not decode.

## Consequences

- The integrator's own `self` deployment (Worker `eh-webhook`) and the deployed
  relay keep their old names until each is redeployed from this code and the old
  one is torn down (RUNBOOK "Tearing down / starting over"). A redeploy creates
  new resources; it doesn't rename the old ones.
- Relay issues opened under the old `[eh-webhook]` title won't be matched by
  the new title, so the first alert after the switch opens a fresh issue.
- Renaming again after a client deploys means a new Worker URL and a D1 data
  migration for each client, which would need its own ADR.
