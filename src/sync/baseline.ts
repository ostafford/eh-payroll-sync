/**
 * A Linked employee's Baseline (ADR-0009): one keyed fingerprint per **unit**
 * of their mapped pack, never a value (ADR-0001).
 *
 * A unit is a single field, or a group EH needs sent whole (#135): bank
 * account 1, residential address, emergency contact 1, super, tax declaration,
 * the pay-run set. Constants (`rules.constants`) and the Payroll ID itself are
 * left out: they aren't the employee's data, and a Linked employee is never
 * sent a constant.
 *
 * Fingerprints are HMAC-SHA-256 under `BASELINE_KEY`, so a stored fingerprint
 * of a 9-digit TFN can't be brute-forced. The key id is an HMAC of a fixed
 * label under the same key: it tells two keys apart without revealing either.
 */
import { canonicalJson } from "./canonical.js";
import type { Baseline } from "./gateway.js";
import type { FieldMap } from "../mapping/schema.js";

/** Every pay-run key the mapping can emit (as `PAY_RUN_ALL` in mapping/apply.ts). */
const PAY_RUN_KEYS: ReadonlySet<string> = new Set([
  "paySchedule",
  "primaryLocation",
  "primaryPayCategory",
  "rate",
  "rateUnit",
  "payRateTemplate",
  "hoursPerWeek",
  "hoursPerDay",
  "awardId",
]);

/**
 * What the pay-run unit's fingerprint covers: the Connecteam pay rate only.
 * The rest of the set comes from the field map, so a client changing a
 * default doesn't send every Linked employee's set again (ADR-0009).
 */
const PAY_RATE_KEYS: ReadonlySet<string> = new Set(["rate", "rateUnit"]);

const TAX_DECLARATION_KEYS: ReadonlySet<string> = new Set([
  "claimTaxFreeThreshold",
  "australianResident",
  "helpDebt",
  "stslDebt",
]);

/** Groups matched by EH field-name prefix. `bankAccount1` itself (the payment method) is in the bank group. */
const PREFIX_GROUPS: ReadonlyArray<readonly [prefix: string, unit: string]> = [
  ["bankAccount1", "bankAccount1"],
  ["residential", "residentialAddress"],
  ["emergencyContact1_", "emergencyContact1"],
  ["superFund1_", "super"],
];

/** The unit an EH field belongs to: its group's name, or the field's own name. */
export function unitOf(ehField: string): string {
  if (PAY_RUN_KEYS.has(ehField)) return "payRun";
  if (TAX_DECLARATION_KEYS.has(ehField)) return "taxDeclaration";
  for (const [prefix, unit] of PREFIX_GROUPS) if (ehField.startsWith(prefix)) return unit;
  return ehField;
}

/** What a Baseline needs of the field map. Only the constants are needed to split a payload. */
type BaselineMap = Pick<FieldMap, "rules"> & Partial<Pick<FieldMap, "fields" | "employmentHero">>;

/** The EH fields the field map sets as constants: never part of a unit. */
function constantsOf(map: Pick<FieldMap, "rules">): ReadonlySet<string> {
  return new Set(Object.keys(map.rules?.constants ?? {}));
}

/** Stands in for a field the pack holds but couldn't map. No real value is an object, so it never equals one. */
const UNMAPPED = { unmapped: true } as const;

/**
 * The mapped payload split into units, without the Payroll ID or any constant.
 * `unmapped` names EH fields with a mapping issue: they're in the unit as
 * {@link UNMAPPED}, so once fixed the unit reads as changed and is sent, not
 * as a new unit baselined without sending (ADR-0009).
 */
export function unitsOf(
  payload: Record<string, unknown>,
  map: Pick<FieldMap, "rules">,
  unmapped: readonly string[] = [],
): Record<string, Record<string, unknown>> {
  const constants = constantsOf(map);
  const units: Record<string, Record<string, unknown>> = {};
  const entries: Array<[string, unknown]> = [...Object.entries(payload), ...unmapped.map((f) => [f, UNMAPPED] as [string, unknown])];
  for (const [key, value] of entries) {
    if (key === "externalId" || constants.has(key)) continue;
    (units[unitOf(key)] ??= {})[key] = value;
  }
  return units;
}

