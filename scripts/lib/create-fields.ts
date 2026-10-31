/**
 * Which of the sync's Connecteam custom fields (./field-spec.ts) an account is
 * missing, and the `POST /users/v1/custom-fields` body that creates each one
 * correctly (issue #55).
 */
import type { CustomFieldDefinition } from "./connecteam-custom-fields.js";
import { resolveField, type FieldPicks } from "./field-resolve.js";
import { FIELD_SPEC, type FieldSpec } from "./field-spec.js";

export interface CreateBody {
  name: string;
  type: string;
  categoryId: number;
  isRequired: boolean;
  isVisibleToAllAdmins: boolean;
  isEditableForAllAdmins: boolean;
  isVisibleToUsers: boolean;
  isEditableForUsers: boolean;
  isMultiSelect?: boolean;
  dropdownOptions?: Array<{ value: string; isDisabled: boolean }>;
}

export interface FieldPlan {
  found: Array<{ spec: FieldSpec; field: CustomFieldDefinition }>;
  missing: Array<{ spec: FieldSpec; body: CreateBody; categoryNote?: string }>;
  /** More than one candidate, or a picked field since deleted: never created until a human picks. */
  undecided: Array<{ spec: FieldSpec; reason: "ambiguous" | "stalePick" }>;
  /** The human chose not to use these: never created. */
  skipped: FieldSpec[];
  /** Read from the Connecteam profile (legal-name fields, confirmed): never created. */
  fromProfile: FieldSpec[];
}

export function planMissingFields(
  existing: CustomFieldDefinition[],
  categories: Array<{ id: number; name: string }>,
  picks: FieldPicks = {},
): FieldPlan {
  const plan: FieldPlan = { found: [], missing: [], undecided: [], skipped: [], fromProfile: [] };
  const defs = existing.map((f) => ({ id: f.customFieldId, name: f.name, type: f.type }));
  for (const spec of FIELD_SPEC.filter((s) => s.create)) {
    const resolved = resolveField(spec, defs, picks);
    if (resolved.status === "matched") {
      plan.found.push({ spec, field: existing.find((f) => f.customFieldId === resolved.field.id)! });
      continue;
    }
    if (resolved.status === "skipped") {
      plan.skipped.push(spec);
      continue;
    }
    if (resolved.status === "profile") {
      plan.fromProfile.push(spec);
      continue;
    }
    if (resolved.status !== "none") {
      plan.undecided.push({ spec, reason: resolved.status });
      continue;
    }

    const own = categories.find((c) => c.name.trim().toLowerCase() === spec.ct.category.toLowerCase());
    const category = own ?? categories[0];
    if (!category) throw new Error("the Connecteam account has no custom-field categories to create fields under");

    const body: CreateBody = {
      name: spec.name,
      type: spec.ct.type,
      categoryId: category.id,
      isRequired: spec.ct.isRequired,
      isVisibleToAllAdmins: true,
      isEditableForAllAdmins: true,
      isVisibleToUsers: spec.ct.isVisibleToUsers,
      isEditableForUsers: spec.ct.isEditableForUsers,
    };
    if (spec.ct.type === "dropdown") {
      body.isMultiSelect = false;
      body.dropdownOptions = (spec.ct.options ?? []).map((value) => ({ value, isDisabled: false }));
    }
    plan.missing.push({
      spec,
      body,
      ...(own ? {} : { categoryNote: `no "${spec.ct.category}" category - filed under "${category.name}"` }),
    });
  }
  return plan;
}
