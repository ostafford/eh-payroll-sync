# eh-payroll-sync — integrator telemetry relay

A tiny standalone Cloudflare Worker the **integrator** hosts **once** (issue #23).
It is **not** part of any client deployment.

Each client's Worker can optionally push out-of-band telemetry when
`INTEGRATOR_ALERT_URL` is set (see the main repo's `src/integrator.ts`):

- `{ kind: "system_alert", client, ctUserId, reason, at }` — a sync job
  dead-lettered on that client.
- `{ kind: "health", client, ok, d1, fieldMap, ops, at }` — a once-a-day
  health summary.

This relay receives those and turns them into **GitHub issues** in one repo, so
the integrator is notified by GitHub e‑mail — without any GitHub credential ever
living in a client deployment.

## Behaviour

| Push | What the relay does |
|---|---|
| `system_alert` (first for a `client` + `ctUserId`) | opens issue `[eh-payroll-sync] system alert — <client> / user <id>`, labels `eh-relay` + `system-alert` |
| `system_alert` (repeat, same client + user, issue still open) | adds a comment — **one issue, not many** |
| `system_alert` after that issue was closed | opens a fresh one |
| `health` `ok:false` | opens/updates `[eh-payroll-sync] health — <client>` with the snapshot |
| `health` `ok:true` while that issue is open | comments "recovered" and **closes** it |
| `health` `ok:true` with nothing open | no-op (no perpetual "all good" issue) |

`EMAIL_WEBHOOK_URL` (optional) also gets a compact `{ subject, text }` POST for
integrators who want a direct email hop (Zapier / Make / an SMTP bridge) instead
of relying on GitHub notifications.

## Deploy (integrator, once)

```bash
cd integrator-relay
npm install

# 1. GitHub token — fine-grained PAT, repo-scoped to the issues repo,
#    Permissions -> Issues: Read and write. Nothing else.
npx wrangler secret put GITHUB_TOKEN

# 2. The shared secret clients send as x-eh-sync-secret.
#    Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put RELAY_SECRET

# 3. Set the target repo (and optional email webhook) in wrangler.jsonc `vars`:
#      "GITHUB_REPO": "ostafford/eh-payroll-sync"
#      "EMAIL_WEBHOOK_URL": ""

npx wrangler deploy
```

Then, in that repo, create the labels once (any colour):
`eh-relay`, `system-alert`, `health`. (Issue creation still works without them,
but GitHub won't back-fill the label.)

Check it's live: `curl https://<relay>.workers.dev/health` → `{ "ok": true, ... }`.

## Point a client at it

In the client's `wrangler.jsonc` `vars` / secrets:

| Key | Value |
|---|---|
| `INTEGRATOR_ALERT_URL` (var) | `https://<relay>.workers.dev/` |
| `INTEGRATOR_ALERT_SECRET` (secret) | the same value as the relay's `RELAY_SECRET` |
| `INTEGRATOR_CLIENT_ID` (var) | a short slug for this client, e.g. `acme` — the relay keys one issue per client on it |

Nothing else changes on the client side. If `INTEGRATOR_ALERT_URL` is blank the
client sends nothing.

## Develop / test

```bash
npm test          # pure-logic tests, no network
npm run typecheck
cp .dev.vars.example .dev.vars   # then `npm run dev`
```
