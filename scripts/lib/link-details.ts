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

/**
 * Whether a mapped Connecteam value and EH's differ, both non-blank; `false`
 * too when the two can't be compared reliably. A blank against a value is
 * settled before one is called (see {@link differs}).
 */
type Differs = (ct: unknown, eh: unknown) => boolean;

const differsAfter =
  (normalise: Normalise): Differs =>
  (ct, eh) =>
    normalise(ct) !== normalise(eh);

/** Any field without its own form: case, spacing and a date's time aside. */
const plainDiffers = differsAfter(comparable);

/**
 * Country names EH's bulk list holds for the codes Connecteam sends. Only
 * AU is confirmed on the demo (`AU` mapped, `Australia` in EH).
 */
const AUSTRALIA = "australia";
const COUNTRY_NAME: Record<string, string> = { au: AUSTRALIA, aus: AUSTRALIA };
const COUNTRY_CODE = /^[a-z]{2,3}$/;

/**
 * Two codes or two names compare as they are. A code against a name is
 * compared only when one side is Australia, the one name with known codes:
 * `NZ` against `Australia` differs. Any other pair (`NZ` against `New
 * Zealand`, or EH's `UK` against `United Kingdom`) can't be compared, so it's
 * left out: Keep EH's is the default, so nothing wrong is sent.
 */
const countryDiffers: Differs = (ct, eh) => {
  const named = (v: unknown) => COUNTRY_NAME[comparable(v)] ?? comparable(v);
  const [a, b] = [named(ct), named(eh)];
  if (COUNTRY_CODE.test(a) === COUNTRY_CODE.test(b)) return a !== b;
  return a === AUSTRALIA || b === AUSTRALIA;
};

/** A phone number as `phoneAu` reads it, and whether it was written in a local form, with no country. */
type ReadPhone = { kind: "read"; e164: string; local: boolean } | { kind: "unreadable" };

/** Australia's international dial-out prefixes, then any other `00`. */
const DIAL_OUT = /^(?:001[14589]|00)\s*/;

/**
 * A non-blank phone number in the form the field map sends one in,
 * `phoneAu`'s E.164 (`+61…`), so both mean the same by "the same AU number".
 * EH's list holds that, `61…`, a local form, or an international one dialled
 * from Australia (`0011…`), spaced or not. Unreadable when `phoneAu` doesn't
 * take it (13, 1300 and 1800 numbers among them), or when an Australian
 * number isn't 9 digits after `+61` (an overseas local form, `020 …`, reads so).
 */
function readPhone(v: unknown): ReadPhone {
  const dialled = comparable(v).replace(DIAL_OUT, "+");
  let e164: string;
  try {
    e164 = phoneAu(dialled);
  } catch {
    return { kind: "unreadable" };
  }
  if (e164.startsWith("+61") && !/^\+61\d{9}$/.test(e164)) return { kind: "unreadable" };
  return { kind: "read", e164, local: !dialled.startsWith("+") && !/^61/.test(dialled) };
}

/**
 * Two numbers compare as `phoneAu` reads them. Left out, not listed, when
 * either can't be read, or when an overseas number meets a local form:
 * `phoneAu` reads `021 …` as Australian, but it may be the same NZ number.
 */
const phoneDiffers: Differs = (ct, eh) => {
  const [a, b] = [readPhone(ct), readPhone(eh)];
  if (a.kind === "unreadable" || b.kind === "unreadable") return false;
  const overseas = (p: typeof a) => !p.local && !p.e164.startsWith("+61");
  if ((a.local && overseas(b)) || (b.local && overseas(a))) return false;
  return a.e164 !== b.e164;
};

/** Spaces aside: Connecteam's `FullTime` is EH's `Full Time`. */
const unspaced: Normalise = (v) => comparable(v).replace(/ /g, "");

/**
 * A number EH's list holds without separators (BSB, account number, USI,
 * TFN): spaces and dashes are formatting. Connecteam's USI comes spaced in groups.
 */
const unseparated: Normalise = (v) => comparable(v).replace(/[\s-]/g, "");

/** A fixed-length number that came back shorter (as a JSON number, or typed so) has lost its leading zeros. */
const padded =
  (length: number): Normalise =>
  (v) => {
    const s = unseparated(v);
    return new RegExp(`^\\d{1,${length - 1}}$`).test(s) ? s.padStart(length, "0") : s;
  };

/**
 * An account number's length varies, so one returned as a number can't get
 * its leading zeros back: compare both without them. Two strings compare in full.
 */
const accountNumberDiffers: Differs = (ct, eh) => {
  const [a, b] = [unseparated(ct), unseparated(eh)];
  if (typeof ct !== "number" && typeof eh !== "number") return a !== b;
  return a.replace(/^0+/, "") !== b.replace(/^0+/, "");
};

/**
 * The fields EH returns in its own form, by family, so a client's map that
 * fills a second bank account or the postal address gets the same forms as
 * the demo's. Any other field is compared with {@link plainDiffers}. Checked
 * on the demo and left to it, as they match once case, spacing and a date's
 * time are set aside: names, email, gender, dates, job title, street address,
 * suburb, state, emergency contact name and relationship, account name, fund
 * name and member number. The TFN wasn't compared on the demo; it's mapped
 * to bare digits, the 9-digit form EH's list holds.
 */
const FAMILIES: ReadonlyArray<readonly [field: RegExp, differs: Differs]> = [
  [/^(residential|postal)Country$/, countryDiffers],
  [/^(mobile|home|work)Phone$|^emergencyContact\d_(Alternate)?ContactNumber$/, phoneDiffers],
  [/^(residential|postal)PostCode$/, differsAfter(padded(4))],
  [/^employmentType$/, differsAfter(unspaced)],
  [/^bankAccount\d_BSB$/, differsAfter(padded(6))],
  [/^bankAccount\d_AccountNumber$/, accountNumberDiffers],
  [/^superFund\d_ProductCode$|^taxFileNumber$/, differsAfter(unseparated)],
];

function differs(field: string, ct: unknown, eh: unknown): boolean {
  // An object or array has no text form to compare: left out, not listed.
  if ((typeof ct === "object" && ct !== null) || (typeof eh === "object" && eh !== null)) return false;
  // A blank against a value is a difference whatever the field: one side has none.
  const [a, b] = [comparable(ct), comparable(eh)];
  if (a === "" || b === "") return a !== b;
  const family = FAMILIES.find(([pattern]) => pattern.test(field));
  return (family?.[1] ?? plainDiffers)(ct, eh);
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
