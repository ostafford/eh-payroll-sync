/**
 * Pure value transforms: Connecteam field value -> Employment Hero-ready value.
 * Also {@link readPhoneAu}, the reading {@link phoneAu} is built on, exported
 * so the link stage's compare reads a number exactly as it's sent.
 *
 * Every function is total and side-effect free. On input it cannot make sense of
 * it throws {@link TransformError} with a human-readable reason and no field
 * context - the caller ({@link ./apply}) attaches which fields were involved.
 */

export class TransformError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TransformError";
  }
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  throw new TransformError(`expected a string, got ${v === null ? "null" : typeof v}`);
}

export function trimString(v: unknown): string {
  const s = asString(v).trim();
  if (s === "") throw new TransformError("value is blank");
  return s;
}

export function lowerTrim(v: unknown): string {
  return trimString(v).toLowerCase();
}

const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export function dateDmyToIso(v: unknown): string {
  const m = DMY.exec(asString(v).trim());
  if (!m) throw new TransformError(`expected a date as DD/MM/YYYY, got "${String(v)}"`);
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new TransformError(`"${String(v)}" is not a real calendar date`);
  }
  const iso = d.toISOString().slice(0, 10);
  return iso;
}

const DIGITS_ONLY = /^\d+$/;

export function digits(v: unknown): string {
  // Tolerates `number` input on purpose: Connecteam historically stored TFN / BSB
  // / postcode as numeric fields, and a stray numeric value can still arrive.
  const source =
    typeof v === "number" && Number.isFinite(v) ? String(v) : asString(v);
  const raw = source.replace(/[\s-]/g, "");
  if (raw === "" || !DIGITS_ONLY.test(raw)) {
    throw new TransformError(`expected digits (spaces and hyphens allowed), got "${String(v)}"`);
  }
  return raw;
}

export function zeroPad(v: unknown, length: number): string {
  const d = digits(v);
  if (d.length > length) {
    throw new TransformError(`"${d}" is longer than the expected ${length} digits`);
  }
  return d.padStart(length, "0");
}

/**
 * A plain non-negative number (e.g. Employment Hero `hoursPerWeek`). Accepts a
 * numeric Connecteam value or a numeric string; rejects anything non-finite or
 * negative. Returns a `number`, not a string - EH's unstructured endpoint takes
 * `hoursPerWeek` / `rate` as JSON numbers (`docs/eh-pay-defaults.md`).
 */
export function decimalNumber(v: unknown): number {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else {
    const s = String(v).trim();
    // `Number("")` is 0 - treat a blank value as "not a number", not zero.
    if (s === "") throw new TransformError("expected a number, got a blank value");
    n = Number(s);
  }
  if (!Number.isFinite(n)) {
    throw new TransformError(`expected a number, got "${String(v)}"`);
  }
  if (n < 0) {
    throw new TransformError(`expected a non-negative number, got ${n}`);
  }
  return n;
}

interface DropdownOption {
  id: number;
  value: string;
}

function isDropdownOption(x: unknown): x is DropdownOption {
  return typeof x === "object" && x !== null && typeof (x as DropdownOption).value === "string";
}

export function dropdownValue(v: unknown): string {
  if (typeof v === "string") return trimString(v);
  if (!Array.isArray(v) || v.length === 0) {
    throw new TransformError("expected a non-empty Connecteam dropdown value");
  }
  if (v.length > 1) {
    throw new TransformError("expected a single-select dropdown but got multiple values");
  }
  const [only] = v;
  if (!isDropdownOption(only)) {
    throw new TransformError("dropdown option has no string `value`");
  }
  return only.value.trim();
}

interface LocationValue {
  address?: unknown;
}

export function locationField(v: unknown, part: "full" | "streetLine"): string {
  if (typeof v !== "object" || v === null || typeof (v as LocationValue).address !== "string") {
    throw new TransformError("expected a Connecteam location value with an `address` string");
  }
  const address = ((v as { address: string }).address).trim();
  if (address === "") throw new TransformError("location `address` is blank");
  if (part === "full") return address;
  const [streetLine] = address.split(",");
  return (streetLine ?? address).trim();
}

