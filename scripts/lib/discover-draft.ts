/**
 * Builds discover's DRAFT field map from Connecteam custom-field definitions,
 * resolving each field the sync needs (./field-spec.ts) from the human's picks,
 * then by name (./field-resolve.ts).
 */
import type { CustomFieldDefinition } from "./connecteam-custom-fields.js";
import { optionsOf, resolveField, syncedOptions, type FieldPicks } from "./field-resolve.js";
import { FIELD_SPEC, type FieldSpec } from "./field-spec.js";

/** Read by the sync but not sent to EH (Direct manager): resolved like any spec field. */
const SPEC_NOT_SYNCED = "read by the sync, not sent to EH";

/**
 * Other Connecteam fields the sync deliberately doesn't map (docs/field-mapping.md),
 * so discover can say so instead of listing them "for review" (#66).
 */
const NOT_SYNCED: Array<{ match: RegExp; reason: string }> = [
  { match: /^eh pay rate template$/i, reason: "award classification - mapped in the Pay-run settings stage" },
  { match: /^pay type$/i, reason: "superseded by each employee's Connecteam pay rate" },
  { match: /^employee type$/i, reason: "informational only" },
  { match: /^payment method$/i, reason: "every account is paid electronically" },
  { match: /^employee id$/i, reason: "the sync uses the Connecteam user id instead" },
];

export interface DraftInput {
  client: string;
  packId: number;
  businessId: string;
  payScheduleId: string;
  locationId: string;
  fields: CustomFieldDefinition[];
  /** The human's choices (clients/<client>/field-picks.json); name matching fills the rest. */
  picks?: FieldPicks;
}

export interface DraftResult {
  draft: {
    client: string;
    connecteam: { onboardingPackId: number };
    employmentHero: { businessId: string; payScheduleId: string; locationId: string };
    identity: { externalIdFrom: string; emailFallbackFrom: string };
    fields: Array<{ eh: string; from: Record<string, unknown>; transform: string; [k: string]: unknown }>;
    rules: {
      taxDeclaration: Record<string, { customFieldId: number; options?: Record<string, string> }>;
      super: Record<string, number | "TODO">;
      constants: Record<string, unknown>;
    };
  };
  /** Fields mapped 1:1 to an EH field by name. */
  mappedCount: number;
  /** Fields fed into the tax-declaration / super rules. */
  ruleFedCount: number;
  /** Fields neither mapped nor fed into a rule - left for a human to review. */
  unmapped: Array<{ id: number; label: string }>;
  /** Fields the sync deliberately doesn't map, with why - not a problem. */
  notSynced: Array<{ id: number; name: string; reason: string }>;
}

export function buildFieldMapDraft(input: DraftInput): DraftResult {
  const { fields } = input;
  const defs = fields.map((f) => ({ id: f.customFieldId, name: f.name, type: f.type }));
  // An ambiguous match or a deleted pick maps nothing: its fields stay for review.
  const idOf = (spec: FieldSpec): number | undefined => {
    const r = resolveField(spec, defs, input.picks);
    return r.status === "matched" ? r.field.id : undefined;
  };

  const mapped: DraftResult["draft"]["fields"] = [];
  const taxDeclaration: DraftResult["draft"]["rules"]["taxDeclaration"] = {};
  const superFields: DraftResult["draft"]["rules"]["super"] = {};
  const ruleConsumed = new Set<number>();
  const specNotSynced = new Set<number>();
  for (const spec of FIELD_SPEC) {
    const id = idOf(spec);
    const t = spec.target;
    const picked = optionsOf(input.picks?.[spec.name]);
    const options = picked && syncedOptions(picked);
    if (t.kind === "super") superFields[t.key] = id ?? "TODO";
    if (id === undefined) continue;
    if (t.kind === "field") {
      const rule: DraftResult["draft"]["fields"][number] = { eh: t.eh, from: { customFieldId: id }, transform: t.transform };
      if (t.required) rule.required = true;
      if (t.sensitive) rule.sensitive = true;
      // The client's own options, as mapped in the picker, replace the demo's.
      if (options) rule.map = options;
      else if (t.map) rule.map = t.map;
      if (t.default !== undefined) rule.default = t.default;
      mapped.push(rule);
    } else if (t.kind === "taxDeclaration") {
      taxDeclaration[t.key] = { customFieldId: id, ...(options ? { options } : {}) };
      ruleConsumed.add(id);
    } else if (t.kind === "super") ruleConsumed.add(id);
    else specNotSynced.add(id);
  }
  const used = new Set([...mapped.map((r) => r.from.customFieldId as number), ...ruleConsumed, ...specNotSynced]);

  const draft: DraftResult["draft"] = {
    client: input.client,
    connecteam: { onboardingPackId: input.packId },
    employmentHero: {
      businessId: input.businessId || "TODO",
      payScheduleId: input.payScheduleId || "TODO",
      locationId: input.locationId || "TODO",
    },
    identity: { externalIdFrom: "userId", emailFallbackFrom: "email" },
    fields: [
      { eh: "emailAddress", from: { userField: "email" }, transform: "lowerTrim" },
      { eh: "mobilePhone", from: { userField: "phoneNumber" }, transform: "phoneAu" },
      ...mapped,
    ],
    rules: {
      taxDeclaration,
      super: superFields,
      constants: { bankAccount1_AllocatedPercentage: 100, bankAccount1: "Electronic" },
    },
  };

  return {
    draft,
    mappedCount: mapped.length,
    ruleFedCount: ruleConsumed.size,
    // Truly-unmapped = not resolved to any spec field, and not a field the
    // sync deliberately leaves alone.
    unmapped: fields
      .filter((f) => !used.has(f.customFieldId) && !notSyncedReason(f))
      .map((f) => ({ id: f.customFieldId, label: `${f.customFieldId}  ${f.name} (${f.type})` })),
    notSynced: fields.flatMap((f) => {
      const reason = specNotSynced.has(f.customFieldId) ? SPEC_NOT_SYNCED : used.has(f.customFieldId) ? undefined : notSyncedReason(f);
      return reason ? [{ id: f.customFieldId, name: f.name, reason }] : [];
    }),
  };
}

function notSyncedReason(f: CustomFieldDefinition): string | undefined {
  return NOT_SYNCED.find((n) => n.match.test(f.name.trim()))?.reason;
}
