/**
 * Applies a validated {@link FieldMap} to one Connecteam user object, producing
 * the full field set for an Employment Hero Payroll unstructured-employee upsert,
 * a list of per-field issues, and the plain-language follow-ups a payroll admin
 * still has to action by hand. Pure - no network, no logging.
 */
import type { FieldMap, FieldRule, TransformName } from "./schema.js";
import * as t from "./transforms.js";
import type { UnusableAnswer } from "../eh/errors.js";
import { TransformError } from "./transforms.js";
import { applySuper, applyTaxDeclaration, FOLLOW_UP, type RuleOutput } from "./rules.js";

export type PayloadValue = string | number | boolean;

export interface ConnecteamCustomField {
  customFieldId: number;
  value: unknown;
  type: string;
  name: string;
}

export interface ConnecteamUser {
  userId: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  isArchived?: boolean;
  customFields: ConnecteamCustomField[];
}

export interface MappingIssue {
  ehField: string;
  source: string;
  reason: string;
  /** The employee's dropdown answer the sync can't use (never for a sensitive field). */
  answer?: UnusableAnswer;
}

export interface MappingResult {
  externalId: string;
  emailFallback: string | undefined;
  /** EH field name -> value. Ready to POST as the unstructured-employee body. */
  payload: Record<string, PayloadValue>;
  /** Per-field problems. A non-empty list means do not send the payload as-is. */
  issues: MappingIssue[];
  /** Valid data that still needs a human step in EH (non-resident, SMSF, ...). */
  followUps: string[];
  /**
   * Plain-language reasons the all-or-nothing pay-run set could not be completed
   * for this employee while `employmentHero.perEmployeeRate` is on (issue #42) -
   * e.g. no Connecteam pay rate on file, an unsupported `rateType`, or a missing
   * `defaults` name. Non-empty => no pay-run keys were put on the payload (never
   * send EH a partial set) and the sync raises one follow-up instead of writing.
   */
  payRunIssues: string[];
  /**
   * True when `payRunIssues` reflects a field-map misconfiguration (the
   * location axis - `defaults.paySchedule` / `primaryLocation` /
   * `primaryPayCategory` - is blank), which affects every employee identically
   * and is never something the sync should paper over with a per-employee
   * write. False when the only gap is the per-employee rate axis (no
   * classification picked yet / no Connecteam pay rate on file) - a real data
   * gap for this one person, not a config bug, so the record still gets
   * created/updated (without pay-run keys) and the gap is reported as a
   * follow-up rather than blocking their entire EH record.
   */
  payRunBlocking: boolean;
  /**
   * True when the complete pay-run set resolved for this record: the location
   * axis (`paySchedule` + `primaryLocation` + `primaryPayCategory`) plus the
   * rate axis (`rate` + `rateUnit`, OR a `payRateTemplate` that EH derives them
   * from). The values may come from a flat `employmentHero.defaults` (issue #26),
   * from `defaults` + the Connecteam pay-rates API with `perEmployeeRate` on
   * (issue #42), or from `defaults` + a per-employee `payRateTemplate` field with
   * `payRateTemplate` on (issue #39). EH's pay-run axis should then be satisfied,
   * so a later "pay run defaults incomplete" from EH is a field-map
   * misconfiguration, not per-employee admin work.
   */
  payRunDefaultsComplete: boolean;
}

/** A pay rate resolved from the Connecteam pay-rates API, passed in by the
 * consumer so `applyFieldMap` stays pure. Shape mirrors `connecteam/types` `PayRate`. */
export interface PayRateInput {
  rateType: string;
  defaultRate: number;
  isDefaultRateEnabled: boolean;
}

export interface ApplyOptions {
  /** The employee's Connecteam pay rate, or `null` if none on file. Only read
   * when `employmentHero.perEmployeeRate` is configured. */
  payRate?: PayRateInput | null | undefined;
  /** The employee's current EH record, or `null` when the write will create
   * one. Omitted = treat as a create. On an update, a pay-run value from
   * `defaults` that EH already holds is left out, so a value set by hand in EH
   * survives (issue #102), and EH's values count when checking the set. */
  ehRecord?: Record<string, unknown> | null | undefined;
}

/** Connecteam `rateType` -> EH `rateUnit`. `rateUnit: "Monthly"` confirmed
 * accepted and persisted against the live unstructured endpoint - probed
 * 2026-09-11, `docs/eh-pay-defaults.md`. */
const RATE_UNIT_BY_TYPE: Record<string, string> = {
  hourly: "Hourly",
  yearly: "Annually",
  monthly: "Monthly",
};

