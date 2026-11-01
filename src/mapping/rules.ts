/**
 * The non-1:1 parts of the mapping: the tax file declaration and the
 * APRA-vs-SMSF super branch, plus the plain-language reasons a synced record
 * still needs a payroll admin to finish something by hand.
 *
 * Pure. EH field names here are marked @todo - verify them against the live
 * AuUnstructuredEmployeeModel during M2 before relying on them.
 */
import { dropdownAnswer, type ConnecteamUser, type MappingIssue, type PayloadValue } from "./apply.js";
import { dropdownValue, yesNo, trimString, TransformError } from "./transforms.js";
import type { Rules } from "./schema.js";

/** Confirmed against the live EH unstructured model in issue #2. */
export const EH_FIELD = {
  claimTaxFreeThreshold: "claimTaxFreeThreshold",
  australianResident: "australianResident",
  // EH has separate helpDebt / stslDebt flags; Connecteam asks one combined
  // Yes/No, so we set both (over-reporting is harmless - same repayment schedule;
  // under-reporting would under-withhold).
  helpDebt: "helpDebt",
  stslDebt: "stslDebt",
  superProductCode: "superFund1_ProductCode", // APRA fund USI / product code
  superFundName: "superFund1_FundName",
  superMemberNumber: "superFund1_MemberNumber",
  // EH rejects any super detail unless an allocation is given and the
  // allocations across funds sum to 100. v1 syncs a single APRA fund, so it is
  // always 100. (Mirrors bankAccount1_AllocatedPercentage in the field map.)
  superAllocatedPercentage: "superFund1_AllocatedPercentage",
} as const;

/** v1 syncs exactly one APRA fund, so its contribution allocation is 100%. */
const SINGLE_FUND_ALLOCATION = 100;

export const FOLLOW_UP = {
  nonResident:
    'Employee marked "not an Australian resident for tax" - set the foreign-resident or working-holiday-maker tax scale in Employment Hero.',
  smsfSuper:
    "Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.",
  internationalAddress:
    "Address state is INTERNATIONAL - enter the overseas residential address in Employment Hero manually.",
} as const;

export interface RuleOutput {
  fields: Record<string, PayloadValue>;
  followUps: string[];
  issues: MappingIssue[];
}

function read(user: ConnecteamUser, customFieldId: number): { value: unknown; label: string } {
  const cf = user.customFields.find((f) => f.customFieldId === customFieldId);
  return {
    value: cf?.value,
    label: cf ? `customField ${cf.customFieldId} (${cf.name})` : `customField ${customFieldId} (not present)`,
  };
}

function blank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

type YesNoSource = NonNullable<NonNullable<Rules>["taxDeclaration"]>["claimTaxFreeThreshold"];

export function applyTaxDeclaration(
  user: ConnecteamUser,
  td: NonNullable<Rules>["taxDeclaration"],
): RuleOutput {
  const out: RuleOutput = { fields: {}, followUps: [], issues: [] };
  if (!td) return out;

  const readBool = (ehField: string, source: YesNoSource): boolean | undefined => {
    const { value, label } = read(user, source.customFieldId);
    if (blank(value)) {
      out.issues.push({ ehField, source: label, reason: "required Yes/No answer is missing" });
      return undefined;
    }
    try {
      if (source.options) {
        const answer = dropdownValue(value);
        const mapped = source.options[answer];
        if (mapped === undefined) {
          throw new TransformError(`"${answer}" is not an answer the sync can read as Yes or No: ${Object.keys(source.options).join(", ")}`);
        }
        return mapped === "yes";
      }
      return yesNo(value);
    } catch (err) {
      const answer = dropdownAnswer(user, source.customFieldId, "yesNo");
      out.issues.push({ ehField, source: label, reason: err instanceof TransformError ? err.message : String(err), ...(answer ? { answer } : {}) });
      return undefined;
    }
  };

  const tft = readBool(EH_FIELD.claimTaxFreeThreshold, td.claimTaxFreeThreshold);
  if (tft !== undefined) out.fields[EH_FIELD.claimTaxFreeThreshold] = tft;

  const resident = readBool(EH_FIELD.australianResident, td.australianResident);
  if (resident !== undefined) {
    out.fields[EH_FIELD.australianResident] = resident;
    // EH has no isNonResident field - australianResident:false plus a manual
    // follow-up (tax scale / working-holiday-maker is a payroll decision).
    if (!resident) out.followUps.push(FOLLOW_UP.nonResident);
  }

  // A non-resident for tax cannot claim the tax-free threshold - EH rejects the
  // combination with a 400. Catch it here with an actionable message instead.
  if (resident === false && tft === true) {
    out.issues.push({
      ehField: EH_FIELD.claimTaxFreeThreshold,
      source: "tax declaration",
      reason: "a non-resident for tax cannot claim the tax-free threshold - set that answer to No",
    });
  }

  const help = readBool(EH_FIELD.helpDebt, td.hasHelpOrStslDebt);
  if (help !== undefined) {
    out.fields[EH_FIELD.helpDebt] = help;
    out.fields[EH_FIELD.stslDebt] = help;
  }

  return out;
}

export function applySuper(user: ConnecteamUser, sup: NonNullable<Rules>["super"]): RuleOutput {
  const out: RuleOutput = { fields: {}, followUps: [], issues: [] };
  if (!sup) return out;

  const usi = read(user, sup.usiField);
  const abn = read(user, sup.abnField);
  const fundName = read(user, sup.fundNameField);
  const memberNumber = read(user, sup.memberNumberField);

  const hasUsi = !blank(usi.value);
  const hasAbn = !blank(abn.value);

  if (hasUsi) {
    // APRA-regulated fund. EH calls the USI the "product code".
    out.fields[EH_FIELD.superAllocatedPercentage] = SINGLE_FUND_ALLOCATION;
    try {
      out.fields[EH_FIELD.superProductCode] = trimString(usi.value);
    } catch (err) {
      out.issues.push({ ehField: EH_FIELD.superProductCode, source: usi.label, reason: err instanceof TransformError ? err.message : String(err) });
    }
    if (!blank(fundName.value)) out.fields[EH_FIELD.superFundName] = trimString(fundName.value);
    if (blank(memberNumber.value)) {
      out.issues.push({
        ehField: EH_FIELD.superMemberNumber,
        source: memberNumber.label,
        reason: "APRA super fund USI is set but the member number is missing",
      });
    } else {
      out.fields[EH_FIELD.superMemberNumber] = trimString(memberNumber.value);
    }
    return out;
  }

  if (hasAbn) {
    // Self-managed fund - not synced; payroll sets it up by hand.
    out.followUps.push(FOLLOW_UP.smsfSuper);
    return out;
  }

  // No super details at all - allowed (super is not required for a Complete record).
  return out;
}
