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
import { readPhoneAu } from "../../src/mapping/transforms.js";

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
 * settled before one is called (see {@link detailDiffers}).
 */
type Comparer = (ct: unknown, eh: unknown) => boolean;

/** Both sides through one function: `[Connecteam's, EH's]`. */
const bothSides = <T>(f: (v: unknown) => T, ct: unknown, eh: unknown): [ct: T, eh: T] => [f(ct), f(eh)];

/** A comparer that puts both sides in one form first. */
const comparerFor =
  (normalise: Normalise): Comparer =>
  (ct, eh) => {
    const [c, e] = bothSides(normalise, ct, eh);
    return c !== e;
  };

/** Any field without its own form: case, spacing and a date's time aside. */
const plainDiffers = comparerFor(comparable);

/**
 * Country names EH's bulk list holds for the codes Connecteam sends. Only
 * AU is confirmed on the demo (`AU` mapped, `Australia` in EH).
 */
const AUSTRALIA = "australia";
const COUNTRY_NAME: Record<string, string> = { au: AUSTRALIA, aus: AUSTRALIA };
const COUNTRY_CODE = /^[a-z]{2,3}$/;
/** Two codes in use for one country: the UK's ISO code is GB. */
const CODE_ALIAS: Record<string, string> = { uk: "gb" };

/**
 * Two names, or two codes of one length, compare as they are. A code against
 * a name is compared only when one side is Australia, the one name with known
 * codes: `NZ` against `Australia` differs. Anything else can't be compared,
 * so it's left out: a code against another name (`NZ` / `New Zealand`, or
 * EH's `UK` / `United Kingdom`), or codes from two code systems (`US` /
 * `USA`). Keep EH's is the default, so nothing wrong is sent.
 */
const countryDiffers: Comparer = (ct, eh) => {
  const nameOrCode = (v: unknown) => {
    const s = CODE_ALIAS[comparable(v)] ?? comparable(v);
    return COUNTRY_NAME[s] ?? s;
  };
  const [c, e] = bothSides(nameOrCode, ct, eh);
  const [cCode, eCode] = [COUNTRY_CODE.test(c), COUNTRY_CODE.test(e)];
  if (cCode && eCode) return c.length === e.length && c !== e;
  if (cCode === eCode) return c !== e;
  return c === AUSTRALIA || e === AUSTRALIA;
};

/**
 * A phone number as `phoneAu` reads it, and where its country came from:
 * written as `+61` / `61` (`au`), as another `+` code (`overseas`), or not
 * written at all (`local`, read as Australian).
 */
type ReadPhone = { kind: "read"; e164: string; origin: "au" | "overseas" | "local" } | { kind: "unreadable" };

/**
 * A non-blank phone number exactly as the field map sends one,
 * `phoneAu`'s E.164, so both mean the same by "the same number"
 * (dial-out prefixes, `0061`, Australia's code in brackets and its trunk 0
 * are all read there, #235). Another country's code in brackets is left
 * unreadable by `phoneAu`, so it's left out rather than compared with its
 * trunk 0 kept (`(+64) 021 …`). Another country's `(0)` is kept, as Italy
 * dials it. Unreadable when `phoneAu` doesn't take it (13, 1300 and 1800
 * numbers, and a `00…` number that isn't a dial-out prefix, among them).
 */
function readPhone(v: unknown): ReadPhone {
  let read: { e164: string; local: boolean };
  try {
    read = readPhoneAu(comparable(v));
  } catch {
    return { kind: "unreadable" };
  }
  const origin = read.local ? "local" : read.e164.startsWith("+61") ? "au" : "overseas";
  return { kind: "read", e164: read.e164, origin };
}

/**
 * Two numbers compare as {@link readPhone} reads them. Left out, not listed,
 * when either can't be read, or when an overseas number meets a local form:
 * `phoneAu` reads `021 …` or `020 …` as Australian, but it may be the same
 * NZ or UK number. An Australian number of the wrong length is compared as
 * it is, so it's listed against a well-formed one.
 */
