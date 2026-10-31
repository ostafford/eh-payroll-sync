import { describe, it, expect } from "vitest";
import { planMissingFields } from "../scripts/lib/create-fields.js";
import { FIELD_SPEC } from "../scripts/lib/field-spec.js";
import { DEMO_CUSTOM_FIELDS } from "./fixtures/demo-custom-fields.js";

const CATEGORIES = [
  { id: 1, name: "Personal Details" },
  { id: 2, name: "Company Related Info" },
  { id: 3, name: "Super & TAX Information" },
  { id: 4, name: "Payroll Information" },
];

const creatable = FIELD_SPEC.filter((s) => s.create);

describe("planMissingFields", () => {
  it("finds nothing to create on the demo account", () => {
    const plan = planMissingFields(DEMO_CUSTOM_FIELDS, CATEGORIES);
    expect(plan.missing).toEqual([]);
    expect(plan.found).toHaveLength(creatable.length);
  });

  it("plans every field on an empty account, with the exact dropdown options", () => {
    const { missing } = planMissingFields([], CATEGORIES);
    expect(missing.map((m) => m.spec.name)).toEqual(creatable.map((s) => s.name));

    const options = (name: string) =>
      missing.find((m) => m.spec.name === name)!.body.dropdownOptions!.map((o) => o.value);
    expect(options("State")).toEqual(["QLD", "NSW", "VIC", "ACT", "TAS", "SA", "WA", "NT", "INTERNATIONAL"]);
    expect(options("Employee Status")).toEqual(["FullTime", "PartTime", "Casual", "LabourHire"]);
    expect(options("Gender")).toEqual(["Male", "Female", "Other"]);
  });

  it("builds the Connecteam create body for a dropdown and a plain field", () => {
    const { missing } = planMissingFields([], CATEGORIES);
    const body = (name: string) => missing.find((m) => m.spec.name === name)!.body;

    expect(body("Employee Status")).toEqual({
      name: "Employee Status",
      type: "dropdown",
      categoryId: 2,
      isRequired: false,
      isVisibleToAllAdmins: true,
      isEditableForAllAdmins: true,
      isVisibleToUsers: true,
      isEditableForUsers: false,
      isMultiSelect: false,
      dropdownOptions: [
        { value: "FullTime", isDisabled: false },
        { value: "PartTime", isDisabled: false },
        { value: "Casual", isDisabled: false },
        { value: "LabourHire", isDisabled: false },
      ],
    });
    expect(body("TFN")).toEqual({
      name: "TFN",
      type: "str",
      categoryId: 3,
      isRequired: false,
      isVisibleToAllAdmins: true,
      isEditableForAllAdmins: true,
      isVisibleToUsers: true,
      isEditableForUsers: true,
    });
  });

  it("matches a client's own field names, not just the demo's", () => {
    const { missing } = planMissingFields([{ customFieldId: 9, name: "Tax File Number", type: "str" }], CATEGORIES);
    expect(missing.map((m) => m.spec.name)).not.toContain("TFN");
  });

  it("doesn't create a duplicate of a picked field the name pattern misses", () => {
    const fields = [{ customFieldId: 9, name: "Claim Tax Free Threshold?", type: "dropdown" }];
    const plan = planMissingFields(fields, CATEGORIES, { "Claim tax-free threshold?": { id: 9 } });
    expect(plan.missing.map((m) => m.spec.name)).not.toContain("Claim tax-free threshold?");
    expect(plan.found.find((f) => f.spec.name === "Claim tax-free threshold?")?.field.customFieldId).toBe(9);
  });

  it("creates nothing for an ambiguous match or a deleted pick: a human decides first", () => {
    const fields = [
      { customFieldId: 8, name: "TFN", type: "str" },
      { customFieldId: 9, name: "Tax File Number", type: "str" },
    ];
    const plan = planMissingFields(fields, CATEGORIES, { BSB: { id: 99 } });
    expect(plan.missing.map((m) => m.spec.name)).not.toContain("TFN");
    expect(plan.missing.map((m) => m.spec.name)).not.toContain("BSB");
    expect(plan.undecided.map((u) => [u.spec.name, u.reason])).toEqual([
      ["TFN", "ambiguous"],
      ["BSB", "stalePick"],
    ]);
  });

  it("creates a field picked as 'create', even when a wrong-type field matches the name", () => {
    const plan = planMissingFields([{ customFieldId: 8, name: "TFN", type: "number" }], CATEGORIES, { TFN: { create: true } });
    expect(plan.missing.map((m) => m.spec.name)).toContain("TFN");
  });

  it("never creates the optional hours field, missing or skipped (#118)", () => {
    const plan = planMissingFields([], CATEGORIES, { "Standard hours per week": { skip: true } });
    const names = [...plan.missing.map((m) => m.spec.name), ...plan.skipped.map((s) => s.name), ...plan.undecided.map((u) => u.spec.name)];
    expect(names).not.toContain("Standard hours per week");
  });

  it("never creates a skipped field", () => {
    const plan = planMissingFields([], CATEGORIES, { Suburb: { skip: true } });
    expect(plan.missing.map((m) => m.spec.name)).not.toContain("Suburb");
    expect(plan.skipped.map((s) => s.name)).toEqual(["Suburb"]);
  });

  it("files a field under the first category when its own doesn't exist, and says so", () => {
    const { missing } = planMissingFields([], [{ id: 77, name: "General" }]);
    const tfn = missing.find((m) => m.spec.name === "TFN")!;
    expect(tfn.body.categoryId).toBe(77);
    expect(tfn.categoryNote).toBe('no "Super & TAX Information" category - filed under "General"');
  });

  it("never plans a field marked create: false", () => {
    const { missing } = planMissingFields([], CATEGORIES);
    expect(missing.some((m) => m.spec.name === "Standard hours per week")).toBe(false);
  });
});