/**
 * Every unit the field map can fill, blank or not: its `fields` rules, and the
 * pay-run set when the map builds one. A unit missing from a Baseline's
 * `filled` that's in here now was added to the map after it (#152).
 */
function unitsInMap(map: BaselineMap): string[] {
  const constants = constantsOf(map);
  const units = new Set((map.fields ?? []).filter((f) => !constants.has(f.eh)).map((f) => unitOf(f.eh)));
  const eh = map.employmentHero;
  if (eh?.defaults || eh?.perEmployeeRate) units.add("payRun");
  return [...units];
}

function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

type HmacKey = Awaited<ReturnType<typeof hmacKey>>;

async function hmacHex(key: HmacKey, input: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The id stored beside a Baseline's fingerprints, so a changed `BASELINE_KEY` is noticed (ADR-0009). */
export async function baselineKeyId(secret: string): Promise<string> {
  return (await hmacHex(await hmacKey(secret), "eh-payroll-sync baseline key id")).slice(0, 16);
}

/**
 * The Baseline of a mapped payload: one fingerprint per unit. The unit name is
 * part of what's signed, so two units holding the same values still differ.
 * The pay-run unit signs only {@link PAY_RATE_KEYS}.
 */
export async function takeBaseline(
  payload: Record<string, unknown>,
  map: BaselineMap,
  secret: string,
  unmapped: readonly string[] = [],
): Promise<Baseline> {
  if (!secret) throw new Error("BASELINE_KEY is not set");
  const key = await hmacKey(secret);
  const units: Record<string, string> = {};
  const filled: Record<string, string[]> = {};
  for (const [unit, values] of Object.entries(unitsOf(payload, map, unmapped))) {
    const signed = unit === "payRun" ? Object.fromEntries(Object.entries(values).filter(([k]) => PAY_RATE_KEYS.has(k))) : values;
    units[unit] = await hmacHex(key, canonicalJson({ unit, values: signed }));
    filled[unit] = Object.keys(values).sort();
  }
  // A blank unit has no fingerprint, but is known: once filled in, it's a change to send.
  for (const unit of unitsInMap(map)) filled[unit] ??= [];
  return { keyId: await baselineKeyId(secret), units, filled };
}

/**
 * The units in `now` that `before` didn't know of: added to the field map
 * after it was taken (#152). A Baseline with no `filled` record knows only
 * the units it has a fingerprint for.
 */
export function newUnits(before: Baseline, now: Baseline): string[] {
  const known = new Set(Object.keys(before.filled ?? before.units));
  return Object.keys(now.filled ?? now.units).filter((unit) => !known.has(unit));
}

/**
 * The EH fields that held a value in `before` and are blank in `now`, by
 * unit: a cleared field, or a group now partly blank (#152). Empty for a
 * Baseline with no `filled` record. The pay-run set isn't the employee's to
 * clear: its keys come and go with the rate and the field map's defaults.
 */
export function clearedFields(before: Baseline, now: Baseline): Record<string, string[]> {
  const cleared: Record<string, string[]> = {};
  for (const [unit, fields] of Object.entries(before.filled ?? {})) {
    if (unit === "payRun") continue;
    const still = new Set(now.filled?.[unit] ?? []);
    const gone = fields.filter((f) => !still.has(f));
    if (gone.length > 0) cleared[unit] = gone;
  }
  return cleared;
}

/** The units whose fingerprint differs between two Baselines: what changed since `before` was taken. */
export function changedUnits(before: Baseline, now: Baseline): string[] {
  return Object.keys(now.units).filter((unit) => now.units[unit] !== before.units[unit]);
}
