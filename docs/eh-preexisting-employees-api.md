# EH Payroll API: listing, matching and Payroll-ID-only writes (issue #131)

Research for the Pre-existing-employee flow (map #130): employees entered by
hand in EH (no `externalId`) whose Connecteam packs are awaiting approval. On
approval the sync's create path (`upsertByExternalId`: GET by externalId finds
nothing, so it POSTs `/employee/unstructured`) lets EH match and merge them,
overwriting the hand-entered record.

Each claim is labelled:

- **tested**: seen live on the rehearsal deployment's EH account (ADR-0006),
  using only `GET` calls, on 2026-11-05. Only response shapes and counts were
  recorded, never names, emails or TFNs. Or verified earlier by this repo's
  own write probes, with the doc cited.
- **docs-only**: stated by EH's API reference, not checked live.

## Sources

- **EH Payroll AU API reference (Swagger 2.0):** UI at
  `https://api.yourpayroll.com.au/swagger/index.html`, spec at
  `https://api.yourpayroll.com.au/swagger/docs/AU` (downloaded 2026-11-05,
  ~1.9 MB, 497 paths). Operation names below are the spec's `operationId`s.
- **EH (KeyPay) usage guide:** `https://api.keypay.com.au/guides/Usage`
  (rate limit).
- **This repo's earlier probes:** [`eh-complete-criteria.md`](./eh-complete-criteria.md)
  (#45, the TFN-merge caveat), [`eh-pay-defaults.md`](./eh-pay-defaults.md)
  (#26/#102, partial PUT updates), commit `46b3a4b` / issue #52 (the
  identity-collision incident).

## TL;DR

1. **List:** yes. `GET /employee/unstructured` returns every field, including
   the **full, unmasked TFN**, paged with `$top` (100 max) and `$skip`. It
   supports OData `$filter`, which works on `emailAddress` (case-insensitive),
   `taxFileNumber`, and `firstName`/`surname`. **tested**
2. **Payroll ID only:** there's no dedicated endpoint. Use
   `PUT /employee/unstructured/{id}` with `{ "externalId": "…" }`; EH says
   omitted fields are left unchanged. Don't use POST for this, because POST
   runs EH's matching. **docs-only** for an externalId-only body. The partial
   PUT behaviour itself is **tested** (#102).
3. **Partial update:** omitted fields **and `""` blanks are kept**. To clear a
   field you must send `"(clear)"` or `"0"`. **tested** for omitted fields and
   `""` on pay-run fields; **docs-only** for `(clear)` and for bank, super and
   address blocks.
4. **TFN merge:** POST only, and only when no `id` is passed. The default
   `matchType=Standard` matches on **TFN first, then firstName + surname +
   dateOfBirth + emailAddress**. `matchType=None` turns matching off.
   **docs-only**, plus the TFN half was **tested** by accident in #52.

**Surprises that change the design** (details at the end): a `matchType=None`
switch exists; there's a second match key besides TFN (name + DOB + email);
EH apparently doesn't match on ATO placeholder TFNs; and `externalId` isn't
guaranteed unique (the GET-by-externalId endpoint documents a `300`).

---

## 1. Listing and searching employees

### Endpoints

| Endpoint | What it returns | Paging | Label |
|---|---|---|---|
| `GET /business/{b}/employee/unstructured` (`AuEmployee_GetEmployees`) | Full `AuUnstructuredEmployeeModel` per employee (145 keys live): `id`, `externalId`, `firstName`, `surname`, `emailAddress`, `dateOfBirth`, `taxFileNumber`, `status`, `startDate`, bank, super, etc. | `$top` defaults to 100 and **max 100** (`$top=101` gives `400 "The maximum value for $top is 100"`); `$skip` for later pages | **tested** |
| `GET /business/{b}/employee/details` (`Employee_GetEmployeeDetails`) | "Basic details" subset (26 keys): `id`, `externalId`, names, `dateOfBirth`, `emailAddress`, addresses, phones, `startDate`, `endDate`. **No `taxFileNumber`, no `status`.** | `$top`/`$skip` work; `$top=101` was **not** rejected here | **tested** |
| `GET /business/{b}/employee/unstructured/externalid/{externalId}` | One employee, or `404` | — | **tested** (404). The spec also documents a **`300`** response: **docs-only** |
| `GET /business/{b}/report/employeedetails` | Report with chosen columns, `includeActive` / `includeInactive` | — | **docs-only**, not needed |

The spec recommends `/employee/details` as "much more efficient" when basic
fields are enough (**docs-only**).

### Fields needed to match against Connecteam

- **email, first/last name, date of birth, externalId:** present on both list
  endpoints. **tested**
- `dateOfBirth` comes back as `YYYY-MM-DDT00:00:00` (shape seen:
  `9999-99-99T99:99:99`). **tested**
- **TFN is NOT masked.** `/employee/unstructured` returns the full 9-digit
  TFN (every record's TFN had the shape "9 digits", with no `*`). `/employee/details`
  leaves TFN out entirely. **tested.** So a full listing pulls every
  employee's TFN, bank and super details into the Worker. That's allowed under
  ADR-0001, but nothing from the listing may be logged or stored (redact).

### Search (OData `$filter`, unstructured endpoint)

| Filter | Result | Label |
|---|---|---|
| `emailAddress eq '<email>'` | exactly the 1 matching employee | **tested** |
| same email upper-cased | still matched, so the comparison is **case-insensitive** | **tested** |
| `emailAddress eq '<unknown>'` | `200 []` | **tested** |
| `taxFileNumber eq '<tfn>'` | exactly the employees holding that TFN | **tested** |
| `taxFileNumber eq '000000000'` (nobody holds it) | `200 []`, so the filter is applied, not ignored | **tested** |
| `firstName eq '…' and surname eq '…'` | 1 match | **tested** |
| `status eq 'Active'` | works | **tested** |
| `externalId eq null` / `externalId eq ''` | `200 []`, but every rehearsal employee already has an externalId, so this **doesn't prove** a null filter works | inconclusive |

On `/employee/details`, `$filter` on `id` and on `externalId` works, but
**`$filter` on `emailAddress` returns `500 Internal Server Error`** (3
variants tried). **tested.** Search by email on the unstructured endpoint
instead.

### Rate limit

5 requests per second per API key per IP (**docs-only**, KeyPay usage guide).
A burst of ~10 back-to-back GETs got `429 "API rate limit exceeded."`
(**tested**). For ~180 employees, a listing is 2 pages; a per-employee
filtered lookup needs throttling. The existing `httpJson` already treats a 429
as retryable.

## 2. Setting only the Payroll ID (`externalId`)

- **There's no dedicated endpoint.** No path in the AU spec writes only
  `externalId`, and there's no PATCH anywhere in the spec. **docs-only**
  (whole spec searched)
- **`PUT /employee/unstructured/{employeeId}`** (`AuEmployee_PutEmployee`):
  > "Only fields to be updated need be specified. Fields left unspecified or
  > null will not be changed. To update a field provide the new value, to
  > specifically clear a value use the string "(clear)" or "0"."

  So `PUT …/unstructured/{id}` with `{ "externalId": "<connecteamUserId>" }`
  should set only the Payroll ID. **docs-only** for this exact body. Partial
  PUTs leaving other fields untouched is **tested** (§3).
- **`POST /employee/unstructured` with `{id, externalId}`:** the spec says
  "If an ID is passed … it will be updated", but it doesn't say whether POST
  is also partial. The repo's #45 probe found that a POST which TFN-matched an
  existing record **merged** (omitted fields not cleared). **tested**
  ([`eh-complete-criteria.md`](./eh-complete-criteria.md)), though only on
  the TFN-match path. **Use PUT, not POST, for the link:** PUT addresses
  exactly one id and never runs the matcher.
- **Open questions for the write test:** whether a link-only PUT on a record
  that's itself Incomplete or has odd data gets a `400` for its **existing**
  fields (EH may validate the whole record on any write), and whether
  `status` / `detailedStatus` change. The client already handles a 400 as
  `validation`.
- **Uniqueness:** GET-by-externalId documents a `300 Multiple Choices`
  response, which suggests EH **doesn't enforce unique `externalId`s**.
  **docs-only**; the rehearsal account has no duplicates. Before linking,
  check that no other EH employee already holds that externalId (one GET; a
  404 means it's free). `httpJson` would classify a 300 as `client_error`.

## 3. Partial update in general (the "changed since link" push)

- **Omitted fields are kept on PUT.** Spec text above (**docs-only**), plus
  **tested** in [`eh-pay-defaults.md`](./eh-pay-defaults.md) (#102): a
  name-only PUT left every pay-run value unchanged, and PUTs with only
  `paySchedule` or only `payRateTemplate` returned `200` and changed only
  those.
- **An empty string does NOT clear.** `paySchedule: ""` returned `200` and was
  **ignored** (**tested**, #102). To clear a field you must send `"(clear)"`
  (or `"0"`) (**docs-only**). This matters for "push only changed fields": if
  an employee blanks a field in Connecteam, sending `""` silently leaves EH's
  old value in place.
- **Not yet verified:** whether multi-field groups (`bankAccount1_*`,
  `superFund1_*`, the residential address) behave per field or as a block.
  For example, does sending only `bankAccount1_AccountNumber` keep the BSB,
  account name and `AllocatedPercentage`? The pay-run set is all-or-nothing
  on **create** but per-field on update (#102). Other groups are
  **docs-only**.
- The create-path rule "a partial pay-run set is a 400" doesn't apply to an
  update of a record that already has the set (**tested**, #102). A partial
  pay-run update to a record **without** a set is untested (assume 400).

## 4. When the unstructured endpoint matches by TFN

From the spec's `AuEmployee_Post` description (**docs-only**):

> "If an ID is passed or an existing employee is matched (according to the
> matchType parameter), it will be updated. Otherwise a new employee will be
> created."
> MatchType: **Standard (default)**: attempts to match an existing employee -
> first, based on the tax file number, then based on first name + surname +
> date of birth + email address. **None**: do not attempt to match an existing
> employee (create a new one).

The query parameter is `matchType`, enum `["None", "Standard"]`, default
`Standard`.

- **POST only.** PUT addresses an explicit id. **docs-only**
- **With `id` given:** the record with that `id` is updated. The spec reads as
  if the `id` wins and no matching runs, but it doesn't say so outright.
  **docs-only**, part of write test B.
- **Without `id`, default `matchType`:** the TFN match is **tested**. In #52
  two Connecteam users shared a checksum-valid placeholder TFN, and the second
  POST merged into the first EH record and relabelled its `externalId`
  (commit `46b3a4b`).
- **Second key: firstName + surname + dateOfBirth + emailAddress.** A
  pre-existing employee whose hand-entered TFN differs from the onboarding TFN
  (a typo, or entered later) can **still be merged** through this key.
  **docs-only**
- **ATO placeholder TFNs don't seem to match.** On the rehearsal account, 7
  employees with distinct emails and externalIds share the ATO "under 18" code
  `333333333` (an invalid checksum) and weren't merged. **tested as observed
  state, not as a controlled write.** Likely explanation: EH skips the TFN
  match for placeholder or invalid TFNs and falls through to the
  name + DOB + email key. Confirm with test B.
- **Not known:** whether `Terminated` employees are candidates for matching
  (the rehearsal account has only Active employees).

So the **pre-create check must mirror both keys**:
`$filter=taxFileNumber eq '<tfn>'` and
`$filter=firstName eq '…' and surname eq '…' and dateOfBirth eq … and emailAddress eq '…'`
(the TFN and email/name filters are **tested** individually; the combined
filter with a `dateOfBirth` literal isn't). Alternatively, do one listing and
match locally.

---

## Write tests for a human to approve (rehearsal EH account only)

All on throwaway `ZZZTEST-131-*` employees, deleted afterwards. Use fresh
checksum-valid TFNs each run, because `DELETE` doesn't free a TFN
synchronously (#45). Snapshot each record with
`GET /employee/unstructured/{id}` before and after every write, and diff all
keys (print key names only, never values).

**Test A: link-only and partial PUT (questions 2 and 3)**

1. `POST /employee/unstructured?matchType=None` a "hand-entered" employee
   with no `externalId`: firstName, surname, startDate, employmentType, TFN,
   DOB, email, residential address, `bankAccount1_*` (BSB, number, name,
   100%), `superFund1_*`. Note `id`.
2. `PUT /employee/unstructured/{id}` with `{ "externalId": "zzztest-131-a" }`.
   Expect `200`, and the diff shows only `externalId` changed (and `status`
   unchanged).
3. `PUT` with `{ "mobilePhone": "<new>" }`. Expect only `mobilePhone` changed.
4. `PUT` with `{ "bankAccount1_AccountNumber": "<new>" }`. Do BSB, name and
   percentage survive?
5. `PUT` with `{ "residentialSuburb": "" }`, then with
   `{ "residentialSuburb": "(clear)" }`. Expect the first to be ignored and
   the second to clear it.
6. `DELETE /employee/{id}`.

**Test B: matching (question 4)**

1. Create `A` with `POST ?matchType=None` and a valid TFN `T1`, no externalId.
2. `POST` (default matchType) a different person (other name, DOB, email)
   with TFN `T1` and `externalId: zzztest-131-b`. Expect `200` (not `201`),
   the same `id` as A, and A relabelled. This re-confirms the TFN key.
3. `POST` with a new valid TFN `T2` but A's exact firstName + surname + DOB +
   email. Does it return A's `id`? (second key)
4. `POST ?matchType=None` with TFN `T1` again. Does EH create a duplicate
   (`201`, new id) or reject a duplicate TFN (`400`)?
5. `POST` with `id: <A>` plus another existing test employee's TFN. Does it
   update A (id wins) or the TFN holder?
6. `POST` two different people with `333333333` (default matchType). Do you
   get two ids? (placeholder skipped)
7. Optional: terminate A, then repeat step 3. Are terminated employees
   matched?
8. `DELETE` every id created.

Total: about 15 writes. Run them against the rehearsal account only.

## Surprises that change the design

1. **`matchType=None` exists** (**docs-only**). The sync's create path can
   switch EH's silent merge off entirely: `upsertByExternalId` would POST with
   `?matchType=None` and rely on its own pre-create check. The failure mode
   then changes from silently overwriting a hand-entered record to creating a
   visible duplicate (or a 400, see test B4). It also removes the #52
   identity-collision class at the source. The collision detector is still
   worth keeping.
2. **The match isn't TFN-only** (**docs-only**). With the default
   `Standard`, name + DOB + email is a second merge key, so a TFN-only
   pre-check misses some merges. Check both keys, or use `matchType=None`.
3. **Placeholder TFNs probably don't match** (observed state). Employees
   onboarded with `111111111` / `333333333` etc. fall through to the
   name + DOB + email key. That's another reason not to trust a TFN-only check.
4. **`externalId` may not be unique** (documented `300`). The link step should
   confirm that the Connecteam userId isn't already on another EH record.
5. **Listing exposes full TFNs.** Match on `/employee/details` (no TFN) where
   possible, and use the unstructured `$filter=taxFileNumber eq …` lookup for
   just the one TFN being checked. Don't hold a whole-business TFN list.
6. **`""` doesn't clear on update** (tested). A "changed fields only" push has
   to send `"(clear)"` when an employee empties a field.

## Write test results (#135, 2026-11-05, rehearsal account, **tested**)

These ran on throwaway `Zztest` employees. TFNs had valid checksums and were checked as unused first. All 7 employees were deleted afterwards (DELETE 200).

**Test A: link-only and partial PUT**

| Step | Result |
| --- | --- |
| A1 `POST ?matchType=None` | 201; status `Incomplete`, `externalId` null |
| A2 `PUT {externalId}` | 200. Changed only `externalId` **and `leaveYearStart`** (null → the start date: EH fills a default on save). Status unchanged; nothing else re-validated or cleared. |
| A3 `PUT {mobilePhone}` | 200; only `mobilePhone` changed |
| A4 `PUT {bankAccount1_AccountNumber}` alone | **400**: "Account Name / BSB / Allocated Percentage is required if any bank account details are supplied". The bank account is written as a **whole group**: a partial bank write is rejected, though nothing changes. |
| A5a `PUT {residentialSuburb: ""}` | 200; ignored (unchanged) |
| A5b `PUT {residentialSuburb: "(clear)"}` | 200, but **does not clear**. EH treated "(clear)" as a suburb and re-resolved the address (suburb → "CAPE CLEAR", plus state and postcode changed). **Never send `"(clear)"` to address fields.** |

**Test B: matching**

| Step | Result |
| --- | --- |
| B2 default POST, other person + A's TFN | 200, **A's id**: A relabelled (`externalId`) and its name overwritten. The TFN merge is confirmed. |
| B3 default POST, A's name + DOB + email, new TFN | 200, **A's id**. The second merge key is confirmed. |
| B4 `matchType=None` + duplicate TFN | **201, new id**. EH creates a duplicate rather than rejecting it. |
| B5 POST `id`=A + another employee's TFN | 200, A's id; the other employee unchanged. **`id` wins over TFN.** |
| B6 two default POSTs with `333333333` | 201 + 201, distinct ids. The placeholder TFN isn't a match key. |
| B7 terminated employees | Not testable through the API: `PUT {endDate}` → 400 "A termination reason must be provided", and adding `terminationReason` didn't satisfy it. **Filters tested in #141 (below), using the EH UI to terminate.** Whether a *default* create merges into a terminated employee is still untested, and no longer matters (ADR-0010 always sends `matchType=None`). |

**Design consequences**
- Linking: `PUT /employee/unstructured/{id}` with only `externalId` is safe. Expect `leaveYearStart` to be filled if it was empty.
- The "changed since link" push must send **whole groups** (at least bank account 1, which is all-or-nothing). Treat address the same way, since EH re-resolves it.
- Clearing a field: there's no safe general way. `""` is ignored and `"(clear)"` breaks addresses.
- `matchType=None` turns the silent overwrite into a **visible duplicate**, so the pre-create check is what prevents duplicates.

## Terminated employees and the filters (#141, 2026-11-05, rehearsal account, **tested**)

Probe: [`scripts/probe-eh-terminated-filters.sh`](../scripts/probe-eh-terminated-filters.sh), read-only unless `--delete`, run from the rehearsal clone. It prints counts and ids, never a TFN.

**Method.** The integrator created a throwaway employee in the EH UI with fake details (Zztest Terminated, `zztest.terminated@example.com`, a checksum-valid TFN that `--precheck` confirmed unused). DOB was saved as 1990-07-18. The probe ran with the employee **Active** (the control), then again after the integrator **terminated** them in the EH UI (end date 2026-11-05). Then the employee was deleted (DELETE 200), and `--precheck` confirmed nothing matches.

| Lookup (`GET /employee/unstructured`) | Active | Terminated |
| --- | --- | --- |
| `$filter=emailAddress eq '…'` | found | **found** |
| `$filter=taxFileNumber eq '…'` | found | **found** |
| `$filter=firstName eq '…' and surname eq '…' and dateOfBirth eq datetime'1990-07-18T00:00:00'` | found | **found** |
| same, bare `dateOfBirth eq 1990-07-18` | found | **found** |
| `$filter=firstName eq '…' and surname eq '…'` | found | **found** |
| unfiltered list (`$top=100`, `$skip`) | included | **included** |

- **Terminated employees are returned by every filter and by the plain list.** The row carries `status: "Terminated"` and `endDate`.
- **A `dateOfBirth` literal works in a filter**, in both forms, and is really applied: the same filters with the wrong DOB (1990-01-01) returned `[]`.

**Design consequences**
- The Pre-create check (ADR-0010) catches rehires with its three filters, with no extra call. The Existing-match notice reads "terminated in EH" from the returned row's `status`.
- Name + DOB can be one EH filter. There's no need to fetch by name and compare the DOB locally.
- The link list's EH side (#132) includes terminated employees from the plain list, as #132 assumed.

