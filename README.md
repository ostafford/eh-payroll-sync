# eh-payroll-sync

Syncs employee details entered in **Connecteam** into **Employment Hero Payroll**,
so staff enter their information once instead of twice.

A reusable, single-tenant integration: deployed once per client, into the client's
own Cloudflare account, with every client-specific value (API keys, IDs, field
mapping) supplied as config, never code.

## What you need

- A **Connecteam** account with an onboarding pack for new staff.
- An **Employment Hero Payroll** business (AU). This is the Payroll product
  (formerly KeyPay), not the Employment Hero HR platform.
- A **Cloudflare account on the Workers Paid plan** (~$5/month).

## Set it up for a client

Run the setup wizard from the repo root. It walks through every step, from an
empty Cloudflare account to a working sync:

```sh
./scripts/setup-wizard.sh
```

[`docs/client-setup-walkthrough.md`](./docs/client-setup-walkthrough.md) shows
what the setup call looks like, stage by stage. [`docs/RUNBOOK.md`](./docs/RUNBOOK.md)
covers the same steps by hand and day-to-day operations.

## How it works

1. An employee fills out their onboarding pack in Connecteam.
2. When an admin clicks **Approve Onboarding**, a scheduled check (every minute)
   notices and creates that person in Employment Hero Payroll.
3. Any later change to their Connecteam profile updates Employment Hero automatically.
4. If Employment Hero rejects something (e.g. an invalid bank BSB), the employee
   gets a Connecteam chat message telling them exactly what to fix.

One-way only: nothing from Employment Hero is written back to Connecteam.

## Documentation

| Doc | What's in it |
|---|---|
| [`CONTEXT.md`](./CONTEXT.md) | Glossary — the precise meaning of every term used here |
| [`docs/PLAN.md`](./docs/PLAN.md) | Build plan: scope, architecture, milestones, risks |
| [`docs/field-mapping.md`](./docs/field-mapping.md) | Connecteam field → Employment Hero field, with transforms |
| [`docs/adr/`](./docs/adr/) | Architecture decision records (the "why" behind key choices) |
| [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) | How to deploy this for a new client, and day-to-day operations |
| [`docs/client-setup-walkthrough.md`](./docs/client-setup-walkthrough.md) | The setup call, stage by stage: what the client does, sees, and how long it takes |
| [`docs/connecteam-field-checklist.md`](./docs/connecteam-field-checklist.md) | Every Connecteam field the sync needs, and how to fix each field-check result |

## Development

```sh
npm install
npm test                       # vitest (pure logic)
npm run typecheck              # tsc: node project + worker project
npm run deploy:config && npx wrangler deploy --dry-run --config wrangler.deploy.json  # build + validate bindings
```

- `src/index.ts` — the Worker: `GET /health`, `POST /webhook`, queue consumer,
  1-min cron sweep.
- `src/mapping/` — pure Connecteam → Employment Hero field mapping (no network).
- `src/db/schema.ts` + `migrations/` — D1: identifiers, sync state, audit log. **No PII.**
- `clients/<slug>/field-map.json` — the per-client mapping artifact. Bundled into
  the Worker via `src/mapping/registry.ts` (one import line per client) and loaded
  by `src/mapping/loader.ts` for the `FIELD_MAP_CLIENT` this deployment serves; a
  missing or invalid map fails `/health` with the reason. `clients/_example/` is a
  worked example.
- `test/fixtures/` — synthetic Connecteam data only; never real employee data.

Config: `wrangler.jsonc` is a blank template. A deployment's non-secret IDs
(and its `D1_DATABASE_ID`) live in the git-ignored `.dev.vars`, and
`npm run deploy` builds `wrangler.deploy.json` from the two, checking it against
the live Worker first (RUNBOOK §5). Never `wrangler deploy` the template.
Secrets (`CT_API_KEY`, `EH_API_KEY`, `CT_WEBHOOK_SECRET`) via `wrangler secret put`.

Stack: TypeScript · Hono · Cloudflare Workers + Queues + D1 · Drizzle · Vitest.
Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
