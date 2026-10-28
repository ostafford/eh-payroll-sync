# eh-payroll-sync

Syncs employee details entered in **Connecteam** into **Employment Hero Payroll**,
so staff enter their information once instead of twice.

A reusable, single-tenant integration template: deployed once per client, with every
client-specific value (API keys, IDs, field mapping) supplied as external config —
never code.

## How it works (short version)

1. An employee fills out their onboarding pack in Connecteam.
2. When an admin clicks **Approve Onboarding**, a scheduled check (every minute)
   notices and creates that person in Employment Hero Payroll.
3. Any later change to their Connecteam profile updates Employment Hero automatically.
4. If Employment Hero rejects something (e.g. an invalid bank BSB), the employee
   gets a Connecteam chat message telling them exactly what to fix.

One-way only. Employment Hero is never written back to Connecteam.

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

## Status

Design complete. **M0 (skeleton) and M1 (field mapping) done.** Next: M2 — the
Employment Hero Payroll API client (needs a test business). See `docs/PLAN.md` §4.

## Development

```sh
npm install
npm test                       # vitest (pure logic)
npm run typecheck              # tsc: node project + worker project
npx wrangler deploy --dry-run  # build + validate bindings
```

- `src/index.ts` — the Worker: `GET /health`, `POST /webhook` (M7), queue consumer
  (M5), 1-min cron sweep (M6).
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
