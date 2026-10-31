# Deployment runbook — Connecteam → Employment Hero Payroll sync

This integration is **self-hosted**: the client runs it on **their own Cloudflare
account**, one deployment for their business. Everything client-specific is
external config (`wrangler.jsonc` vars, Cloudflare secrets, and
`clients/self/field-map.json`) — **no code changes**.

Glossary terms — **custom publisher**, **alerts channel**, **Correction message**,
**Manual-follow-up notice**, **System alert**, **Onboarding pack**, **Sync** — are
defined in [`../CONTEXT.md`](../CONTEXT.md).

---

## Who does what

| | |
|---|---|
| **Client's technical person** | Runs this document / the wizard. Owns the Cloudflare account and the deployment from then on. |
| **Integrator** | Joins a one-time ~1 hr onboarding call: helps create the Connecteam objects and API keys, watches the wizard run, confirms `/health`. Never holds the client's credentials or deploys for them. |
| **Client's HR / payroll admins** | No setup role. After go-live they action the message types (see [Operations](#day-to-day-operations)). |

The whole of steps 1–7 is driven by **`scripts/setup-wizard.sh`** — it opens each
page, captures every value, provisions D1 + Queues, pushes the secrets and
deploys. The sections below are the reference the wizard follows; read them once,
then run the wizard.

Each run is saved as **`setup-wizard-<date>-<time>.log`** in the repo folder
(git-ignored, readable only by you): plain text, with every API key and secret
from `.dev.vars` replaced by `[redacted]`. The screen clears at every stage, so
this is the way to look back or to send the integrator what happened. It is only
written when the wizard runs in a real terminal (it uses `script`).

The wizard runs Cloudflare's `wrangler` quietly and shows one line per step
("✓ Database created", "✓ Deployed: …"). Wrangler's full output goes to
**`setup-wizard-<date>-<time>-wrangler.log`** beside it, and the last lines of
any failure are shown on screen. On a fresh install, the database's setup
steps are applied without asking (wrangler's own confirm defaults to yes when
run non-interactively, and an empty database has nothing to lose). On a
re-run with a pending update, the wizard warns that syncing may pause for a
few seconds and asks first.

---

## Prerequisites

**Accounts**

- **Employment Hero Payroll** (AU) with API access, and a **single** employing entity.
- **Connecteam** with the **Onboarding** feature and an **approval step** in the pack.
- A **Cloudflare account on the Workers Paid plan** (~$5/month). Cloudflare
  **Queues** — which the sync pipeline uses — is not available on the free plan.
  D1, Workers and Cron triggers are covered by the free allowances; Queues adds a
  small per-operation cost on top of the $5.

**Assumptions baked into v1**

- Employees enter **APRA** super (USI + member number); the sync writes a single
  fund at 100% allocation. SMSF is surfaced as a Manual-follow-up notice, not synced.
