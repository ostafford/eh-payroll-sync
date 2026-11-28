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
import { phoneAu } from "../../src/mapping/transforms.js";

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

/** One value put in the form EH's bulk list holds it in (#232), so a format-only difference compares equal. */
type Normalise = (v: unknown) => string;

/** Whether a mapped Connecteam value and EH's differ; `false` too when the two can't be compared reliably. */
type Differs = (ct: unknown, eh: unknown) => boolean;

const byForm =
  (normalise: Normalise): Differs =>
  (ct, eh) =>
    normalise(ct) !== normalise(eh);

/**
 * Country names EH's bulk list holds for the codes Connecteam sends. Only
 * AU is confirmed on the demo (`AU` mapped, `Australia` in EH).
 */
const COUNTRY_NAME: Record<string, string> = { au: "australia", aus: "australia" };
const COUNTRY_CODE = /^[a-z]{2,3}$/;

/**
 * Two codes, two names, or a country against none compare as they are. A
 * code against a name is compared only when one side is Australia, the one
 * name with known codes: `NZ` against `Australia` differs. Any other pair
 * (`NZ` against `New Zealand`, or EH's `UK` against `United Kingdom`) can't
 * be compared, so it's left out: Keep EH's is the default, so nothing wrong
 * is sent.
 */
const countryDiffers: Differs = (ct, eh) => {
  const named = (v: unknown) => COUNTRY_NAME[comparable(v)] ?? comparable(v);
  const [a, b] = [named(ct), named(eh)];
  if (a === "" || b === "" || COUNTRY_CODE.test(a) === COUNTRY_CODE.test(b)) return a !== b;
  return a === "australia" || b === "australia";
};

/**
 * A phone number in the form the field map sends a mobile in: `phoneAu`'s
 * `+61…`, so both mean the same by "the same AU number". EH's list holds that,
 * `61…`, or the local form it was typed in, spaced or not. A `(0)` after the
 * country code is dropped, as dialled, whether typed in or left in by
 * `phoneAu`. A number `phoneAu` can't read (an overseas one without its `+`,
 * or in its local form) is compared as digits, so it may still be listed.
 */
const phone: Normalise = (v) => {
  const s = comparable(v).replace(/\(0\)/g, "").replace(/^00/, "+");
  try {
    return phoneAu(s).replace(/^\+610(?=\d{9}$)/, "+61");
  } catch {
    return s.replace(/\D/g, "");
  }
};

/** Spaces aside: Connecteam's `FullTime` is EH's `Full Time`. */
const unspaced: Normalise = (v) => comparable(v).replace(/ /g, "");

/**
 * A number EH's list holds without separators (BSB, account number, USI):
 * spaces and dashes are formatting. Connecteam's USI comes spaced in groups.
 */
const unseparated: Normalise = (v) => comparable(v).replace(/[\s-]/g, "");

/** A BSB is six digits: one returned as a number has lost its leading zeros. */
const bsb: Normalise = (v) => (typeof v === "number" ? String(v).padStart(6, "0") : unseparated(v));

/**
 * An account number's length varies, so one returned as a number can't get
 * its leading zeros back: compare both without them. Two strings compare in full.
 */
const accountNumberDiffers: Differs = (ct, eh) => {
  const [a, b] = [unseparated(ct), unseparated(eh)];
  if (typeof ct !== "number" && typeof eh !== "number") return a !== b;
  return a.replace(/^0+/, "") !== b.replace(/^0+/, "");
};

/** The fields EH returns in its own form; any other is compared with {@link comparable}. */
const DIFFERS: Record<string, Differs> = {
  residentialCountry: countryDiffers,
  mobilePhone: byForm(phone),
  homePhone: byForm(phone),
  emergencyContact1_ContactNumber: byForm(phone),
  employmentType: byForm(unspaced),
  bankAccount1_BSB: byForm(bsb),
  bankAccount1_AccountNumber: accountNumberDiffers,
  superFund1_ProductCode: byForm(unseparated),
};

function differs(field: string, ct: unknown, eh: unknown): boolean {
  // An object or array has no text form to compare: left out, not listed.
  if ((typeof ct === "object" && ct !== null) || (typeof eh === "object" && eh !== null)) return false;
  return (DIFFERS[field] ?? byForm(comparable))(ct, eh);
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
