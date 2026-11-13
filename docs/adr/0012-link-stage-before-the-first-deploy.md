# The link stage runs before the first deploy

## Status

accepted

## Context

The approval sweep treats every approved pack it hasn't recorded yet as just approved. On a first deploy nothing is recorded, so every pack the client has already approved syncs on the first tick. What happens to each **Pre-existing employee** then depends on the **Link list** as it stands at that moment.

The wizard deployed at stage 12 and ran the link stage at stage 13. At the first client go-live (2026-11-12, ~371 people), the sweep drained the backlog before the Link list existed: 112 people were Held, one admin-channel notice each, and 11 Corrections went to employees. The queue was paused by hand mid-setup (#192).

We considered three options:

- **Deploy with the queue paused, resume at the end.** The sweep still records everyone as queued, so an abandoned wizard leaves jobs that expire after 4 days and are never re-queued.
- **A go-live marker the sweep checks.** It also covers a hand-run deploy, but it's new runtime state that can be forgotten: a wizard that stops after the deploy leaves a Worker that silently syncs nothing.
- **Run the link stage before the deploy.** Chosen.

## Decision

The link stage moves to just after "Provision Cloudflare resources" and before "Push secrets + deploy". The database exists and is migrated by then, the config check already accepts "no live Worker yet", and the stage-9 check already runs before a deploy.

The deploy stage runs only once the link stage has ended in one of two ways: the Link list saved, or the admin confirming that nobody in the pack is already in EH, so everyone is a new hire. Quitting the Link list without either stops the wizard before anything goes live.

`--stage link` stays for a live deployment.

## Consequences

- Nothing is live until the Link list is settled, and no new runtime state is added.
- A deploy run outside the wizard (by hand, or `update.sh` on a fresh clone) isn't protected. The RUNBOOK says to finish the link stage first.
- The first sweep still processes the whole backlog at once. With links in place, that's one Link notice per linked person in the admin channel: #193 summarises it.
