import { describe, it, expect, vi } from "vitest";
import { listCustomFieldDefinitions } from "../scripts/lib/connecteam-custom-fields.js";
import { buildFieldMapDraft } from "../scripts/lib/discover-draft.js";

const wrap = (customFields: unknown[]) => ({ requestId: "r1", data: { customFields } });

const def = (id: number, name: string, type = "str") => ({ id, name, type });

describe("listCustomFieldDefinitions", () => {
  it("pages through GET /users/v1/custom-fields until a short page", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => def(1000 + i, `Field ${i}`));
    const page2 = [def(2000, "Tax file number")];
    const ctGet = vi.fn(async (path: string) => (path.includes("offset=0") ? wrap(page1) : wrap(page2)));

    const fields = await listCustomFieldDefinitions(ctGet);

    expect(ctGet.mock.calls.map((c) => c[0])).toEqual([
      "/users/v1/custom-fields?limit=50&offset=0",
      "/users/v1/custom-fields?limit=50&offset=50",
    ]);
    expect(fields).toHaveLength(51);
    expect(fields[50]).toEqual({ customFieldId: 2000, name: "Tax file number", type: "str" });
  });
});

describe("buildFieldMapDraft", () => {
  const base = { client: "acme", packId: 5474, businessId: "123", payScheduleId: "9", locationId: "8" };

  // The 7 fields created during the ADR-0006 rehearsal: defined and attached to
  // the pack, but answered by nobody - the case sampling a user's answers missed.
  const rehearsalFields = [
    def(43566219, "Claim the tax-free threshold?", "dropdown"),
    def(43566276, "Are you an Australian resident for tax purposes?", "dropdown"),
    def(43566277, "Do you have a HELP or STSL debt?", "dropdown"),
    def(43566278, "Super fund USI"),
    def(43566279, "Super fund ABN"),
    def(43566280, "Super fund name"),
    def(43566281, "Super member number"),
  ].map(({ id, name, type }) => ({ customFieldId: id, name, type }));

  it("maps field definitions nobody has answered yet into the rules", () => {
    const { draft } = buildFieldMapDraft({ ...base, fields: rehearsalFields });

    expect(draft.rules.taxDeclaration).toEqual({
      claimTaxFreeThreshold: { customFieldId: 43566219 },
      australianResident: { customFieldId: 43566276 },
      hasHelpOrStslDebt: { customFieldId: 43566277 },
    });
    expect(draft.rules.super).toEqual({
      usiField: 43566278,
      abnField: 43566279,
      fundNameField: 43566280,
      memberNumberField: 43566281,
    });
  });

  it("maps known names to EH fields with their transform and flags", () => {
    const { draft, mappedCount } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 1, name: "Tax file number", type: "str" },
        { customFieldId: 2, name: "Title", type: "str" },
      ],
    });

    expect(mappedCount).toBe(2);
    expect(draft.fields).toContainEqual({
      eh: "taxFileNumber",
      from: { customFieldId: 1 },
      transform: "digits",
      required: true,
      sensitive: true,
    });
    expect(draft.fields).toContainEqual({ eh: "jobTitle", from: { customFieldId: 2 }, transform: "trimString" });
  });

  it("maps each EH field once, leaving a second same-named field for review", () => {
    // Account-wide definitions can include an old field the pack no longer uses.
    const { draft, unmapped } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 10, name: "Tax file number", type: "str" },
        { customFieldId: 11, name: "TFN (old)", type: "str" },
      ],
    });

    expect(draft.fields.filter((f) => f.eh === "taxFileNumber")).toHaveLength(1);
    expect(unmapped.map((u) => u.id)).toEqual([11]);
  });

  it("does not take a field containing 'usi' (e.g. Business) as the super USI", () => {
    const { draft, unmapped } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 20, name: "Business name", type: "str" },
        { customFieldId: 21, name: "Super fund USI", type: "str" },
      ],
    });

    expect(draft.rules.super.usiField).toBe(21);
    expect(unmapped.map((u) => u.id)).toEqual([20]);
  });

  it("drafts the demo account's committed field map, apart from pay settings and the award (#62 part 3)", async () => {
    const { DEMO_CUSTOM_FIELDS } = await import("./fixtures/demo-custom-fields.js");
    const committed = (await import("../clients/self/field-map.json", { with: { type: "json" } })).default as any;
    const { draft } = buildFieldMapDraft({ ...base, fields: DEMO_CUSTOM_FIELDS });

    const byEh = (fields: any[]) =>
      Object.fromEntries(fields.filter((r) => r.eh !== "payRateTemplate").map((r) => [r.eh, r]));
    expect(byEh(draft.fields)).toEqual(byEh(committed.fields));
    expect(draft.rules.taxDeclaration).toEqual(committed.rules.taxDeclaration);
    expect(draft.rules.super).toEqual(committed.rules.super);
  });

  it("separates fields the sync deliberately doesn't use from unrecognised ones (#66)", async () => {
    const { DEMO_CUSTOM_FIELDS } = await import("./fixtures/demo-custom-fields.js");
    const { unmapped, notSynced } = buildFieldMapDraft({ ...base, fields: DEMO_CUSTOM_FIELDS });

    expect(unmapped.map((u) => u.id)).toEqual([43580607]); // "Test Field" - genuinely unknown
    expect(notSynced.map((n) => n.name).sort()).toEqual(
      ["Direct manager", "EH Pay Rate Template", "Employee ID", "Employee Type", "Pay Type", "Payment Method"].sort(),
    );
    expect(notSynced.find((n) => n.name === "EH Pay Rate Template")!.reason).toMatch(/Pay-run settings/);
  });

  it("drafts from the picked field IDs, whatever the fields are named (#112)", () => {
    const { draft, unmapped, notSynced } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 30, name: "Postal Code", type: "str" },
        { customFieldId: 31, name: "Higher Education Loan Program (HELP), Student Startup Loan (SSL), Trade Support Loan?", type: "dropdown" },
        { customFieldId: 32, name: "Fund identifier", type: "str" },
        { customFieldId: 33, name: "Reports to", type: "directManager" },
      ],
      picks: {
        Postcode: { id: 30 },
        "Have a HELP/STSL study debt?": { id: 31 },
        "Super Fund USI": { id: 32 },
        "Direct manager": { id: 33 },
      },
    });

    expect(draft.fields).toContainEqual({ eh: "residentialPostCode", from: { customFieldId: 30 }, transform: "zeroPad4" });
    expect(draft.rules.taxDeclaration.hasHelpOrStslDebt).toEqual({ customFieldId: 31 });
    expect(draft.rules.super.usiField).toBe(32);
    expect(notSynced.map((n) => n.id)).toEqual([33]);
    expect(unmapped).toEqual([]);
  });

  it("maps neither of two ambiguous fields, leaving both for review", () => {
    const { draft, unmapped } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 40, name: "TFN", type: "str" },
        { customFieldId: 41, name: "Tax file number", type: "str" },
      ],
    });

    expect(draft.fields.filter((f) => f.eh === "taxFileNumber")).toEqual([]);
    expect(unmapped.map((u) => u.id)).toEqual([40, 41]);
  });

  it("maps nothing from a skipped field, even one whose name matches", () => {
    const { draft, unmapped } = buildFieldMapDraft({
      ...base,
      fields: [{ customFieldId: 50, name: "Title", type: "str" }],
      picks: { Title: { skip: true } },
    });

    expect(draft.fields.filter((f) => f.eh === "jobTitle")).toEqual([]);
    expect(unmapped.map((u) => u.id)).toEqual([50]);
  });

  it("writes picked option mappings into the draft, leaving 'not synced' options out (#112)", () => {
    const { draft } = buildFieldMapDraft({
      ...base,
      fields: [
        { customFieldId: 60, name: "Employee Status", type: "dropdown" },
        { customFieldId: 61, name: "Claim Tax Free Threshold?", type: "dropdown" },
      ],
      picks: {
        "Employee Status": { id: 60, options: { "Full-time": "FullTime", Casual: "Casual", PBV: null } },
        "Claim tax-free threshold?": { id: 61, options: { "Yes, claim tax free threshold": "yes", No: "no", TBC: null } },
      },
    });

    expect(draft.fields.find((f) => f.eh === "employmentType")?.map).toEqual({ "Full-time": "FullTime", Casual: "Casual" });
    expect(draft.rules.taxDeclaration.claimTaxFreeThreshold).toEqual({
      customFieldId: 61,
      options: { "Yes, claim tax free threshold": "yes", No: "no" },
    });
  });

  it("lists unrecognised fields for review", () => {
    const { unmapped } = buildFieldMapDraft({
      ...base,
      fields: [{ customFieldId: 99, name: "Favourite colour", type: "str" }],
    });

    expect(unmapped).toEqual([{ id: 99, label: "99  Favourite colour (str)" }]);
  });
});
