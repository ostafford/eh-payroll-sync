# Field mapping: Connecteam → EH Payroll

Source: Connecteam custom fields (pack `5474`) + top-level user fields.
Target: EH Payroll `AuUnstructuredEmployeeModel`, business `555455` (client will differ).
Match key: EH `externalId` = Connecteam `userId` (string). First match may fall back to email.
Read-back: `GET /api/v2/business/{businessId}/employee/unstructured/externalid/{externalId}`.

## Value shapes coming from Connecteam

- `dropdown` → `[{ "id": n, "value": "Text" }]` — take `[0].value`
- `date` / `birthday` → `"DD/MM/YYYY"` string → convert to ISO `YYYY-MM-DD`
- `location` → `{ address, latitude, longitude, zipcode? }` — use `.address`
- `directManager` → `int` (a Connecteam `userId`)
- `str` → string

## Business context for `create` (per-deployment config, NOT code)

| Config key | This account | How the client finds theirs |
|---|---|---|
| `EH_BUSINESS_ID` | `555455` | `GET /api/v2/business` |
| `CT_ONBOARDING_PACK_ID` | `5474` | `GET /onboarding/v1/packs` |
| employing entity | none (single-entity) | `GET /business/{id}/employingentity` |

Pay schedule and location are **not** deployment vars. If a flat-rate workforce
opts into `employmentHero.defaults` (issue #26), the schedule and location go
there **by name**; `GET /business/{id}/payschedule` and
`GET /business/{id}/location` list the names. `field-map.json` also keeps the
numeric `payScheduleId` / `locationId` as optional reference — `discover.ts`
fills them in but nothing reads them.

## Mapping

| Connecteam field | id | EH Payroll field | Transform / rule |
|---|---|---|---|
| Legal First Name | 42920713 | `firstName` | legal name (ATO). Connecteam top-level `firstName` = preferred, **not synced, by decision: payroll uses the legal name** (#70), unless the field picker is told the client's profile names are legal names (`userField: "firstName"`) |
| Legal Surname | 42920714 | `surname` | legal name (ATO). Connecteam top-level `lastName` is not synced, same reason and same exception (`userField: "lastName"`) |
| Birthday | 25145118 | `dateOfBirth` | DD/MM/YYYY → ISO |
| Gender | 25145119 | `gender` | Male/Female → EH enum; Other → `Indeterminate`, which EH stores as **blank** (see below) |
| `email` (top-level) | — | `emailAddress` | |
| `phoneNumber` (top-level) | — | `mobilePhone` | already E.164 (`+61…`) |
| Street Address | 25145120 | `residentialStreetAddress` | `.address` up to first comma; fragile — candidate for a dedicated "line 1" field |
| Suburb | 42920715 | `residentialSuburb` | |
| State | 42920838 | `residentialState` | direct; INTERNATIONAL → hold + correction message |
| Postcode | 42923224 | `residentialPostCode` | string; zero-pad to 4 |
| Country | 42920716 | `residentialCountry` | "Australia" → "AU"; else lookup |
| — | — | *(no postal fields sent)* | EH has no "same as residential" flag; omitting postal is accepted |
| Emergency Contact Name | 42708535 | `emergencyContact1_Name` | |
| Emergency Contact Number | 42708537 | `emergencyContact1_ContactNumber` | |
| Emergency Contact Relationship | 42708536 | `emergencyContact1_Relationship` | |
| Employment Start Date | 25145109 | `startDate` | DD/MM/YYYY → ISO |
| Title | 25145108 | `jobTitle` | |
| Employee Status | 42920839 | `employmentType` | 1:1 — FullTime / PartTime / Casual / LabourHire |
| Direct manager | 25145114 | *(not synced)* | used only for correction-cycle escalation (3rd cycle) |
| Employee ID | 42920893 | *(not used)* | externalId = Connecteam userId |
| Employee Type | 42921224 | *(informational)* | Employee / Contractor |
| Pay Type | 42921208 | *(not synced)* | Hourly / Salaried — superseded by `perEmployeeRate` (issue #42): `rate` + `rateUnit` come from the pay-rates API |
| *(pay-rates API, per user)* | — | `rate`, `rateUnit` | opt-in `employmentHero.perEmployeeRate` — `GET /pay-rates/v1/pay-rates`; `defaultRate` → `rate`, `rateType` `hourly`→`Hourly` / `yearly`→`Annually` / `monthly`→`Monthly` (all confirmed) |
| Standard hours/week *(custom field, per client)* | — | `hoursPerWeek` | optional; text or number field, `number` transform. Only shipped when the full pay-run set resolves. Picked (or skipped) in the field picker (#118) |
| TFN | 42923222 | `taxFileNumber` | string; keep leading zeros. **EH does NOT reject a bad TFN via the API** — it stores it and the record stays `Incomplete`. Catch this via the Incomplete status, not a 400. |
| Claim tax-free threshold? | 42923276 | `claimTaxFreeThreshold` | Yes → true |
| Australian resident for tax purposes? | 42923315 | `australianResident` | Yes → true; No → false + manual follow-up (EH has no `isNonResident`; tax scale / WHM is a payroll decision) |
| Have a HELP/STSL study debt? | 42923316 | `helpDebt` **and** `stslDebt` | one combined Yes/No → both flags (over-report is harmless, under-report under-withholds) |

A client whose tax questions use their own wording (e.g. `Yes, claim tax free
threshold | No | N/A | TBC`) gets an `options` map on that `rules.taxDeclaration`
entry (#112): `{ "customFieldId": 61, "options": { "Yes, claim tax free threshold": "yes", "No": "no" } }`.
With `options`, only the listed answers count; any other answer (`N/A`, `TBC`,
even a plain `Yes`) is held for a Correction message. The wizard's field picker
writes it.

## Leaving employees out by choice (`rules.exclude`)

Some answers mean an employee isn't paid through payroll at all, e.g. the first
client's Employee Status `PBV`. Those are listed in `rules.exclude`:
`[{ "customFieldId": 42920839, "values": ["PBV"] }]`. The sync then skips anyone
with that answer before mapping: no EH record, no Correction, no admin notice.
It records them once as `excluded` (the field name only, never the answer), and
the status digest shows a count: "⚪ Left out by choice: 3 (Employee Status: PBV)".
Someone already in EH who changes to an excluded answer keeps their EH record;
it just stops being updated. Picked in the field check (Employee Status only).

"Not synced" is different: the employee *is* meant to be in EH, so they're sent
a Correction naming their answer ("You answered "TBC" to "Claim Tax Free
Threshold?". Employment Hero needs a Yes or No answer…") and their record waits
until they change it.
| Name on Bank Account | 42921173 | `bankAccount1_AccountName` | |
| BSB | 42923223 | `bankAccount1_BSB` | string; zero-pad to 6 |
| Account Number | 42921172 | `bankAccount1_AccountNumber` | |
| Payment Method | 42921174 | `bankAccount1` payment method | "Bank Details" → Electronic; PBV → ignored (unknown) |
| — | — | `bankAccount1_AllocatedPercentage` | `100` (single account) |
| Super Fund USI | 42920803 | `superFund1_ProductCode` | EH calls the USI the "product code". **USI present → APRA path** |
| Member Number | 42920804 | `superFund1_MemberNumber` | required on the APRA path |
| Super Fund Name | 42920782 | `superFund1_FundName` | |
| Super Fund ABN | 42920783 | *(not sent)* | USI blank + ABN present → **SMSF → do NOT sync super**, manual follow-up to the admin channel |

## Data quality resolved

- TFN / BSB / Postcode changed from `number` to `str` in Connecteam (2026-08-30).
- Tax-free-threshold / residency / HELP-debt fields added to the pack (2026-08-30).
- Employee Status values aligned to EH `employmentType` enum (2026-08-30).

## Verified against the live EH Payroll API (issue #2, 2026-08-30)

- Validation failures are **HTTP 400** with `{ "message": "Field: reason\nField: reason" }` — not 422, not a ModelState dict. `parseValidationBody` handles this shape.
- Create → **201** `{ id, status, detailedStatus, operationType }`; update (PUT) → **200** same envelope. Neither returns the employee — read back with GET.
- `GET .../employee/unstructured/externalid/{id}` → **404** when absent.
- Field name corrections applied: `mobilePhone` (not `mobileNumber`), `residentialPostCode` (capital C), `superFund1_ProductCode` (not `_USI`), `helpDebt`+`stslDebt` (not `hasHelpDebt`), no `isNonResident` field.
- **A bad TFN is accepted (200)** and the record stays `Incomplete` — never a 400.
- EH has no `isPostalAddressSameAsResidential`; omitting postal fields is fine.

## Gender (issue #55, probed 2026-10-03)

Throwaway employees created on the unstructured endpoint, read back, deleted:

| Sent `gender` | Create | Stored |
|---|---|---|
| `Male` / `Female` | 201 | `Male` / `Female` |
| `Indeterminate`, `X`, `Other`, `I`, `Unknown`, nonsense | 201 | `null` |

EH's API keeps only `Male` and `Female`; anything else is accepted and silently
left blank, with no error. So "Other" reaches EH as no gender recorded. The map
keeps `Other → Indeterminate` because the sync rejects a dropdown option the map
doesn't list (it would send the employee a Correction message).

## Verified against the live Connecteam Onboarding API (issue #7, 2026-08-31)

- Onboarding-pack states map to the assignment API exactly as `CONTEXT.md` says:
  **Ready for review & approval** = `status: in_progress` + `isWaitingApproval: true`;
  **Approved** = `status: completed` + `isWaitingApproval: false`.
- **Un-approve moves the assignment back to `status: in_progress`** (the
  "Ready for review & approval" bucket) — it does *not* stay `completed`.
  So a re-approve is a clean `in_progress → completed` transition, which
  `diffAssignments` (src/cron/sweep.ts) already treats as a fresh approval.
  Observed live: `in_progress/true → completed/false → in_progress/true`.

## Still to verify

- Whether `user_updated` fires (and is signed) on custom-field edits — needs a live webhook (issue #3 / #8).
