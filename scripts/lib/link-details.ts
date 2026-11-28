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

/** A blank against a value is a difference whatever the field: EH, or Connecteam, has none. */
const eitherBlank = (a: string, b: string) => a === "" || b === "";

const differsAfter =
  (normalise: Normalise): Differs =>
  (ct, eh) =>
    normalise(ct) !== normalise(eh);

/**
 * Country names EH's bulk list holds for the codes Connecteam sends. Only
 * AU is confirmed on the demo (`AU` mapped, `Australia` in EH).
 */
const AUSTRALIA = "australia";
const COUNTRY_NAME: Record<string, string> = { au: AUSTRALIA, aus: AUSTRALIA };
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
  if (eitherBlank(a, b) || COUNTRY_CODE.test(a) === COUNTRY_CODE.test(b)) return a !== b;
  return a === AUSTRALIA || b === AUSTRALIA;
};

/** A phone number read as `phoneAu` reads it, and whether it was written in a local form, with no country. */
interface ReadPhone {
  e164: string;
  local: boolean;
}

/**
 * A phone number in the form the field map sends one in, `phoneAu`'s E.164
 * (`+61…`), so both mean the same by "the same AU number". EH's list holds
 * that, `61…`, a local form, or an international one dialled from Australia
 * (`0011…`), spaced or not. `""` when blank; `null` when it can't be read:
 * not something `phoneAu` takes (13, 1300 and 1800 numbers among them), or
 * an Australian number that isn't 9 digits after `+61`.
 */
function readPhone(v: unknown): ReadPhone | "" | null {
  const s = comparable(v);
  if (s === "") return "";
  const dialled = s.replace(/^0011\s*/, "+").replace(/^00\s*/, "+");
  let e164: string;
  try {
    e164 = phoneAu(dialled);
  } catch {
    return null;
  }
  if (e164.startsWith("+61") && !/^\+61\d{9}$/.test(e164)) return null;
  return { e164, local: !dialled.startsWith("+") && !/^61/.test(dialled) };
}

/**
 * Two numbers compare as `phoneAu` reads them. Left out, not listed, when
 * either can't be read, or when an overseas number meets a local form:
 * `phoneAu` reads `021 …` as Australian, but it may be the same NZ number.
 * A number against none is listed.
 */
const phoneDiffers: Differs = (ct, eh) => {
  const [a, b] = [readPhone(ct), readPhone(eh)];
  if (a === null || b === null) return false;
  if (a === "" || b === "") return a !== b;
  const overseas = (p: ReadPhone) => !p.local && !p.e164.startsWith("+61");
  if ((a.local && overseas(b)) || (b.local && overseas(a))) return false;
  return a.e164 !== b.e164;
};

/** Spaces aside: Connecteam's `FullTime` is EH's `Full Time`. */
const unspaced: Normalise = (v) => comparable(v).replace(/ /g, "");

/**
 * A number EH's list holds without separators (BSB, account number, USI):
 * spaces and dashes are formatting. Connecteam's USI comes spaced in groups.
 */
const unseparated: Normalise = (v) => comparable(v).replace(/[\s-]/g, "");

/** A BSB is six digits: a shorter one (returned as a number, or typed so) has lost its leading zeros. */
const bsb: Normalise = (v) => {
  const s = unseparated(v);
  return /^\d{1,5}$/.test(s) ? s.padStart(6, "0") : s;
};

/**
 * An account number's length varies, so one returned as a number can't get
 * its leading zeros back: compare both without them. Two strings compare in full.
 */
const accountNumberDiffers: Differs = (ct, eh) => {
  const [a, b] = [unseparated(ct), unseparated(eh)];
  if (eitherBlank(a, b) || (typeof ct !== "number" && typeof eh !== "number")) return a !== b;
  return a.replace(/^0+/, "") !== b.replace(/^0+/, "");
};

/**
 * The fields EH returns in its own form; any other is compared with
 * {@link comparable}. Checked on the demo and left to it, as they match
 * once case, spacing and a date's time are set aside: names, email, gender,
 * dates, job title, street address, suburb, state, postcode, emergency
 * contact name and relationship, account name, fund name and member
 * number. The TFN wasn't compared on the demo; it's mapped to bare digits,
 * the 9-digit form EH's list holds.
 */
const DIFFERS: Record<string, Differs> = {
  residentialCountry: countryDiffers,
  mobilePhone: phoneDiffers,
  homePhone: phoneDiffers,
  emergencyContact1_ContactNumber: phoneDiffers,
  employmentType: differsAfter(unspaced),
  bankAccount1_BSB: differsAfter(bsb),
  bankAccount1_AccountNumber: accountNumberDiffers,
  superFund1_ProductCode: differsAfter(unseparated),
};

function differs(field: string, ct: unknown, eh: unknown): boolean {
  // An object or array has no text form to compare: left out, not listed.
  if ((typeof ct === "object" && ct !== null) || (typeof eh === "object" && eh !== null)) return false;
  return (DIFFERS[field] ?? differsAfter(comparable))(ct, eh);
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
    const differing = Object.keys(values).filter((f) => f in ehRecord && differs(f, values[f], ehRecord[f]));
    if (differing.length === 0) continue;
    out.push({ unit, label: groupLabel(unit) ?? fieldLabel(unit), fields: differing.map(fieldLabel) });
  }
  return out;
}
