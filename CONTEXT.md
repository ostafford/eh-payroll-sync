# eh-payroll-sync

A reusable integration **template** that syncs employee-entered details (personal, contact, and payroll-sensitive: TFN, bank, super) from Connecteam into Employment Hero Payroll, so staff enter their details once (in Connecteam) rather than twice. Deployed once per client — each client gets an isolated Cloudflare Worker, D1, domain, and credential set; all client-specific values (IDs, field map) are external config, never code.

## Language

**EH** / **Employment Hero Payroll**:
The sync target. Specifically the Employment Hero Payroll product (formerly KeyPay / "payroll classic"), AU region — API base `https://api.yourpayroll.com.au/api/v2`, API-key auth, business identified by `businessId`.
_Avoid_: "Employment Hero" unqualified, EH HR platform, `api.employmenthero.com`, KeyPay (legacy name)

**Connecteam**:
The system of record where employees enter their own details. Source of the sync. Data lives in user profile fields (built-in + custom fields) and Onboarding packs.

**Sync**:
One-way propagation of an employee's details from Connecteam to EH, triggered by a Connecteam webhook. EH never writes back to Connecteam; the only return signal is a correction message (see Correction message).

**Employee record**:
The person's record in EH Payroll. Created or updated by the sync. Can exist in EH in an **Incomplete** state.

**Incomplete** (EH employee status):
EH Payroll's own status for an employee record that was created with less than the data EH needs to be payroll-ready. Minimum fields to create at all: first name, surname, start date, employment type, tax file number.

**Validation failure**:
The condition that triggers a correction message. Covers: EH rejects the write (**HTTP 400** with a `{ message: "Field: reason" }` body — e.g. a malformed BSB), or the resulting employee record stays **Incomplete**. Note EH does *not* reject a bad TFN at the API — it stores it and the record stays Incomplete, so a wrong TFN surfaces only through the Incomplete status, not a 400. The user's phrase "checksum verifies it's incorrect" refers to this whole condition.
_Avoid_: checksum, 422

**Correction message**:
One of the outbound message types. Sent to the **employee** who entered bad data (data that failed EH validation), as a DM from the Connecteam **custom publisher**. On the third failed Correction cycle it also goes to the employee's Direct manager.
_Avoid_: notification, alert

**Manual-follow-up notice**:
Second message type. Posted to the admin **channel**. For data that synced fine but needs a payroll admin to finish something in EH by hand: non-resident / working-holiday-maker tax scale, SMSF super, `INTERNATIONAL` address. The sync still completes with a safe default.

**System alert**:
Third message type. Posted to the admin **channel**. For failures the employee cannot fix — EH outage, auth failure, bugs — raised when a queue message dead-letters.

**Success message**:
Fourth message type (issue #71). A one-off DM to the **employee**: once on their first successful sync ("received in Employment Hero"), and once when a Correction cycle is fixed, naming what the Correction asked about ("your bank details have now been updated in Employment Hero"). Never on an ordinary edit, and never claims the record is Complete. Per client: `messages.employeeSuccess` in `field-map.json` (on unless set to `false`).

**Admin success notice**:
The admin-channel twin of the Success message: a ✅ naming the employee at the same two moments, so an admin sees each new hire land. Not posted when the sync lands as a Manual follow-up (that notice says the sync completed). Per client: `messages.adminSuccess` in `field-map.json` (on unless set to `false`).
_Avoid_: confirmation, receipt

**Custom publisher**:
A Connecteam feature: a named non-human sender that the API can post chat messages as.

**Onboarding pack**:
A Connecteam Onboarding-feature assignment for one user, with fields split between user-completed and admin-completed. Every user always has one. States, and how the Onboarding API represents each:
- **In Progress** — `status: in_progress`, `isWaitingApproval: false`
- **Ready for review & approval** — `status: in_progress`, `isWaitingApproval: true`
- **Approved** (admin clicked "Approve Onboarding") — `status: completed`

The initial EH sync for a person fires when their assignment first reaches `status: completed`, detected by a 1-minute cron poll of the Onboarding API diffed against stored state (there is no approval webhook — see ADR-0002). After approval, further profile-field edits sync via the `user_updated` webhook.

**Correction cycle**:
One attempt to sync a user that ended in a Validation failure, plus the resulting Correction message. Cycles for a user do not auto-retry — the next attempt only happens when the user edits their Connecteam data again. First two cycles message the employee only; the third also messages their direct manager. The counter resets on a successful sync.

**Payroll ID** / **External ID**:
EH Payroll's `externalId` field on an employee (shown in the EH UI as "Payroll ID"). The sync sets it to the Connecteam `userId` and uses it as the cross-system match key. Email is only a fallback for the very first match.

**In-scope fields**:
Everything the employee can enter in the onboarding pack: personal, address, emergency contact, structural fields EH needs (name, start date, employment type, job title), **and** tax file number, bank account(s), superannuation, and tax-declaration answers. All flow Connecteam → EH via the API — no EH self-setup (see ADR-0001). Pay rate / award / classification stay a manual EH task for v1.

**EH self-setup**:
EH Payroll's `initiateselfservice` wizard. Considered and rejected — see ADR-0001. Not used.

**Rehearsal deployment**:
A second, independent clone-and-deploy of this repo — its own Cloudflare
Worker/D1/queues, its own brand-new Connecteam and Employment Hero accounts —
used to walk the setup wizard and `RUNBOOK.md` exactly as a real client would,
before ever running them with an actual client. Kept running afterward,
reusable for the next feature or client rather than torn down after one use.
See ADR-0006.
_Avoid_: staging, sandbox, test environment (too generic — this specifically
means rehearsing the client-facing *setup* flow from scratch, not just a place
to run automated tests)
