# Connecteam → Employment Hero field checklist

Every Connecteam field the integration reads, what it becomes in Employment Hero
(EH), and how to fix it when it's missing. Use it to check a client's Connecteam
account before setup, and as the reference for the wizard's field check.

**Key**

| | Meaning |
|---|---|
| 🔴 **Required** | The sync can't create the EH employee without it. The employee gets a Correction message asking them to fill it in. |
| 🟡 **Recommended** | The sync still works, but the EH record has a gap a payroll admin may have to fill by hand. |
| 🔵 **Admin-only** | Filled in by an admin, not the employee. |
| ⚪ **Not synced** | Read by the integration for its own logic, never sent to EH. |

> **Field names are flexible.** The names below are from the demo account.
> A client's fields can be called anything. The *field map* records which
> client field matches which EH field. What matters is that each piece of
> information is collected **somewhere in the onboarding pack**.

---

## 🪪 Identity

| | Connecteam field | Type | → EH field | Why EH needs it |
|---|---|---|---|---|
| 🔴 | Legal First Name | Text | First name | Legal name for the ATO, not the preferred name |
| 🔴 | Legal Surname | Text | Surname | Legal name for the ATO |
| 🔴 | Birthday | Date | Date of birth | Tax and super eligibility |
| 🟡 | Gender | Dropdown: Male / Female / Other | Gender | EH only records Male or Female, so `Other` is left blank in EH |
| 🟡 | *Email* (built into the profile) | — | Email | Payslips; no custom field needed |
| 🟡 | *Phone number* (built into the profile) | — | Mobile | No custom field needed |

> **Legal name, not profile name.** EH's first name and surname come from the
> **Legal First Name** and **Legal Surname** fields. The *First name* on the
> Connecteam profile is the employee's **preferred** name and is deliberately
> not synced, so changing it doesn't change payroll (#70).

## 🏠 Address

| | Connecteam field | Type | → EH field | Why EH needs it |
|---|---|---|---|---|
| 🟡 | Street Address | Location | Street address | Residential address for payroll records |
| 🟡 | Suburb | Text | Suburb | |
| 🟡 | State | Dropdown | State | `INTERNATIONAL` holds the sync and asks the employee to correct it |
| 🟡 | Postcode | Text | Postcode | Leading zeros are kept (e.g. `0800`) |
| 🟡 | Country | Location | Country | Blank is sent as `AU` |

## 💼 Employment

| | Connecteam field | Type | → EH field | Why EH needs it |
|---|---|---|---|---|
| 🔴 | Employment Start Date | Date | Start date | First pay run and leave accrual |
| 🔴 | Employee Status | Dropdown: FullTime / PartTime / Casual / LabourHire | Employment type | Options must match these four **exactly** |
| 🟡 | Title | Text | Job title | |

## 🚨 Emergency contact

| | Connecteam field | Type | → EH field |
|---|---|---|---|
| 🟡 | Emergency Contact Name | Text | Emergency contact 1: name |
| 🟡 | Emergency Contact Number | Text | Emergency contact 1: number |
| 🟡 | Emergency Contact Relationship | Text | Emergency contact 1: relationship |

## 🧾 Tax

| | Connecteam field | Type | → EH field | Why EH needs it |
|---|---|---|---|---|
| 🔴 | TFN | Text | Tax file number | EH **accepts an invalid TFN** but marks the record `Incomplete` |
| 🟡 | Claim tax-free threshold? | Yes / No | Tax-free threshold | Sets the withholding rate |
| 🟡 | Australian resident for tax purposes? | Yes / No | Australian resident | `No` sends a follow-up to the admins (tax scale is a payroll decision) |
| 🟡 | Have a HELP/STSL study debt? | Yes / No | HELP **and** STSL debt | One answer sets both flags |

## 🏦 Bank

| | Connecteam field | Type | → EH field |
|---|---|---|---|
| 🟡 | Name on Bank Account | Text | Bank account 1: name |
| 🟡 | BSB | Text | Bank account 1: BSB (zero-padded to 6 digits) |
| 🟡 | Account Number | Text | Bank account 1: account number |

One account only, set to 100% and paid electronically.

## 🦘 Super

| | Connecteam field | Type | → EH field | Why EH needs it |
|---|---|---|---|---|
| 🟡 | Super Fund USI | Text | Super fund 1: product code | A USI means an APRA fund, which syncs automatically |
| 🟡 | Member Number | Text | Super fund 1: member number | Required when a USI is given |
| 🟡 | Super Fund Name | Text | Super fund 1: fund name | |
| ⚪ | Super Fund ABN | Text | *(not sent)* | ABN with **no** USI means an SMSF. Super isn't synced, and the admins get a follow-up |