export function phoneAu(v: unknown): string {
  return readPhoneAu(v).e164;
}

/** What {@link readPhoneAu} reads a phone number as. */
export interface PhoneReading {
  /** The number as {@link phoneAu} sends it. */
  e164: string;
  /** No country was written, so it was read as Australian. */
  local: boolean;
}

/**
 * A phone number as {@link phoneAu} reads it, and whether a country was
 * written (`+`, `61`, or a dial-out prefix) or not (`local`, read as
 * Australian). The link stage's compare needs the second: `021 …` read as
 * Australian may be the same number as an overseas one.
 */
export function readPhoneAu(v: unknown): PhoneReading {
  const raw = asString(v).trim();
  const allDigits = raw.replace(/[^\d]/g, "");
  const prefixLength = dialOutPrefixLength(raw);
  const countryWritten = raw.startsWith("+") || prefixLength > 0;
  const stripped = allDigits.slice(prefixLength);
  if (stripped.length < 6) {
    throw new TransformError(`"${raw}" does not look like a phone number`);
  }
  if (countryWritten && stripped.startsWith("0")) {
    // `+0044 …`, `+0412 …`, `0011 0412 …`: which number it means is a guess.
    const after = prefixLength > 0 ? "the dial-out prefix" : "the +";
    throw new TransformError(`"${raw}" has no country code after ${after}: none starts with 0`);
  }
  if (!countryWritten && stripped.startsWith("00")) {
    // No Australian number starts 00, so it's a dial-out prefix mistyped
    // (`001 44 …`) or another country's: which number it means is a guess.
    throw new TransformError(`"${raw}" starts 00 but not with Australia's dial-out prefix (0011) or 0061`);
  }
  if (countryWritten || stripped.startsWith("61")) return { e164: withoutAuTrunkZero(`+${stripped}`), local: false };
  if (stripped.startsWith("0")) return { e164: `+61${stripped.slice(1)}`, local: true };
  throw new TransformError(`"${raw}" is not a recognisable Australian or international number`);
}

/**
 * How many leading digits are a dial-out prefix that means what a typed +
 * does: Australia's 0011 (and 0014/15/18/19 through a chosen carrier), or the
 * 00 of 0061 (00 is other countries' prefix, so only before Australia's
 * code). Read as written, so `001 44 …` isn't taken as 0014 with a space
 * moved. Spaces, dashes and brackets may come before it and between 00 and
 * 61 (`(0011) 44 …`, `00 (61) …`), and so may a + (`+ 0011 44 …`, #238): no
 * country code starts with 0, so a + then 00 can only be a prefix.
 */
function dialOutPrefixLength(raw: string): number {
  const lead = /^\+?[\s()-]*/.exec(raw)?.[0] ?? "";
  const rest = raw.slice(lead.length);
  if (/^001[14589]/.test(rest)) return 4;
  if (/^00[\s()-]*61/.test(rest)) return 2;
  return 0;
}

/**
 * Australia's trunk 0 isn't dialled after +61 (`+61 (0)4…`, `+61 04…`).
 * Digits are counted, not spaces: a 0 then nine digits. Only Australia's:
 * another country's (0) stays, as Italy dials it.
 */
function withoutAuTrunkZero(e164: string): string {
  return e164.replace(/^\+610(?=\d{9}$)/, "+61");
}

export function mapEnum(value: string, table: Readonly<Record<string, string>>): string {
  const hit = table[value];
  if (hit === undefined) {
    throw new TransformError(
      `"${value}" is not one of the expected values: ${Object.keys(table).join(", ")}`,
    );
  }
  return hit;
}

export function yesNo(v: unknown): boolean {
  const s = (typeof v === "string" ? v : dropdownValue(v)).trim().toLowerCase();
  if (s === "yes") return true;
  if (s === "no") return false;
  throw new TransformError(`expected "Yes" or "No", got "${String(v)}"`);
}
