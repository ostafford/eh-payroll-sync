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
 * format isn't asked about. The forms come from the demo's list; the test
 * fixture `eh-bulk-employee.json` keeps its shapes with made-up values.
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

/**
 * A field's value in one form for both sides (#232), or `null` when the two
 * can't be compared reliably: then the field isn't asked about, rather than
 * listed as different. Keep EH's is the default, so leaving one out sends
 * nothing wrong.
 */
type Form = (v: unknown) => string | null;

/**
 * Country names EH's bulk list holds for the codes Connecteam sends. Only
 * AU is confirmed on the demo (`AU` mapped, `Australia` in EH): any other
 * code against a name can't be compared, so it's left out.
 */
const COUNTRY_NAME: Record<string, string> = { au: "australia" };
const COUNTRY_CODE = /^[a-z]{2,3}$/;

const country: Form = (v) => {
  const s = comparable(v);
  if (!COUNTRY_CODE.test(s)) return s;
  return COUNTRY_NAME[s] ?? null;
};

/**
 * A phone number as digits, an Australian one from 0: Connecteam sends
 * `+61…`, EH's list holds either that or the local form it was typed in,
 * spaced or not.
 */
const phone: Form = (v) => comparable(v).replace(/[^\d+]/g, "").replace(/^\+61/, "0");

/** Spaces aside: Connecteam's `FullTime` is EH's `Full Time`. */
const unspaced: Form = (v) => comparable(v).replace(/ /g, "");

/**
 * A number EH's list holds bare (BSB, account number, USI), so spaces and
 * dashes are formatting: Connecteam's USI comes spaced in groups.
 */
const bare: Form = (v) => comparable(v).replace(/[\s-]/g, "");

/** The fields EH returns in its own form; any other is compared with {@link comparable}. */
const FORM: Record<string, Form> = {
  residentialCountry: country,
  mobilePhone: phone,
  homePhone: phone,
  workPhone: phone,
  emergencyContact1_ContactNumber: phone,
  emergencyContact1_AlternateContactNumber: phone,
  employmentType: unspaced,
  bankAccount1_BSB: bare,
  bankAccount1_AccountNumber: bare,
  superFund1_ProductCode: bare,
};

function differs(field: string, ct: unknown, eh: unknown): boolean {
  const form = FORM[field] ?? comparable;
  const [a, b] = [form(ct), form(eh)];
  return a !== null && b !== null && a !== b;
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