- Awards / pay rates / **pay-run defaults** are set up in Employment Hero by a
  payroll admin — the sync never sets them. Until an admin does, EH reports the
  new record as **`Incomplete`** and the sync raises a **Manual-follow-up
  notice** to the alerts channel (it is *not* sent to the employee as a
  Correction). See [Verify & go live](#7-verify--go-live). If the whole company
  is on **one flat pay rate**, the opt-in `employmentHero.defaults` block can
  stamp the complete pay-run set — pay schedule, primary location, pay category,
  rate, rate unit (plus optional hours / award), all **by name** — on every
  record; EH rejects a partial set, so it's all or nothing. Field names and
  probe results are in [`eh-pay-defaults.md`](./eh-pay-defaults.md).
- Onboarding-pack approval is a real step (the initial Sync fires when a pack
  first reaches `status: completed`). **Re-approving** a pack is *not* a reliable
  way to force a resync — see [Operations](#re-syncing-an-employee).

**Local tools** (on the machine doing the deploy)

- Node 20+ and npm
- `git`, `curl`
- `npx wrangler` (installed automatically by `npm install`)

---

## 1. Get the code

```bash
git clone <this-repo> eh-payroll-sync
cd eh-payroll-sync
npm install
```

One clone = one client. The deployment loads `clients/self/field-map.json`
automatically; `FIELD_MAP_CLIENT` is left blank. (The `clients/` folder and
`src/mapping/registry.ts` only matter if you ever run several clients from one
deployment.)

---

## 2. Connecteam setup

The Worker cannot create these — a human makes them in the Connecteam UI and the
wizard captures the IDs. The integrator usually drives this part of the call.

### 2a. API key
Integrations → API Keys. Create a key with **read** on users + onboarding and **write** on
chat. During setup it also needs **write on custom fields**: the wizard creates
the missing fields (2f) and the award dropdown (§3). → **`CT_API_KEY`**
(Cloudflare secret).

### 2b. Custom publisher — *the sender of every message*
Settings → Custom Publishers → create one named **"Employment Hero Sync
(Automated)"**. Note its **publisher ID**.

- **What it is:** a named non-human sender that the Connecteam chat API can post as.
- **What it's for:** the sync sends three kinds of message — the **Correction
  message** to an employee, and the **Manual-follow-up notice** + **System alert**
  to the alerts channel — and *all three* are sent as this one publisher, so they
  read as "from the payroll sync", not from a colleague.
- **Why this way:** the chat API can only post as a real user or a custom
  publisher. A custom publisher means no staff member's name is attached to
  automated payroll messages, and the sender can't leave the company.
- **Why "(Automated)":** the sender name is what shows on a phone notification,
  before anyone opens the message. Messages to a person also end with a closing
  line saying they were sent automatically (`messages.automatedNote` in
  `field-map.json`, below), so it's clear both before and after opening.

→ **`CT_CUSTOM_PUBLISHER_ID`** (`wrangler.jsonc` var).

### 2c. Alerts channel — *where admin-facing messages go*
Chat → create a channel named e.g. **"EH Sync Alerts"**. Add the payroll admins
who should action alerts. The wizard lists channels via `GET /chat/v1/conversations`
so you can pick its ID.

- **What it is:** a normal Connecteam chat channel.
- **What it's for:** it receives the **Manual-follow-up notice** (data synced but
  a payroll admin must finish something by hand — non-resident tax scale, SMSF
  super, `INTERNATIONAL` address) and the **System alert** (a Sync that
  dead-lettered — Employment Hero outage, auth failure, a bug). The **Correction
  message** does *not* come here — it goes straight to the employee who entered
  the bad data, and to their **Direct manager** on the third failed attempt in a row.
- **Why a channel, not per-admin DMs:** admins join or leave the channel in the
  Connecteam UI with no config change and no redeploy. A DM list would have to
  live in config and be edited every time the payroll team changes.

→ **`ADMIN_CONNECTEAM_CHANNEL_ID`** (`wrangler.jsonc` var).

### 2d. Onboarding pack
The pack employees complete (HR & Skills → Onboarding), with an approval step.
The wizard lists packs via `GET /onboarding/v1/packs`.
→ **`CT_ONBOARDING_PACK_ID`** (`wrangler.jsonc` var).

### 2e. Webhook secret
The wizard generates a random 32-byte hex string. The same value is given to
Connecteam when the webhook is registered (step 5). → **`CT_WEBHOOK_SECRET`**
(Cloudflare secret).

### 2f. Custom fields
The sync reads 27 custom fields (`docs/connecteam-field-checklist.md`; the award
dropdown is §3). The wizard first shows which of the client's fields it matched
to each one and lets you confirm, pick another, create one or skip (optional
fields only). It then checks them and creates any that are missing, with the
right type, dropdown options and permissions:

```bash
npm run pick-fields                  # confirm or pick each field; saved to clients/self/field-picks.json
npm run field-check                  # every field: found / missing / wrong type / options, with fixes
npm run create-fields -- --dry-run   # list what's missing
npm run create-fields
```

`field-check` exits `2` when a required field is missing, the wrong type, or
not yet picked (more than one match, or the picked field was deleted); the
wizard won't continue until it's fixed.

Picks are saved by Connecteam field ID, and `field-check`, `create-fields` and
`discover` all read them before matching by name, so all three use the same
field. A field the client already has under their own name (e.g. "Tax File Number"
for "TFN") is matched and left alone, so re-running never duplicates one. A
re-run of the picker asks only about fields not yet decided.

Super is all four fields or none (#117): the sync's super rule needs the USI,
ABN, fund name and member number together. Skipping any one asks "Skip super
entirely?". Yes skips all four, and the field map then has no super rule, so
super is entered in Employment Hero by hand for every employee. A hand-edited
`field-picks.json` that skips some super fields but not all is rejected.

For a picked dropdown whose options aren't all values EH takes (e.g. Employee
Status `Full-time | PBV`), the picker asks what each option sends: an EH value,
or "not synced" (the employee gets a Correction message). Tax questions map to
Yes / No the same way. The choices are saved with the pick, go into the draft
field map, and `discover` writes them into a field map it kept.

**Rehearse the picker without an account.** `--fields-file` reads saved field
definitions instead of calling Connecteam, and keeps the choices in a scratch
file in the system temp folder (never `clients/self`). The bundled file is the
first client's setup (#112): `(OLD)` duplicates, renamed tax questions, and
options EH doesn't take.

```bash
npm run pick-fields -- --fields-file test/fixtures/first-client-fields.json
npm run field-check -- --fields-file test/fixtures/first-client-fields.json
```

Delete the scratch file the picker names to start over.
**Then attach each new field to the onboarding pack in the Connecteam UI** (no
API for that); the script prints the exact list. A field not in the pack is
never asked, so it is always blank.

---

## 3. Employment Hero Payroll setup

1. Create an API key (My Account → Security → API Key) → **`EH_API_KEY`** (Cloudflare secret).
2. **Disable the employee self-setup email** for the business (Payroll settings →
   employee onboarding). The sync creates and completes the record via the API;
   the setup email would confuse employees.
3. The structural IDs are discovered for you in the next step:
   - `businessId` — `GET /api/v2/business` → **`EH_BUSINESS_ID`**

   Pay schedule and location are no longer deployment vars (issue #26). The
   wizard's Pay-run settings stage names them in `employmentHero.defaults`
   (§4); skip it and every record lands `Incomplete` on the pay-run axis and a
   payroll admin finishes it by hand, unchanged.
4. **Award (if the business pays under one).** Install the award(s) in EH (a
   payroll and legal decision, so manual), then import its classifications
   into Connecteam:

   ```bash
   npm run provision-classification-field
   ```

   This creates the admin-only Connecteam dropdown **EH Pay Rate Template**
   with every EH classification as an option (the wizard's Award
   classifications stage runs it). Admins then pick each employee's
   classification on their Connecteam profile. It is mapped to the sync by the
   Pay-run settings stage (§4) when you choose "Award classification".

---

## 4. Field map

The wizard runs this; here is what it does.

```bash
npm run discover -- --client self
```

Reads every custom-field **definition** (name, type, ID) in the client's
Connecteam account and the Employment Hero structural IDs, then writes the
files below. It works on a fresh onboarding pack that nobody has filled in yet. Definitions
cover the whole account, and the API can't tell which fields are attached to
the pack, so confirm that in the Connecteam UI.

- **`clients/self/field-map.json`** — a schema-checked draft mapping. It replaces
  the map that ships in the repo (set up for another account), but **never** a
  map already set up for this account (same Connecteam pack + EH business):
  then it writes `field-map.draft.json` beside it (git-ignored) and prints what
  differs, so tuning such as pay-run defaults and the award field is kept.
- **stdout** — a configuration checklist: every var and secret with the
  discovered value or a `TODO` and where to find it.

It writes field **names** and IDs only — never an employee value.

**Then tune the draft.** Open `clients/self/field-map.json` and:

- Check **every** mapped `customFieldId` against the client's real fields.
- Resolve any `TODO` (usually the super field IDs and `EH_*` IDs).
- Confirm the enum `map`s match the client's dropdown option text — `gender`,
  `residentialState` (incl. `INTERNATIONAL`), `employmentType`.

**Then pick the pay-run settings** (the wizard's next stage):

```bash
npm run pay-defaults -- --client self
```

Lists the client's Employment Hero pay schedules, locations and primary pay
categories and writes the chosen **names** into `employmentHero.defaults`, plus
where each employee's pay rate comes from: the award classification (offered
once the award field is mapped) or their Connecteam pay rate. EH accepts these
only as a complete set, so "Skip" leaves the map untouched and payroll sets pay
in EH by hand (records stay `Incomplete`). One value applies to every employee
(per-employee settings: #75). Re-run it any time; Enter keeps the current
choice.

> **A default only fills a blank (#102).** These settings go on every new
> employee, and fill any that are blank on an existing one. They never replace
> a value EH already has. So a payroll admin can change one employee's pay
> schedule or location by hand in EH, and it stays changed after their next
> profile edit. It also means that changing a default here does **not** move
> existing employees. Change those in EH. The award classification and a
> Connecteam pay rate are different: they come from each employee's own
> Connecteam profile, and sync on every edit.

**Check the map while you tune it:**

```bash
npm run validate-field-map -- --client self
```

It checks only the map against the schema the Worker uses, and lists each
problem by path (for example `rules.taxDeclaration.claimTaxFreeThreshold:
Required`). The wizard's "Field map" stage runs it and loops until it passes.

`npm test` also fails on an invalid map, but use it as the final gate, not
while tuning: some tests load `clients/self/field-map.json` as a fixture
(`test/field-map-loader.test.ts` and the Worker tests in `test/worker/`), so an
unfinished map fails them as well, with unrelated output.

---

## 5. Cloudflare deploy

The wizard does all of this. Manual equivalent:

```bash
# Log in to the CLIENT's account
npx wrangler login
npx wrangler whoami          # confirm it's the right account

# Provision (one D1 database, two queues)
npx wrangler d1 create eh-payroll-sync
#   → add the returned id to .dev.vars as  D1_DATABASE_ID=<id>
npx wrangler queues create eh-payroll-sync-queue
npx wrangler queues create eh-payroll-sync-dlq

# Vars - in .dev.vars (git-ignored), NOT in wrangler.jsonc:
#   EH_BUSINESS_ID, CT_ONBOARDING_PACK_ID, CT_CUSTOM_PUBLISHER_ID,
#   ADMIN_CONNECTEAM_CHANNEL_ID; optional STATUS_DIGEST_DAY (blank = Monday),
#   INTEGRATOR_ALERT_URL, INTEGRATOR_CLIENT_ID. Then build the deploy config:
npm run deploy:config -- --check-live
npx wrangler d1 migrations apply eh-payroll-sync --remote --config wrangler.deploy.json

# Secrets
npx wrangler secret put CT_API_KEY --config wrangler.deploy.json
npx wrangler secret put EH_API_KEY --config wrangler.deploy.json
npx wrangler secret put CT_WEBHOOK_SECRET --config wrangler.deploy.json
# Optional: a dedicated bearer token for GET /status and POST /status/digest
# (see "Sync-status roster" below). Unset falls back to CT_WEBHOOK_SECRET.
npx wrangler secret put STATUS_TOKEN --config wrangler.deploy.json

# Verify, then deploy
npm run typecheck && npm test
npm run deploy
curl https://<worker>.workers.dev/health
```

### Where the deployment's values live

`wrangler.jsonc` is the **template**, the same for every client: its vars are
blank and its `database_id` is a placeholder. **Don't put real values in it,
and don't deploy it directly.** Each deployment's own values live in the
git-ignored `.dev.vars` (the wizard writes them; `D1_DATABASE_ID` is the
database). `npm run deploy` runs `scripts/deploy-config.ts`, which builds
`wrangler.deploy.json` (also git-ignored) from the two, then deploys that.

Why: values kept in the tracked `wrangler.jsonc` were silently reset to the
blank template by ordinary git use (a branch switch, a discard, a pull), and a
plain `wrangler deploy` then pushed blank settings and a dead database id to
the live Worker. A file git ignores can't be reset that way.

Before a deploy changes anything, `deploy:config --check-live` refuses when:

- `.dev.vars` is missing the database id or a required var (it names each);
- that database isn't on the Cloudflare account wrangler is logged in to
  (wrong account, or a stale id);
- the deploy would point the live Worker at a **different** database
  (`--allow-database-change` for a deliberate move).

It lists, without blocking, any setting the deploy would change on the live
Worker. A raw `npx wrangler deploy` of the template fails on its placeholder
`database_id`. Any other remote command that looks up the database by name
(`d1 migrations`, `d1 export`, `d1 execute`) also takes
`--config wrangler.deploy.json`.

The Worker's URL is a free `*.workers.dev` address by default — nothing to set
up. To serve it from the client's own domain instead, add a route / custom domain
in `wrangler.jsonc` (needs the domain on Cloudflare); the webhook URL in step 5
changes accordingly.

`/health` must return **`200`** with `d1: "ok"` and `fieldMap: "ok"`.
`config.fieldMapClient` should read `"self"`. The `ops` block is explained in
[Operations](#day-to-day-operations).

---

## 6. Register the Connecteam webhook

Needs the deployed URL, so it comes after deploy. The wizard does this in its
last stage; the manual equivalent is below.

**It must be done via the API, not the Connecteam UI.** The webhook's signing
secret (`secretKey`) can only be set through `POST /settings/v1/webhooks` — the
UI has no field for it — and the Worker rejects every delivery that arrives
without a matching secret with `401`. A UI-created webhook will therefore never
work.

```bash
set -a; source .dev.vars; set +a          # CT_API_KEY, CT_WEBHOOK_SECRET
curl -sS -X POST "https://api.connecteam.com/settings/v1/webhooks" \
  -H "X-API-KEY: $CT_API_KEY" -H "content-type: application/json" \
  -d '{
        "name": "EH Payroll Sync (profile updates)",
        "url": "https://<worker>.workers.dev/webhook",
        "featureType": "users",
        "eventTypes": ["user_updated"],
        "secretKey": "'"$CT_WEBHOOK_SECRET"'"
      }'
```

A `200` with `data.id` means it is registered. List them any time with
`GET /settings/v1/webhooks`; the webhook's `isDisabled` must be `false`.

**Register once.** A second `POST` adds a second webhook (each edit is then
delivered twice). To change the secret or turn it back on, update the existing
one instead:

```bash
curl -sS -X PUT "https://api.connecteam.com/settings/v1/webhooks/<id>" \
  -H "X-API-KEY: $CT_API_KEY" -H "content-type: application/json" \
  -d '{"secretKey": "'"$CT_WEBHOOK_SECRET"'", "isDisabled": false}'
```

The wizard does this for you on a re-run (#82). It keeps the secret already in
`.dev.vars`, updates a webhook that already points at the Worker instead of
adding one, and offers to delete any extras. A fresh clone has no
`.dev.vars`, so it generates a new secret. Its deploy pushes that to the Worker
and its webhook stage updates Connecteam to match. Between the two, a few
minutes apart, edits are rejected (`401`). Approvals are unaffected, because
the sweep doesn't use the webhook.

> **Confirm the first delivery.** The wizard's last stage prints the registered
> entry and then offers a live check: edit any mapped field on a test profile
> and it polls `/health` for ~90 s. `ops.webhookAccepted` going up means
> Connecteam is delivering and the signature verifies; `ops.webhookRejected`
> going up means a delivery arrived but its `secretKey` doesn't match
> `CT_WEBHOOK_SECRET` (re-run the wizard, or `PUT` the secret as above). Nothing after 90 s
> usually means a wrong URL, a disabled webhook, or an unmapped field — inspect
> with `npx wrangler tail --format pretty`.

> **Signature scheme (confirmed against a real delivery, #22).**
> Connecteam webhook `webhookVersion: 1` does **not** sign the body. It sends the
> registered `secretKey` verbatim in the **`x-webhook-secret`** header.
> `src/connecteam/signature.ts` `DEFAULT_SCHEME` reflects this
> (`mode: "shared_secret"`). An `hmac` mode is kept in that file for a future
> signed version; switching needs only a new `DEFAULT_SCHEME`, not route changes.

> **Delivery volume.** Connecteam fires one `user_updated` delivery **per changed
> field**, so a single profile edit arrives as a burst (you'll see several
> `202`s in the logs). The queue consumer coalesces a burst for one user into a
> single Sync — no duplicate messages or record writes.

---

## 7. Verify & go live

| Path | Test | Expected |
|---|---|---|
| Approval | Approve a test employee's Onboarding pack | They appear in Employment Hero within ~1 min (the sweep runs every minute). **On a first deploy, allow up to 15 min**: Cloudflare can take that long to start a new Cron Trigger. Until `ops.lastSweepOkAt` on `/health` shows a time, the sweep hasn't run yet; the wizard offers to wait for it |
| Edit | Change that employee's **Legal Surname** (or another synced custom field) in Connecteam | Their EH record updates (via the `user_updated` webhook — step 6). Don't test with the profile *First name*: it doesn't sync (see below) |
| Correction | Enter a deliberately bad BSB | The employee gets a **Correction message** from the custom publisher |
| Follow-up | Set a test employee to non-resident | A **Manual-follow-up notice** appears in the **alerts channel**; the Sync still completes |
| Incomplete | Sync an employee who has **no award / pay-run defaults** in EH | The record is created but EH marks it `Incomplete`; a **Manual-follow-up notice** ("a payroll admin needs to finish setup … pay-run defaults / award / pay rate") goes to the alerts channel — **not** to the employee. A payroll admin sets the award in EH; the record then reads `Complete`. |

> **EH uses the Legal First Name / Legal Surname. Changing the profile name
> doesn't change payroll.** The *First name* and *Last name* on a Connecteam
> profile are the employee's **preferred** name, and are deliberately not synced.
> EH's first name and surname come from the **Legal First Name** and **Legal
> Surname** custom fields (the ATO needs the legal name). Editing the profile
> name still fires the webhook, but leaves EH unchanged. That's expected, not a
> bug. To change a name in payroll, edit the Legal field.

`INTERNATIONAL` address and SMSF super (fund ABN, no USI) also produce a
Manual-follow-up notice. When several apply at once (e.g. a non-resident whose
record is also `Incomplete` for pay-run defaults) they are listed together in a
single notice.

> While a record stays `Incomplete`, every later profile edit re-runs the sync
> and would re-post the same notice. The channel gets it **once per ~12 hours per
> employee per reason-set** — a notice whose reasons actually change (e.g.
> non-resident newly added) still posts straight away, and the audit log
> (`sync_log`) still records every attempt.

> A non-resident for tax who *also* answered "yes" to the tax-free threshold is a
> contradiction EH rejects — the sync catches it first and sends the employee a
> Correction ("set that answer to No"), not a follow-up.

**Go live:** existing approved employees flow in over the next few minutes via the
sweep, throttled (~20/minute). Watch `/health` and the alerts channel. If
anything looks wrong, pause it with the **Emergency stop** (Day-to-day
operations, below) before investigating.

---

## 8. Grant the integrator scoped Cloudflare access (recommended)

So the integrator can diagnose and fix problems on the client's deployment
without a screen-share every time.

1. Cloudflare dashboard → **Manage Account → Members → Invite**.
2. Invite the integrator's Cloudflare email.
3. Role: **Workers Admin** (or a custom role limited to Workers Scripts, D1,
   Queues and Logs — nothing account-wide).
4. The client can change the role or **remove the member** at any time from the
   same page. It is the client's grant, not the integrator's ownership.

Without this, the only support routes are a screen-share or the client running
`scripts/update.sh` under instruction.

---

## 9. Optional: integrator telemetry

Off by default. When set, the Worker also sends the integrator a copy of each
**System alert** (deduped to once per employee per hour) and a once-a-day
`/health` summary, so the integrator learns about a problem before the client emails.

- `INTEGRATOR_ALERT_URL` (`wrangler.jsonc` var) — the deployed URL of the
  integrator's relay (`integrator-relay/` in this repo, deployed once by the
  integrator — see its README).
- `INTEGRATOR_ALERT_SECRET` (Cloudflare secret) — sent as `x-eh-sync-secret`;
  must equal the relay's `RELAY_SECRET`.
- `INTEGRATOR_CLIENT_ID` (`wrangler.jsonc` var) — a short slug for this client
  (e.g. `acme`); the relay keeps one GitHub issue per client keyed on it.

The payload is **ids, outcomes and counts only** — `{ kind: "system_alert",
client, ctUserId, reason, at }` or `{ kind: "health", client, ok, d1, fieldMap,
ops, at }` — and is passed through `src/redact.ts` regardless. Leave
`INTEGRATOR_ALERT_URL` blank to disable.

---

## Day-to-day operations

### Emergency stop

Use this when the sync is doing something wrong and must stop **now**: the wrong
person's record being written, bad values landing in EH, a flood of messages.
One command, run from the repo folder, logged in to the **client's** Cloudflare
account (check with `npx wrangler whoami` first; with access to several
accounts, wrangler asks which one):

```sh
npx wrangler queues pause-delivery eh-payroll-sync-queue
```

**What stops:** every EH write and every message the sync sends (Correction,
success, Manual-follow-up, System alert), within seconds. They all happen in
the queue consumer, and a paused queue delivers nothing to it.

**What keeps running, safely:** Connecteam webhooks and the approval sweep keep
adding jobs to the queue. Cloudflare holds them; nothing is lost while paused.
The daily recheck and the weekly digest still post to the alerts channel; both
only read EH. `/health` keeps answering, and `ops.queueBacklog` climbs as jobs
wait: that's expected while paused.

**Resume** once the cause is fixed. The held jobs then run in order:

```sh
npx wrangler queues resume-delivery eh-payroll-sync-queue
```

`ops.queueBacklog` on `/health` should fall back to `0` within a minute or two.

> **Resume within 4 days.** A held job still expires at the queue's message
> retention period, Cloudflare's default of 4 days. A profile edit that expired
> is caught up by the employee's next edit. A first-time **approval** that
> expired is not: the sweep recorded it when it queued the job and won't queue
> it again, so re-sync that employee by hand ("Re-syncing an employee" below).
> Never purge the queue (`wrangler queues purge`): it deletes the held jobs on
> the spot.

Verified on the demo deployment 2026-10-29 (pause and resume both took
effect). Holding and expiry are from Cloudflare's Queues docs.

### Monitoring — `GET /health`

| Field | Meaning | Watch for |
|---|---|---|
| `d1`, `fieldMap` | core config | anything other than `ok` |
| `ops.queueBacklog` | Sync jobs sent but not yet acked or dead-lettered | a number that only grows |
| `ops.deadLettered` | jobs that exhausted their retries | anything `> 0` |
| `ops.lastSweepOkAt` | ISO time the approval sweep last completed cleanly | more than a few minutes stale |
| `ops.webhookAccepted` | `user_updated` deliveries accepted (`202`) | still `0` long after go-live = the webhook isn't reaching the Worker |
| `ops.webhookRejected` | `user_updated` deliveries rejected (`401`) | anything `> 0` = a `secretKey` mismatch |
| `ops.ready` / `ops.waitingEmployee` / `ops.waitingAdmin` / `ops.broken` | sync-status roster counts — see below | `waitingAdmin` or `broken` staying above `0` for a while |

Full request / queue / sweep detail is in the Cloudflare **Workers Logs** for the
Worker — one JSON line per event, every line passed through `src/redact.ts` first.

### External health watch — GitHub Actions

`/health` is also polled every 10 minutes by
[`.github/workflows/health-watch.yml`](../.github/workflows/health-watch.yml),
running on GitHub's infrastructure rather than the client's Cloudflare account.
This exists because the Sync's own **System alert** is sent over Connecteam
chat — so a broken `CT_API_KEY` silently breaks the alert about itself too (this
happened for real: ~15h of failed sweeps with no notice, see §14 of the
deployment history). The workflow checks are independent of both `CT_API_KEY`
and `EH_API_KEY`, and a failed run emails whoever GitHub notifies on workflow
failures for the repo (check **Settings → Notifications → Actions** on
github.com).

It fails the run — and so sends the email — when any of:

- `/health` doesn't return `200` with `ok: true`
- `ops.lastSweepOkAt` is more than 15 minutes stale
- `ops.broken` is above `0`

Point it at a different deployment by setting the repository variable
`HEALTH_URL` (Settings → Secrets and variables → Actions → Variables); it
defaults to this client's `self` Worker URL otherwise.

### Sync-status roster — `GET /status`

A standing view of every employee the sync has ever touched, so an admin can
answer "is everyone I manage fully and correctly in EH, and if not, who and
why?" without opening EH per-person before a pay run.

```bash
curl -H "Authorization: Bearer $STATUS_TOKEN" https://<worker>.workers.dev/status
```

(`$STATUS_TOKEN` — or `$CT_WEBHOOK_SECRET` if `STATUS_TOKEN` was never set.)
Each entry is one of:

| State | Meaning |
|---|---|
| `ready` | Employment Hero reports the record `Complete` |
| `waiting_on_employee` | an open Correction cycle — `reasons` names the field(s), `cycleCount` counts attempts |
| `waiting_on_admin` | synced with safe defaults, but EH still needs a payroll admin to finish something by hand |
| `broken` | a job for this person dead-lettered — `reasons` carries the last error |

**Honest limit.** `ready` means EH **accepted** every value sent and reports the
record payroll-ready — not that the values are **truthful**. EH validates
format only; it never rejects a bad TFN at the API, it stores it and marks the
record `Incomplete` (see `CONTEXT.md` "Validation failure"). Human correctness
of the data stays a spot-check, not something this roster can guarantee.

A weekly digest of everyone **not** `ready` posts to the alerts channel
automatically (`STATUS_DIGEST_DAY`, default Monday, UTC) and on demand:

```bash
curl -X POST -H "Authorization: Bearer $STATUS_TOKEN" https://<worker>.workers.dev/status/digest
```

Silent but for a one-line "all clear" when everyone is `ready`. The on-demand
call answers `{"status":"sent","messages":N}`, or **502**
`{"status":"failed","sent":n,"messages":N}` if Connecteam didn't take a
message. Sending stops at the first failure, so nothing arrives with a gap;
re-run it once Connecteam is back. A failed weekly digest retries every 30
minutes for the rest of the digest day (UTC). The Worker logs
`message_send_failed` for each failure.

### The message types — who acts

| Message | Recipient | Action |
|---|---|---|
| **Correction message** | the employee (DM); + Direct manager on the 3rd failed attempt in a row | the employee fixes the named field(s) in Connecteam; **their next profile edit re-syncs** (see below) |
| **Manual-follow-up notice** | alerts channel | a payroll admin finishes the item in EH by hand — foreign / working-holiday-maker tax scale, add the SMSF, enter the overseas address, **or set the award / pay-run defaults for a record EH marked `Incomplete`** — re-posted at most once per ~12 h per employee per reason-set |
| **System alert** | alerts channel | check Employment Hero API status / credentials; once fixed, replay the dead-lettered job — re-posted at most once per hour per employee while the fault persists |
| **Identity-collision alert** | alerts channel | two Connecteam people's EH records got merged into one (see below) — separate them directly in EH; re-posted at most once per hour per employee while it persists |
| **Success message** | the employee (DM) | none. Sent once on their first successful sync, and once when a Correction is fixed (naming what was fixed). Off for a client with `"messages": { "employeeSuccess": false }` in `field-map.json`; on otherwise. Never sent for an ordinary edit |
| **Admin success notice** | alerts channel | none. A ✅ naming the employee at the same two moments as the Success message; skipped when the sync lands as a Manual follow-up. Off with `"adminSuccess": false`; on otherwise. **On go-live every existing employee syncs at once**, so for a large client set it to `false` for the first run and switch it on afterwards |

Every Correction message ends with where to fix it: "To fix: go to
**Profile > Personal Information** and update it." Profile sections are the
client's own choice, so set `"messages": { "profilePath": "..." }` in
`field-map.json` to match their app. A long Correction drops bullets ("...and
3 more") rather than losing that line.

Every message to a person (Correction, manager escalation, Success message)
ends: "This is an automated message from the Employment Hero sync." That
default suits any client; set `"messages": { "automatedNote": "..." }` for
their own wording, or `""` for none. Admin-channel messages don't carry it.

> **Identity-collision alert.** Employment Hero's unstructured-employee endpoint
> matches/merges by **Tax File Number**, not by the `externalId` this sync sends
> — so if two people ever share a TFN (a data-entry mistake, a placeholder value
> nobody replaced), the second person's sync silently lands on and overwrites
> the first person's EH record, and EH even relabels that record's `externalId`
> to the second person's id. Nothing about the write itself looks wrong to the
> sync — it only shows up because we separately track which Connecteam user
> already owns each EH employee id (`employee_map`). No employee action is
> possible; a payroll admin must check both people's records in EH directly.
> This never shows up in `/status` as `waiting_on_admin` — it surfaces as
> `broken`, the same bucket as a dead-lettered job.

### "I changed their name and payroll didn't update"
EH uses the **Legal** First Name / Legal Surname. Changing the profile name
doesn't change payroll. The profile *First name* is the employee's preferred
name and is not synced (`docs/field-mapping.md`). Edit the **Legal First Name**
or **Legal Surname** custom field instead; that edit syncs like any other.

### Re-syncing an employee
A resync is triggered by a **profile edit** in Connecteam (the `user_updated`
webhook, step 6) or by an onboarding pack reaching `completed` for the **first**
time (the sweep). It is **not** reliably triggered by un-approving and
re-approving a pack — the assignment does not dependably leave `status:
completed`, and the sweep only enqueues on the transition *into* `completed`. So
when a Correction message says "we'll sync again automatically", that depends on
the employee **editing their profile** — which is why step 6's webhook is
mandatory, not optional. To force a resync for an employee whose profile hasn't
changed, edit any field on their Connecteam profile (an identical re-save is
deduplicated and does nothing).

> **Edits before a pack is Approved never sync (by design).** The
> `user_updated` webhook fires on every field save, including mid-onboarding -
> before an employee has even submitted their pack for review. The sync
> silently ignores every one of these (no EH write, no message) until
> `onboarding_state` shows the pack reached `completed` at least once (see
> ADR-0002). Without this, someone filling out a dozen-plus fields one at a
> time would trigger a fresh Correction or Manual-follow-up on nearly every
> field, and every partial edit would land in EH before the record was ever
> meant to exist there.

### Replaying a dead-lettered job
A message on `eh-payroll-sync-dlq` has already raised a System alert. Before it got
there, the sync tried it 6 times over about 15.5 minutes (retries after 30 s,
1 min, 2 min, 4 min, 8 min; ADR-0007). So the cause outlasted a short blip:
check Employment Hero and Connecteam status, and the Worker logs for
`message_send_failed` or the retry reason. After fixing the cause, re-drive it
with `wrangler queues`, or re-trigger the source edit in Connecteam (edit the
profile; first-time pack approval). Nothing auto-retries a dead-lettered job.

### After an award review or a newly installed award

EH updates award classifications after a Fair Work review, and installing a
second award adds new ones. Copy them into the Connecteam dropdown:

```bash
npm run provision-classification-field -- --dry-run   # see what would be added
npm run provision-classification-field
```

It only adds classifications the dropdown is missing; it never creates a
second field and never changes an employee's existing pick. A renamed
classification arrives as a new option, so admins should move affected
employees to it.

### Rotating keys
`npx wrangler secret put CT_API_KEY --config wrangler.deploy.json` (likewise
`EH_API_KEY` / `CT_WEBHOOK_SECRET` / `STATUS_TOKEN`) with the new value, then
rotate the far side. Run `npm run deploy:config` first if `wrangler.deploy.json`
isn't there. A key kept locally for testing also lives in `.dev.vars`. `CT_WEBHOOK_SECRET`
must be updated on the Connecteam webhook registration at the same time.

---

## Updating the deployment

```bash
./scripts/update.sh
```

`git pull` → `npm ci` → `npm test` → `deploy:config --check-live` (see §5,
"Where the deployment's values live") → `wrangler d1 migrations apply --remote`
→ `wrangler deploy` → `/health` check. Fails loudly on any step; the check
stops it before anything on Cloudflare changes. Run by the client's
IT, or by the integrator on a support call. A non-technical owner should not run
this unaided.

---

## Tearing down / starting over

> **Deleting the Worker alone is not a reset.** Deleting `eh-payroll-sync` (in the
> dashboard or with `wrangler delete`) leaves its D1 database and both queues
> behind. A wizard re-run then says "Database already exists - reusing it", and
> the old `employee_map`, onboarding state and audit log carry over into what
> was meant to be a clean deployment. Delete everything below.

> **Check the account first.** These commands delete by name, and every
> deployment uses the same names. Run `npx wrangler whoami` and confirm it's the
> account you mean to clear, not one running a live Sync.

Two paths. **Starting over** (re-running the wizard on the same Connecteam and
Employment Hero accounts) is steps 1–7. **Removing for good** adds step 8.

1. **Back up the database (optional).** It holds ids, outcomes and audit rows
   only, never employee values, but it's the only history of who synced when:

   ```bash
   npm run deploy:config && npx wrangler d1 export eh-payroll-sync --remote --output=eh-payroll-sync-backup.sql --config wrangler.deploy.json
   ```

2. **Delete the Connecteam webhook first**, so Connecteam stops posting to a
   URL that's about to disappear. Find its id (the one whose `url` is this
   Worker's `/webhook`), then delete it. This is the same call the wizard uses
   to remove duplicates:

   ```bash
   curl -sS -H "X-API-KEY: $CT_API_KEY" https://api.connecteam.com/settings/v1/webhooks
   curl -sS -X DELETE -H "X-API-KEY: $CT_API_KEY" \
     https://api.connecteam.com/settings/v1/webhooks/<id>
   ```

   On a restart to the same URL the wizard would update a leftover webhook
   rather than add a second one, but a new deployment with a different URL
   would leave the old one posting to nothing.

3. **Disconnect the Worker from both queues.** Cloudflare refuses both
   deletes while the Worker is still attached (checked on a throwaway Worker
   and queues, 2026-10-04):
   - the Worker: "Cannot delete this Worker as it is a consumer for a Queue
     [code: 10064]"
   - the dead-letter queue: "Cannot delete queue 'eh-payroll-sync-dlq' that serves
     as dead letter queue for consumers [code: 11005]"

   So detach it first:

   ```bash
   npx wrangler queues consumer remove eh-payroll-sync-queue eh-payroll-sync
   npx wrangler queues consumer remove eh-payroll-sync-dlq eh-payroll-sync
   ```

   Until step 4, the cron can still add messages to the sync queue with
   nothing reading them. They go when the queue is deleted in step 5.

4. **Delete the Worker.** This also removes its secrets and its 1-minute cron.
   `--dry-run` first shows what it would do:

   ```bash
   npx wrangler delete eh-payroll-sync --dry-run
   npx wrangler delete eh-payroll-sync
   ```

5. **Delete both queues:**

   ```bash
   npx wrangler queues delete eh-payroll-sync-queue
   npx wrangler queues delete eh-payroll-sync-dlq
   ```

6. **Delete the D1 database.** This is the step that makes it a real reset,
   and it **cannot be undone**:

   ```bash
   npx wrangler d1 delete eh-payroll-sync
   ```

   A wizard re-run creates a fresh database and writes its id into
   `.dev.vars` (`D1_DATABASE_ID`). On the manual path, replace it yourself (§5).
   The next deploy would otherwise stop, saying the database isn't on the account.

7. **The GitHub health watch.** `.github/workflows/health-watch.yml`
   polls `/health` every 10 minutes and emails on failure, so once the Worker
   is gone it fails every run. For a restart, leave it: it recovers once the
   new deployment answers on the same URL (or set the `HEALTH_URL` repository
   variable to the new one). For good, disable it: GitHub → **Actions → Health watch →
   ⋯ → Disable workflow**.

8. **Removing for good only:**
   - **API keys:** revoke the Connecteam API key (Integrations → API Keys,
     §2a) and the Employment Hero API key (My Account → Security → API Key,
     §3). On a restart, keep them, or rotate them as
     in [Rotating keys](#rotating-keys).
   - **Integrator access:** Cloudflare → **Manage Account → Members** →
     remove the integrator (see §8).
   - **Integrator telemetry:** tell the integrator, so they close this
     client's issue on the relay. The relay itself is shared; leave it.
   - **Local files:** delete `.dev.vars` and any `setup-wizard-*.log` (they
     can name the client's accounts), or the whole clone.

**Leave these in Connecteam either way:** the custom fields (they hold the
employees' own data), the custom publisher and the alerts channel. The wizard
reuses them on a restart. Deleting them is the client's decision, not part of a
teardown.

---

## What is never stored or logged

No employee value — tax file number, bank BSB / account number / name, super
member number — is ever written to D1 or to a log:

| Sink | Holds |
|---|---|
| `employee_map` | Connecteam userId ↔ EH employee id, timestamps, failure-cycle count, a payload **hash** |
| `onboarding_state` | assignment id, userId, status, `isWaitingApproval`, seen-at |
| `sync_log` | userId, time, outcome, and a `detail` string of field **NAMES** + status only |
| `sync_meta` | counters and a "last sweep ok" timestamp |
| `console` logs | routed through `src/redact.ts`, which drops anything under a sensitive key |
| integrator telemetry | ids, outcomes, counts only (see §9); redacted regardless |

---

## Appendix A — Porting to a non-Cloudflare host

v1 is Cloudflare-only. The Worker binds directly to four Cloudflare primitives; a
port replaces each:

| Cloudflare primitive | Used for | Port target needs |
|---|---|---|
| **Workers** | the HTTP handler + `queue()` + `scheduled()` handlers | any serverless runtime with an HTTP entrypoint, a queue consumer hook, and a cron hook |
| **D1** (SQLite) | `employee_map`, `onboarding_state`, `sync_log`, `sync_meta` | any SQL database; rewrite `src/db/store.ts` (drizzle) and the `migrations/` runner |
| **Queues** | the Sync pipeline: retry, backoff, dead-letter → System alert | a managed queue (SQS, QStash, Pub/Sub) with a DLQ, or the "D1 job table drained by cron" pattern discussed during design |
| **Cron Triggers** (`* * * * *`) | the 1-minute approval sweep | any 1-minute scheduler |

`src/sync/consumer.ts` (`runSyncJob`, `handleDeadLetter`), `src/sync/*`,
`src/mapping/*`, `src/eh/*`, `src/connecteam/*` and `src/webhook/*` are
platform-agnostic and carry over unchanged — only `src/index.ts`, `src/db/store.ts`,
`wrangler.jsonc` and the test harness are Cloudflare-shaped. Estimate a
multi-week effort; there is no client demand for it yet.
