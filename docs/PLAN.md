# Executable plan — Connecteam → EH Payroll sync

Companion docs: [`CONTEXT.md`](../CONTEXT.md) (glossary), [`field-mapping.md`](./field-mapping.md),
ADR [0001](./adr/0001-sensitive-data-flows-through-the-integration.md) · [0002](./adr/0002-poll-connecteam-onboarding-api-for-approvals.md).

## 1. What we're building

A reusable, single-tenant integration template. One deployment per client:
Cloudflare Worker (custom domain) + Queue + D1, all client specifics in external
config. Employee fills a Connecteam onboarding pack once → on admin approval the
record is created in EH Payroll → later profile edits keep it in sync → bad data
comes back to the employee as a Connecteam chat message.

### Boundaries (v1)

| In | Out (manual in EH, or a scoped add-on later) |
|---|---|
| Personal, address, emergency contact, structural fields | Offboarding / termination / archival |
| TFN + tax-declaration answers | Pay **rate** amounts (no field yet) |
| One bank account | 2nd/3rd bank accounts |
| APRA super (USI + member number) | SMSF super; per-employee pay rate. A flat-rate workforce can opt into `employmentHero.defaults` (pay category / rate / hours / award) — see [`eh-pay-defaults.md`](./eh-pay-defaults.md) (#26) |
| Create + update, one-way CT→EH | Any write back to Connecteam |
| Clients using the Onboarding feature with an approval step | Forms-based or no-approval clients |
| Single EH employing entity | Multi-entity businesses |

## 2. Architecture (recap)

```
Connecteam ──user_updated webhook──►┐
                                    │            ┌───────────────┐
Cron (1 min): GET onboarding        ├─► Worker ─►│ Cloudflare    │─► Consumer ─► EH Payroll API
assignments, diff vs D1,            │   (verify   │ Queue         │      │          (create/update
enqueue new `completed` ───────────►┘   sig)     └───────────────┘      │           + read-back)
                                                                        │
        D1: ct_userId ⇄ eh_employeeId · last_synced_ts ·                ├─ 422 / Incomplete / mismatch
            failure_cycle_count · audit log  (NO TFN/bank)              │   └─► Correction message → employee
                                                                        ├─ valid-but-needs-human
                                                                        │   └─► Manual-follow-up notice → channel
                                                                        └─ retries exhausted
                                                                            └─► DLQ → System alert → channel
```

Idempotency: key = `userId + sha256(normalised mapped payload)`; ordering =
last-write-wins on Connecteam `eventTimestamp` vs D1 `last_synced_ts`; EH match by
`externalId = ct_userId`.

## 3. Repo scaffold

```
eh-payroll-sync/
├── CONTEXT.md
├── README.md                     # dev setup
├── wrangler.jsonc                # bindings, vars, cron, queue, D1
├── package.json                  # ts, hono, drizzle, vitest, wrangler
├── vitest.config.ts              # @cloudflare/vitest-pool-workers
├── drizzle/                      # D1 migrations
├── clients/
│   └── _example/
│       ├── field-map.json        # per-client mapping (schema-validated)
│       └── config.example.jsonc  # non-secret IDs + secret names checklist
├── src/
│   ├── index.ts                  # Hono app: POST /webhook, GET /health
│   ├── webhook/verify.ts         # Connecteam signature check
│   ├── cron/sweep.ts             # onboarding-approval poll + diff
│   ├── queue/consumer.ts         # the sync worker
│   ├── mapping/
│   │   ├── schema.ts             # field-map JSON schema + loader/validator
│   │   ├── apply.ts              # CT user + map → EH unstructured payload
│   │   └── transforms.ts         # date, phone, dropdown, location, zero-pad
│   ├── eh/client.ts              # EH Payroll API (upsert, get-by-externalId)
│   ├── connecteam/client.ts      # users, onboarding, chat (custom publisher)
│   ├── sync/
│   │   ├── decide.ts             # classify result → ok / correction / follow-up / retry
│   │   ├── cycles.ts             # failure-cycle state machine
│   │   └── messages.ts          # compose the 3 message types (curated map)
│   ├── db/schema.ts              # drizzle: mappings, sync_log
│   └── redact.ts                 # scrub TFN/bank from any log line
├── scripts/
│   └── discover.ts              # npm run discover → dumps CT fields + EH config, drafts field-map.json
└── docs/
    ├── PLAN.md  ·  field-mapping.md  ·  RUNBOOK.md  ·  adr/
```

## 4. Build milestones (TDD — each ships red→green→refactor with tests)

Tracked as GitHub issues (dependency order, `ready-for-agent`):

| Issue | Milestone | Blocked by |
|---|---|---|
| [#2](https://github.com/ostafford/eh-payroll-sync/issues/2) EH Payroll client | M2 | — |
| [#3](https://github.com/ostafford/eh-payroll-sync/issues/3) Connecteam client | M3 | — |
| [#4](https://github.com/ostafford/eh-payroll-sync/issues/4) Bundle & load client field-map | M5 (split) | — |
| [#5](https://github.com/ostafford/eh-payroll-sync/issues/5) Sync decision, messages & cycles | M4 | #2 |
| [#6](https://github.com/ostafford/eh-payroll-sync/issues/6) Queue consumer end-to-end | M5 | #2 #3 #4 #5 |
| [#7](https://github.com/ostafford/eh-payroll-sync/issues/7) Cron approval sweep | M6 | #6 #3 |
| [#8](https://github.com/ostafford/eh-payroll-sync/issues/8) Inbound webhook | M7 | #6 #3 |
| [#9](https://github.com/ostafford/eh-payroll-sync/issues/9) Hardening & handover | M8 | #7 #8 |


### M0 — Skeleton & CI (0.5 day)  ✅
- Wrangler project (`wrangler.jsonc`), D1 binding + `migrations/0001_init.sql`, Queue
  (producer + consumer + DLQ), 1-min cron, Hono app with `GET /health`.
- Drizzle schema (`src/db/schema.ts`) — identifiers + audit only, no PII.
- Vitest (node) for the pure logic; CI (`.github/workflows/ci.yml`) runs typecheck + tests.
- **Exit:** `wrangler deploy --dry-run` builds and validates all bindings; unit suite green.
- _Deferred:_ `@cloudflare/vitest-pool-workers` in-workerd tests land with M5, where the
  queue consumer first needs D1 + bindings under test.

### M1 — Field mapping (pure, no network) (2 days)  ✅

- `field-map.json` schema + loader (fail-fast validation).
- `transforms.ts`: `DD/MM/YYYY→ISO`, phone normalise, dropdown `[{value}]→value`,
  `location→address`, zero-pad BSB(6)/postcode(4), keep TFN leading zeros.
- `apply.ts`: CT user object + map → `AuUnstructuredEmployeeModel` payload.
- APRA-vs-SMSF branch; residency/TFT/HELP → EH tax fields.
- **Tests:** table-driven fixtures with **synthetic** PII (check-digit-valid fake
  TFNs/BSBs); golden-file EH payloads; every "still to verify" enum stubbed behind
  a constant so it's a one-line change later.
- **Exit:** given a realistic CT user JSON, correct EH payload; bad/missing fields
  produce typed mapping errors.

### M2 — EH Payroll client (2 days, against your real EH test business)
- `upsert` (POST unstructured), `getByExternalId`, read-back compare (non-sensitive
  fields + status only).
- Classify responses: 200 ok · 422 → parse error body · 5xx/network → retryable.
- **Tests:** integration tests create/update/fetch a `ZZZ_TEST_*`-named employee in
  business `555455`, then delete it in teardown. Never touch pay runs.
- **Exit:** create a synthetic employee end-to-end via the client; 422 on a
  deliberately bad BSB is parsed into `{field, reason}`.

### M3 — Connecteam client (1.5 days)
- `getUser`, `listOnboardingAssignments`, `sendCustomPublisherDM`, `sendChannelMessage`.
- Signature verification for inbound webhooks (`secretKey` HMAC — confirm scheme).
- **Tests:** recorded-fixture contract tests; live smoke test against your account
  (read-only + one DM to yourself).
- **Exit:** can read an assignment list, resolve a user, and post a chat message as
  the custom publisher.

### M4 — Sync decision + messages + cycles (2 days)
- `decide.ts`: result → `ok | correction(field[]) | follow_up(reason) | retry`.
- Curated EH-error → plain-language map + generic fallback; the 3 message templates.
- `cycles.ts`: D1-backed counter; 1–2 → employee, 3 → + Direct manager; reset on success.
- Manual-follow-up triggers: non-resident, WHM, SMSF, `INTERNATIONAL` address.
- **Tests:** state-machine unit tests; message snapshots.
- **Exit:** each result class produces the right message to the right recipient.

### M5 — Queue consumer wiring (1.5 days)
- Consumer: load map → resolve externalId (D1, then EH by-externalId, then email) →
  apply → upsert → read-back → decide → act → update D1 (`last_synced_ts`, audit).
- Retry/backoff config; DLQ handler → System alert.
- Idempotency guard (skip unchanged; drop stale `eventTimestamp`).
- **Tests:** consumer integration tests with a fake queue; replay/out-of-order/dupe.
- **Exit:** enqueue a CT user → EH employee appears; re-enqueue same → no-op.

### M6 — Cron approval sweep (1 day)
- Poll assignments, diff `status` vs D1, enqueue new `completed`, persist state.
- Backoff on Connecteam `x-ratelimit-*`.
- First-run behaviour = picks up all currently-`completed` packs, throttled.
- **Tests:** diff logic (new approval, re-approval, un-approve→re-approve, no change).
- **Exit:** approving a pack in your account causes an EH create within ~1 min.

### M7 — Inbound webhook path (1 day)
- `POST /webhook`: verify signature → 200 fast → enqueue. Reject unsigned/bad.
- **Tests:** signature pass/fail; malformed payload; returns <50 ms.
- **Exit:** editing an approved user's profile in Connecteam updates EH.

### M8 — Hardening & handover (2 days)
- `redact.ts` enforced on all logging; audit log holds field names + status only.
- `/health` shows queue depth, DLQ depth, last successful sweep.
- `npm run discover` productised.
- Write `RUNBOOK.md`; dry-run a fresh deployment against a second (throwaway) config.
- **Exit:** a clean deploy from runbook only, no code edits.

_Rough total: ~3 working weeks for one engineer._

## 5. Client runbook outline (`docs/RUNBOOK.md`)

> Fully written in [`RUNBOOK.md`](./RUNBOOK.md) for the **self-host** model
> (client runs it on their own Cloudflare account; `scripts/setup-wizard.sh` is
> the happy path). The outline below is the historical skeleton.

1. **Prerequisites checklist** (from Q40 + A40): EH Payroll AU + API access;
   single employing entity; Connecteam Onboarding feature with approval; APRA super;
   awards already configured in EH.
2. **Connecteam setup:** create the API key; create the custom publisher "EH Sync"
   (Settings → Feed settings) and note its **publisher ID**; create a dedicated
   **"EH Sync Alerts" channel**, add the admins who should action alerts, and note
   its conversation ID (`GET /chat/v1/conversations`); note the **onboarding pack
   ID**. Generate a `CT_WEBHOOK_SECRET` (random). *The webhook itself is registered
   after deploy — step 8 — because it needs the Worker's live URL.*
   *Runbook must explain the messaging model here:* the **custom publisher** is the
   sender of **all** messages; the **Correction message** is a direct message to
   the employee (and, on the 3rd failed cycle, to the Direct manager); the
   **Manual-follow-up notice** and **System alert** go to the **alerts channel**.
   A channel (not per-admin direct messages) so admins can be added/removed without
   touching config.
3. **EH Payroll setup:** create API key; disable the employee **setup** email;
   record `businessId`, pay schedule ID, location ID.
4. **Run `npm run discover`** with both keys → produces `clients/<slug>/field-map.json`
   draft + config checklist.
5. **Tune `field-map.json`** — verify every mapped field ID against the client's
   actual custom fields; resolve any `TODO` enums.
6. **Cloudflare:** `wrangler d1 create`, apply migrations, create the queue, set a
   route/custom domain, `wrangler secret put` the three secrets, set vars.
7. **Deploy** (`wrangler deploy`); confirm `/health`.
8. **Register the Connecteam webhook** — now that the Worker has a URL. Run
   `npm run register-webhook` (calls `POST /settings/v1/webhooks` with the
   deployed `/webhook` URL, feature `users`, and `CT_WEBHOOK_SECRET`), or enter
   the same three values in the Connecteam UI by hand.
9. **Verify:** approve one test pack → EH create within a minute; edit a field →
   EH update; enter a bad BSB → correction chat message.
10. **Go live:** existing approved users flow in via the sweep over the following
    minutes; monitor `/health` and the admin channel.
11. **Operations:** what each of the 3 message types means and who acts; how to
    replay a DLQ message; rotating keys.

## 6. Risk register

| Risk | Mitigation |
|---|---|
| `status: completed` meaning changes in Connecteam | Alert if daily approved-count unexpectedly 0; documented in ADR-0002 |
| `user_updated` not fired/signed as expected on custom-field edits | Verified first thing in M7; cron sweep is a partial safety net |
| EH enum mismatches (gender, residency, HELP/STSL names) | Isolated behind constants in M1; confirmed in M2 against real EH |
| Sensitive data in logs | `redact.ts` mandatory; audit log is field-names-only; code review gate |
| TFN declaration incomplete for edge cases (WHM) | Manual-follow-up notice to channel; documented exception |
| Client's Connecteam fields differ from this account | That's the point of `field-map.json` + discovery script |
| API keys were shared in chat during design | **Rotate both before any deployment** |

## 7. Open items to verify during the build (not blockers)

- Exact EH enum values: `gender`, residency/tax scale, HELP vs STSL field names.
- Real EH `422` body shape → seeds the curated error map (M2). **Resolved (#22):**
  EH returns HTTP `400` `{ "message": "..." }`; messages come both as
  `Field: reason` and as bare prose (`"Tax File Number is invalid"`).
  **Extended (#29):** `parseValidationBody` maps the known colon-less phrases
  (TFN, tax-free threshold, bank / super allocation) back to an EH field name;
  add new phrases to `COLONLESS_REASON_FIELDS` in `src/eh/errors.ts` as they
  appear in `sync_log`.
- Connecteam webhook signature algorithm (`secretKey`) — header + digest (M3).
  **Resolved (#22):** no HMAC. `webhookVersion: 1` sends the `secretKey` verbatim
  in the `x-webhook-secret` header. `secretKey` is settable via the API only.
- Un-approve behaviour: does the assignment leave `status: completed`? (M6)
  **Resolved (#22): no** — re-approval is not a reliable resync trigger; only a
  profile edit (`user_updated`) or a first-time `completed` is.
- Connecteam webhook granularity. **Resolved (#22):** one delivery **per changed
  field**; `data` is an array. The consumer coalesces the burst per user.
- Connecteam exact rate-limit numbers under load (M6) — headers already show 200/min, 20k/day.
