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

/** The mapped payload split into units, without the Payroll ID or any constant. */
export function unitsOf(
  payload: Record<string, unknown>,
  map: Pick<FieldMap, "rules">,
): Record<string, Record<string, unknown>> {
  const constants = new Set(Object.keys(map.rules?.constants ?? {}));
  const units: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "externalId" || constants.has(key)) continue;
    (units[unitOf(key)] ??= {})[key] = value;
  }
  return units;
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
 */
export async function takeBaseline(
  payload: Record<string, unknown>,
  map: Pick<FieldMap, "rules">,
  secret: string,
): Promise<Baseline> {
  if (!secret) throw new Error("BASELINE_KEY is not set");
  const key = await hmacKey(secret);
  const units: Record<string, string> = {};
  for (const [unit, values] of Object.entries(unitsOf(payload, map))) {
    units[unit] = await hmacHex(key, canonicalJson({ unit, values }));
  }
  return { keyId: await baselineKeyId(secret), units };
}