## 🎓 Award

| | Connecteam field | Type | → EH field | Why EH needs it |
|---|---|---|---|---|
| 🔵 | EH Pay Rate Template | Dropdown, **admin-only** | Pay rate template | Without it the EH record stays `Incomplete`. The options are imported from EH, never typed by hand (see below) |

## ⚪ Not synced

| Connecteam field | Used for |
|---|---|
| Direct manager | Gets a copy of the Correction message on an employee's 3rd failed attempt |

**Total:** 28 custom fields (27 plus the award dropdown), plus email and phone from the profile. The wizard creates any of the 27 that are missing (`npm run create-fields`, #55) and the award dropdown in its own stage.

---

## 🩺 Field check: what each result means and how to fix it

The wizard's field check (`npm run field-check`, its "Connecteam field check"
stage) reads the client's Connecteam fields and gives each one a result. A 🔴
required field that is missing, the wrong type or not yet picked stops the
wizard until it is fixed; everything else is a warning.

Just before it, the field picker (`npm run pick-fields`) shows which of the
client's fields was matched to each one. A client's field can have any name: if
the check didn't recognise it, pick it there. Choices are saved by field ID in
`clients/self/field-picks.json`.

| Result | Meaning | Why it matters | How to fix |
|---|---|---|---|
| ✅ **Found** | The field exists, is the right type, and is in the onboarding pack | — | Nothing to do |
| ❌ **Missing** | No matching field in Connecteam | 🔴 required: every employee gets a Correction message and isn't created in EH. 🟡 recommended: the EH record has a gap Create it with `npm run create-fields` (the wizard's Connecteam custom fields stage), then **add it to the onboarding pack** |
| ❌ **Not in the pack** | The field exists but is excluded from the onboarding pack | Employees are never asked for it, so it's always blank | Open the onboarding pack's settings in Connecteam and include the field |
| ⚠️ **Wrong type** | E.g. Birthday is a text field instead of a date | The value can't be converted, so the sync rejects it | Connecteam can't change a field's type, only rename or delete it. Create a new field of the right type, include it in the pack, and delete or rename the old one |
| ❌ **More than one match** | Two of the client's fields could be it, e.g. a new one and an old one not renamed `(OLD)` | The sync won't guess which one employees fill in | Pick one with `npm run pick-fields` |
| ❌ **Picked field deleted** | The field chosen earlier no longer exists | The sync can't read a deleted field | Pick another with `npm run pick-fields` |
| ➖ **Skipped** | An optional field the person running the wizard chose not to use. Super is all four fields or none: skipping one skips all four (#117) | The EH record has a gap a payroll admin fills in by hand (with super skipped, every employee's super) | Nothing, or pick a field with `npm run pick-fields` (remove its entry from `field-picks.json` to be asked again) |
| ⚠️ **Dropdown options don't match** | E.g. Employee Status has `Full time` instead of `FullTime` | EH rejects anything it doesn't recognise. 🔴 Blocks on a required field (Employee Status) | Map each option to an EH value, or to "not synced" (the employee gets a Correction message), with `npm run pick-fields`. Or rename the options in Connecteam to the exact values above |
| ⚠️ **Editable by employees** | The award field can be edited by the employee | An employee could pick their own pay classification | Set the field to admin-only |
| ⚠️ **No answers yet** | The field exists, but nobody has filled it in | Not an error for new fields. Existing approved employees will sync with this gap | Ask existing employees to complete the field, then re-approve |

Two of these can't be checked automatically, so the wizard reminds you instead:
**Not in the pack** (Connecteam's API doesn't say which fields a pack includes)
and **No answers yet** (that would mean reading employees' answers).

---

## 🎓 Award setup (wizard stage)

Connecteam has no idea awards exist; EH does. The integration bridges this:

1. **The client installs their award(s) in EH.** This is a payroll decision, so it stays manual.
2. **The wizard checks** that EH has at least one award classification, and stops with a clear message if there are none.
3. **The wizard imports every classification** into a Connecteam admin-only dropdown (`npm run provision-classification-field`), and the Pay-run settings stage maps it.
4. **Admins pick each employee's classification** in Connecteam. The integration never chooses one.

**When an award changes in EH** (a new award, or an award review), re-run the
import. It only adds new classifications and never changes an employee's
existing selection:

```
npm run provision-classification-field
```
