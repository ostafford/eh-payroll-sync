import { describe, it, expect } from "vitest";
import { applyOptionMaps } from "../scripts/lib/apply-option-maps.js";

const kept = () => ({
  client: "self",
  employmentHero: { businessId: "1", defaults: { paySchedule: "Weekly" } },
  fields: [
    { eh: "employmentType", from: { customFieldId: 60 }, transform: "dropdownValue", required: true, map: { FullTime: "FullTime" } },
    { eh: "gender", from: { customFieldId: 62 }, transform: "dropdownValue", map: { Male: "Male" } },
  ],
  rules: { taxDeclaration: { claimTaxFreeThreshold: { customFieldId: 61 } } },
});

describe("applyOptionMaps", () => {
  it("writes picked option maps into a kept field map by field ID, touching nothing else", () => {
    const { map, changed } = applyOptionMaps(kept(), {
      "Employee Status": { id: 60, options: { "Full-time": "FullTime", PBV: null } },
      "Claim tax-free threshold?": { id: 61, options: { "Yes, claim tax free threshold": "yes", No: "no", TBC: null } },
      Gender: { id: 62 },
    });

    expect(changed).toEqual(["Employee Status", "Claim tax-free threshold?"]);
    expect(map.fields[0]!.map).toEqual({ "Full-time": "FullTime" });
    expect(map.fields[1]!.map).toEqual({ Male: "Male" });
    expect(map.rules.taxDeclaration.claimTaxFreeThreshold).toEqual({
      customFieldId: 61,
      options: { "Yes, claim tax free threshold": "yes", No: "no" },
    });
    expect(map.employmentHero).toEqual(kept().employmentHero);
  });

  it("reports nothing changed when the map already has them", () => {
    const picks = { "Employee Status": { id: 60, options: { FullTime: "FullTime" } } };
    expect(applyOptionMaps(kept(), picks).changed).toEqual([]);
  });

  it("leaves a field the map reads from a different field ID alone", () => {
    const { map, changed } = applyOptionMaps(kept(), { "Employee Status": { id: 99, options: { "Full-time": "FullTime" } } });
    expect(changed).toEqual([]);
    expect(map.fields[0]!.map).toEqual({ FullTime: "FullTime" });
  });
});
