/**
 * The details the link stage asks about (#230): each unit (ADR-0009) where
 * the mapped Connecteam pack and EH's bulk-list record disagree, so the admin
 * picks **Keep EH's** or **Use Connecteam's** before the Baseline is taken.
 * Pure. Names only, never a value (ADR-0001): what's compared stays in memory.
 *
 * A group EH needs sent whole is one choice, named with the fields in it that
 * differ ("Residential address (Postcode)"): Use Connecteam's sends all of it.
 * The pay-run set is never asked about: the stage doesn't read pay rates, and
 * it's baselined at the link without being sent.
 *
 * Each side is put in the form EH's bulk list (`/employee/unstructured`)
 * holds it in before comparing (#232), so a detail that differs only in
 * format isn't asked about. The forms come from the demo's list.
 */
import { UNIT, unitsOf } from "../../src/sync/baseline.js";
import { fieldLabel, groupLabel } from "../../src/sync/labels.js";
import type { FieldMap } from "../../src/mapping/schema.js";

export interface DifferingDetail {
  /** The unit the choice is for: a group's name, or the EH field's own. */
  unit: string;
  /** EH's on-screen label for it. */
  label: string;
  /** EH's on-screen labels of the fields in it that differ. */
  fields: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

/** Compared as EH shows them: case and spacing aside, and a date without its time. */
function comparable(v: unknown): string {
  const s = v === undefined || v === null ? "" : String(v).trim().replace(/\s+/g, " ").toLowerCase();
  return ISO_DATE.test(s.toUpperCase()) ? s.slice(0, 10) : s;
}

/** A field's value as EH's bulk list holds it (#232), so a format-only difference compares equal. */
type Form = (v: unknown) => string;

/**
 * Country names EH's bulk list holds for the codes Connecteam sends. Only
 * AU is confirmed on the demo (`AU` mapped, `Australia` in EH).
 */
const COUNTRY_NAME: Record<string, string> = { au: "australia", aus: "australia" };
const COUNTRY_CODE = /^[a-z]{2,3}$/;

/**
 * Whether two countries differ, or `false` when they can't be compared: a
 * code against a name, with the code not in {@link COUNTRY_NAME} (`NZ`
 * against `New Zealand`, or EH's `UK` against `United Kingdom`). Leaving
 * one out keeps EH's, the default, so nothing wrong is sent. Two codes, two
 * names, or a country against none compare as they are.
 */
function countryDiffers(ct: unknown, eh: unknown): boolean {
  const named = (v: unknown) => COUNTRY_NAME[comparable(v)] ?? comparable(v);
  const [a, b] = [named(ct), named(eh)];
  if (a === "" || b === "" || COUNTRY_CODE.test(a) === COUNTRY_CODE.test(b)) return a !== b;
  return false;
}

/**
 * A phone number as digits, an Australian one from 0: Connecteam sends
 * `+61…`, EH's list holds that, `61…`, or the local form it was typed in,
 * spaced or not. A `(0)` after the country code is dropped, as dialled.
 */
const phone: Form = (v) => {
  const s = comparable(v).replace(/\(0\)/g, "");
  const digits = s.replace(/\D/g, "");
  const au = digits.match(/^(?:0061|61)(\d{9})$/);
  if (au && (s.startsWith("+") || digits.startsWith("00") || digits.length === 11)) return `0${au[1]}`;
  return s.startsWith("+") ? `+${digits}` : digits;
};

/** Spaces aside: Connecteam's `FullTime` is EH's `Full Time`. */
const unspaced: Form = (v) => comparable(v).replace(/ /g, "");

/**
 * A number EH's list holds bare (BSB, account number, USI), so spaces and
 * dashes are formatting: Connecteam's USI comes spaced in groups.
 */
const bare: Form = (v) => comparable(v).replace(/[\s-]/g, "");

/** A BSB is six digits: one returned as a number has lost its leading zeros. */
const bsb: Form = (v) => (typeof v === "number" ? String(v).padStart(6, "0") : bare(v));

/** The fields EH returns in its own form; any other is compared with {@link comparable}. */
const FORM: Record<string, Form> = {
  mobilePhone: phone,
  homePhone: phone,
  emergencyContact1_ContactNumber: phone,
  employmentType: unspaced,
  bankAccount1_BSB: bsb,
  bankAccount1_AccountNumber: bare,
  superFund1_ProductCode: bare,
};

function differs(field: string, ct: unknown, eh: unknown): boolean {
  // An object or array has no text form to compare: left out, not listed.
  if ((typeof ct === "object" && ct !== null) || (typeof eh === "object" && eh !== null)) return false;
  if (field === "residentialCountry") return countryDiffers(ct, eh);
  const form = FORM[field] ?? comparable;
  return form(ct) !== form(eh);
}

export function differingDetails(
  payload: Record<string, unknown>,
  ehRecord: Record<string, unknown>,
  map: Pick<FieldMap, "rules">,
): DifferingDetail[] {
  const out: DifferingDetail[] = [];
  for (const [unit, values] of Object.entries(unitsOf(payload, map))) {
    if (unit === UNIT.payRun) continue;
    // A field EH's list doesn't hold can't be compared: not asked about.
    const differ = Object.keys(values).filter((f) => f in ehRecord && differs(f, values[f], ehRecord[f]));
    if (differ.length === 0) continue;
    out.push({ unit, label: groupLabel(unit) ?? fieldLabel(unit), fields: differ.map(fieldLabel) });
  }
  return out;
}