const phoneDiffers: Comparer = (ct, eh) => {
  const [ctPhone, ehPhone] = bothSides(readPhone, ct, eh);
  if (ctPhone.kind === "unreadable" || ehPhone.kind === "unreadable") return false;
  const origins = new Set([ctPhone.origin, ehPhone.origin]);
  if (origins.has("local") && origins.has("overseas")) return false;
  return ctPhone.e164 !== ehPhone.e164;
};

/** Spaces aside: Connecteam's `FullTime` is EH's `Full Time`. */
const unspaced: Normalise = (v) => comparable(v).replace(/ /g, "");

/**
 * A number EH's list holds without separators (BSB, account number, USI,
 * TFN, ABN): spaces and dashes are formatting. Connecteam's USI comes spaced in groups.
 */
const unseparated: Normalise = (v) => comparable(v).replace(/[\s-]/g, "");

/** A BSB is six digits: a shorter one (returned as a number, or typed so) has lost its leading zeros. */
const bsbDigits: Normalise = (v) => {
  const s = unseparated(v);
  return /^\d{1,5}$/.test(s) ? s.padStart(6, "0") : s;
};

/**
 * A postcode EH returns as a JSON number has lost its leading zero. Text is
 * compared as typed: an overseas postcode can be shorter than four digits.
 */
const paddedPostcode: Normalise = (v) => (typeof v === "number" ? String(v).padStart(4, "0") : comparable(v));

/**
 * An account number's length varies, so one EH returns as a JSON number
 * can't get its leading zeros back: compare both without them. Connecteam's
 * side is always text (the field map's `digits`), so this only ever forgives
 * EH's. Two strings compare in full.
 */
const accountNumberDiffers: Comparer = (ct, eh) => {
  const [c, e] = bothSides(unseparated, ct, eh);
  if (typeof ct !== "number" && typeof eh !== "number") return c !== e;
  return c.replace(/^0+/, "") !== e.replace(/^0+/, "");
};

/**
 * The comparer for each family of fields EH returns in its own form, so a
 * client's map that fills a second bank account or the postal address gets
 * the same forms as the demo's. Any other field is compared with
 * {@link plainDiffers}. Checked on the demo and left to it, as they match
 * once case, spacing and a date's time are set aside: names, email, gender,
 * dates, job title, street address, suburb, state, emergency contact name
 * and relationship, account name, fund name and member number. The TFN
 * wasn't compared on the demo; it's mapped to bare digits, the 9-digit form
 * EH's list holds.
 */
const FIELD_COMPARERS: ReadonlyArray<readonly [field: RegExp, comparer: Comparer]> = [
  [/^(residential|postal|workingHolidayVisa)Country$/, countryDiffers],
  [/^(mobile|home|work)Phone$|^emergencyContact\d_(Alternate)?ContactNumber$/, phoneDiffers],
  [/^(residential|postal)PostCode$/, comparerFor(paddedPostcode)],
  [/^employmentType$/, comparerFor(unspaced)],
  [/^bankAccount\d_BSB$/, comparerFor(bsbDigits)],
  [/^bankAccount\d_AccountNumber$/, accountNumberDiffers],
  [/^superFund\d_ProductCode$|^taxFileNumber$|ABN$/, comparerFor(unseparated)],
];

function detailDiffers(field: string, ct: unknown, eh: unknown): boolean {
  // An object or array has no text form to compare: left out, not listed.
  if ((typeof ct === "object" && ct !== null) || (typeof eh === "object" && eh !== null)) return false;
  // A blank against a value is a difference whatever the field: one side has none.
  const [c, e] = bothSides(comparable, ct, eh);
  if (c === "" || e === "") return c !== e;
  const comparer = FIELD_COMPARERS.find(([pattern]) => pattern.test(field))?.[1] ?? plainDiffers;
  return comparer(ct, eh);
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
    const differing = Object.keys(values).filter((f) => f in ehRecord && detailDiffers(f, values[f], ehRecord[f]));
    if (differing.length === 0) continue;
    out.push({ unit, label: groupLabel(unit) ?? fieldLabel(unit), fields: differing.map(fieldLabel) });
  }
  return out;
}