/**
 * The pay-run "location axis" EH validates all-or-nothing on the unstructured
 * endpoint (`docs/eh-pay-defaults.md`). The "rate axis" is separate - see
 * {@link rateAxisComplete}. Hours and award are optional extras.
 */
const PAY_RUN_LOCATION = ["paySchedule", "primaryLocation", "primaryPayCategory"] as const;

/** Every pay-run key we might emit - stripped as a block when the set is incomplete. */
const PAY_RUN_ALL = [
  ...PAY_RUN_LOCATION,
  "rate",
  "rateUnit",
  "payRateTemplate",
  "hoursPerWeek",
  "hoursPerDay",
  "awardId",
] as const;

/**
 * The pay-run "rate axis" is satisfied by an award pay-rate template (EH derives
 * `rate`/`rateUnit` from it - `docs/eh-pay-defaults.md` issue #39) OR by an
 * explicit `rate` + `rateUnit`.
 */
function rateAxisComplete(payload: Record<string, PayloadValue>): boolean {
  if (!isBlank(payload.payRateTemplate)) return true;
  return !isBlank(payload.rate) && !isBlank(payload.rateUnit);
}

/** Both axes present => EH's pay-run validation should pass. */
function payRunComplete(payload: Record<string, PayloadValue>): boolean {
  return PAY_RUN_LOCATION.every((k) => !isBlank(payload[k])) && rateAxisComplete(payload);
}

const BASE: Record<TransformName, (v: unknown) => PayloadValue> = {
  trimString: t.trimString,
  lowerTrim: t.lowerTrim,
  dateDmyToIso: t.dateDmyToIso,
  dropdownValue: t.dropdownValue,
  phoneAu: t.phoneAu,
  locationFull: (v) => t.locationField(v, "full"),
  locationStreetLine: (v) => t.locationField(v, "streetLine"),
  digits: t.digits,
  zeroPad4: (v) => t.zeroPad(v, 4),
  zeroPad6: (v) => t.zeroPad(v, 6),
  number: t.decimalNumber,
};

function isBlank(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

function readSource(
  user: ConnecteamUser,
  rule: FieldRule,
): { value: unknown; label: string } {
  if ("userField" in rule.from) {
    return { value: user[rule.from.userField], label: `userField ${rule.from.userField}` };
  }
  const { customFieldId } = rule.from;
  const cf = user.customFields.find((f) => f.customFieldId === customFieldId);
  const label = cf
    ? `customField ${cf.customFieldId} (${cf.name})`
    : `customField ${customFieldId} (not present)`;
  return { value: cf?.value, label };
}

function applyFieldRules(user: ConnecteamUser, map: FieldMap): {
  payload: Record<string, PayloadValue>;
  issues: MappingIssue[];
} {
  const payload: Record<string, PayloadValue> = {};
  const issues: MappingIssue[] = [];

  for (const rule of map.fields) {
    const { value, label } = readSource(user, rule);

    if (isBlank(value)) {
      if (rule.default !== undefined) {
        payload[rule.eh] = rule.default;
      } else if (rule.required) {
        issues.push({ ehField: rule.eh, source: label, reason: "required value is missing or blank" });
      }
      continue;
    }

    try {
      let out = BASE[rule.transform](value);
      if (rule.map) out = t.mapEnum(String(out), rule.map);
      payload[rule.eh] = out;
    } catch (err) {
      const reason = err instanceof TransformError ? err.message : String(err);
      // A readable answer the map doesn't list: tell the employee what they picked.
      const answer = rule.map && !rule.sensitive && "customFieldId" in rule.from ? dropdownAnswer(user, rule.from.customFieldId, "option") : undefined;
      issues.push({ ehField: rule.eh, source: label, reason, ...(answer ? { answer } : {}) });
    }
  }

  return { payload, issues };
}

/**
 * Fold the pay-run set into the payload and report whether it is complete.
 *
 * Three modes:
 *  - default (issues #26, #34): the opt-in `employmentHero.defaults` block is
 *    copied verbatim - its schema key names already match the EH
 *    unstructured-employee field names, verified in `docs/eh-pay-defaults.md`.
 *    The set is "complete" only if `defaults` itself carried both axes.
 *  - `perEmployeeRate` on (issue #42): `rate` + `rateUnit` come from the
 *    employee's Connecteam pay rate; the location axis still comes from
 *    `defaults`.
 *  - `payRateTemplate` on (issue #39): the rate axis is an award classification -
 *    a `payRateTemplate` NAME from a `fields[]` rule (an admin-completed
 *    Connecteam field). EH derives `rate`/`rateUnit` from it, so any explicit
 *    `rate`/`rateUnit` on the payload is dropped. Location axis still from
 *    `defaults`.
 *
 * In the two opt-in modes, if ANY required field cannot be resolved for this
 * employee, every pay-run key is stripped (EH 400s a partial set) and a
 * plain-language issue is returned for the follow-up.
 *
 * Against an existing EH record (issue #102): a value EH already holds counts
 * as resolved, and a value from `defaults` that EH holds is left off the
 * payload. EH keeps an omitted key on update (probed 2026-10-04,
 * `docs/eh-pay-defaults.md`), so a value set by hand in EH survives. Values
 * from the employee's own Connecteam data are always sent.
 */
function applyPayRun(
  payload: Record<string, PayloadValue>,
  eh: FieldMap["employmentHero"],
  payRate: PayRateInput | null | undefined,
  ehRecord: Record<string, unknown> | null | undefined,
): { complete: boolean; issues: string[]; blocking: boolean } {
  const { defaults } = eh;
  const fromDefaults = new Set<string>();
  const ehHas = (k: string): boolean => ehRecord != null && !isBlank(ehRecord[k]);
  const present = (k: string): boolean => !isBlank(payload[k]) || ehHas(k);
  // What EH will hold after the write: its own values, overlaid by ours.
  const after = (): Record<string, PayloadValue> => {
    const view: Record<string, PayloadValue> = {};
    for (const k of PAY_RUN_ALL) if (ehHas(k)) view[k] = ehRecord![k] as PayloadValue;
    return { ...view, ...payload };
  };
  const keepEhValues = (): void => {
    for (const k of fromDefaults) if (ehHas(k)) delete payload[k];
  };

  if (defaults) {
    for (const [key, value] of Object.entries(defaults)) {
      if (value === undefined) continue;
      payload[key] = value as PayloadValue;
      fromDefaults.add(key);
    }
  }

  if (!eh.perEmployeeRate && !eh.payRateTemplate) {
    // Pure-defaults mode: complete only if `defaults` carried both axes itself
    // (`payRunComplete` accepts a `defaults.payRateTemplate` as the rate axis).
    const complete = payRunComplete(after());
    keepEhValues();
    return { complete, issues: [], blocking: false };
  }

  // Kept separate so a per-employee data gap (rate axis) never blocks the
  // whole EH write the way a field-map misconfiguration (location axis) does
  // - see `payRunBlocking` on {@link MappingResult}.
  const rateIssues: string[] = [];
  const locationIssues: string[] = [];

  if (eh.perEmployeeRate) {
    const rate = resolvePerEmployeeRate(payRate);
    fromDefaults.delete("rate");
    fromDefaults.delete("rateUnit");
    delete payload.rate;
    delete payload.rateUnit;
    if (!("issue" in rate)) {
      payload.rate = rate.rate;
      payload.rateUnit = rate.rateUnit;
    } else if (!(ehHas("rate") && ehHas("rateUnit"))) {
      rateIssues.push(rate.issue);
    }
  }

  if (eh.payRateTemplate) {
    // The award template is the sole rate source - never send it alongside an
    // explicit rate (EH would have to disambiguate via overrideTemplateRate).
    delete payload.rate;
    delete payload.rateUnit;
    if (!present("payRateTemplate")) {
      rateIssues.push(
        "This employee has no pay rate template (award classification) set in " +
          "Connecteam. Set it on their profile, or set the pay rate in " +
          "Employment Hero by hand.",
      );
    }
  }

  for (const k of PAY_RUN_LOCATION) {
    if (!present(k)) {
      locationIssues.push(
        `Pay-run "${k}" is not configured in the field-map ` +
          `(employmentHero.defaults.${k}) - it is required for every employee ` +
          `once perEmployeeRate or payRateTemplate is enabled.`,
      );
    }
  }

  const issues = [...locationIssues, ...rateIssues];
  if (issues.length > 0) {
    // Never send EH a partial pay-run set - drop every pay-run key.
    for (const k of PAY_RUN_ALL) delete payload[k];
    return { complete: false, issues, blocking: locationIssues.length > 0 };
  }
  keepEhValues();
  return { complete: true, issues: [], blocking: false };
}

/**
 * Collapse one Connecteam pay rate to EH's single `rate` + `rateUnit`, or return
 * a plain-language reason it cannot be used. `resourcesRates[]` overrides are
 * ignored here (the consumer logs when they exist).
 */
function resolvePerEmployeeRate(
  payRate: PayRateInput | null | undefined,
): { rate: number; rateUnit: string } | { issue: string } {
  if (!payRate) {
    return {
      issue:
        "This employee has no pay rate set in Connecteam. Add one under " +
        "Connecteam → Pay Rates, or set the rate in Employment Hero by hand.",
    };
  }
  if (payRate.isDefaultRateEnabled === false) {
    return {
      issue:
        "This employee's default pay rate is turned off in Connecteam. Turn it " +
        "on, or set the rate in Employment Hero by hand.",
    };
  }
  const rateUnit = RATE_UNIT_BY_TYPE[String(payRate.rateType).trim().toLowerCase()];
  if (!rateUnit) {
    return {
      issue:
        `Connecteam has this employee on a "${payRate.rateType}" pay rate, which ` +
        "the sync cannot map to Employment Hero (only hourly, monthly and yearly " +
        "are supported). Set this employee's rate in Employment Hero by hand for now.",
    };
  }
  const rate = Number(payRate.defaultRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    return {
      issue:
        "The pay rate on file for this employee in Connecteam is zero or missing. " +
        "Fix it in Connecteam, or set the rate in Employment Hero by hand.",
    };
  }
  return { rate, rateUnit };
}

function mergeRuleOutput(
  target: { payload: Record<string, PayloadValue>; issues: MappingIssue[]; followUps: string[] },
  r: RuleOutput,
): void {
  Object.assign(target.payload, r.fields);
  target.issues.push(...r.issues);
  target.followUps.push(...r.followUps);
}

/**
 * The field that leaves this employee out of the sync by choice (`rules.exclude`),
 * as a redaction-safe label (`customField <id> (<name>)`, never the answer), or
 * undefined if none does.
 */
/** A custom field's single dropdown answer, with the question's name, or undefined if blank or unreadable. */
export function dropdownAnswer(user: ConnecteamUser, customFieldId: number, kind: UnusableAnswer["kind"]): UnusableAnswer | undefined {
  const cf = user.customFields.find((f) => f.customFieldId === customFieldId);
  if (!cf) return undefined;
  try {
    const value = t.dropdownValue(cf.value);
    return value ? { question: cf.name, value, kind } : undefined;
  } catch {
    return undefined;
  }
}

export function leftOutBy(user: ConnecteamUser, map: FieldMap): string | undefined {
  for (const rule of map.rules?.exclude ?? []) {
    const cf = user.customFields.find((f) => f.customFieldId === rule.customFieldId);
    if (!cf) continue;
    let answer: string;
    try {
      answer = t.dropdownValue(cf.value);
    } catch {
      continue; // blank or not a single answer: not left out
    }
    if (rule.values.includes(answer)) return `customField ${cf.customFieldId} (${cf.name})`;
  }
  return undefined;
}

export function applyFieldMap(
  user: ConnecteamUser,
  map: FieldMap,
  opts: ApplyOptions = {},
): MappingResult {
  const { payload, issues } = applyFieldRules(user, map);
  const acc = { payload, issues, followUps: [] as string[] };

  if (map.rules?.taxDeclaration) {
    mergeRuleOutput(acc, applyTaxDeclaration(user, map.rules.taxDeclaration));
  }
  if (map.rules?.super) {
    mergeRuleOutput(acc, applySuper(user, map.rules.super));
  }
  for (const [key, value] of Object.entries(map.rules?.constants ?? {})) {
    acc.payload[key] = value;
  }

  // Pay-run set: from `employmentHero.defaults` alone, or (with `perEmployeeRate`
  // on) `defaults` + this employee's Connecteam pay rate. EH validates the set
  // all-or-nothing and ignores the legacy `payScheduleId` / `locationId` keys
  // entirely (issue #34), so a partial set is never emitted (issues #26, #42).
  const {
    complete: payRunDefaultsComplete,
    issues: payRunIssues,
    blocking: payRunBlocking,
  } = applyPayRun(acc.payload, map.employmentHero, opts.payRate, opts.ehRecord);

  const externalId = String(user.userId);
  acc.payload.externalId = externalId;

  if (acc.payload.residentialState === "INTERNATIONAL") {
    acc.followUps.push(FOLLOW_UP.internationalAddress);
  }

  const emailFallback =
    typeof user.email === "string" && user.email.trim() !== ""
      ? user.email.trim().toLowerCase()
      : undefined;

  return {
    externalId,
    emailFallback,
    payload: acc.payload,
    issues: acc.issues,
    followUps: acc.followUps,
    payRunIssues,
    payRunBlocking,
    payRunDefaultsComplete,
  };
}
