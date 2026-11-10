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
    }, []);

    expect(changed).toEqual(["Employee Status", "Claim tax-free threshold?"]);
    expect(map.fields[0]!.map).toEqual({ "Full-time": "FullTime" });
    expect(map.fields[1]!.map).toEqual({ Male: "Male" });
    expect(map.rules.taxDeclaration.claimTaxFreeThreshold).toEqual({
      customFieldId: 61,
      options: { "Yes, claim tax free threshold": "yes", No: "no" },
    });
    expect(map.employmentHero).toEqual(kept().employmentHero);
  });

  it("writes the EH Payroll ID pick into a kept map's identity, and a skip puts back the user id (#167)", () => {
    const fields = [{ customFieldId: 70, name: "Employee ID", type: "str" }];
    const picked = applyOptionMaps(kept(), { "EH Payroll ID": { id: 70 } }, fields);
    expect(picked.changed).toEqual(["EH Payroll ID"]);
    expect(picked.map).toMatchObject({ identity: { externalIdFrom: { customFieldId: 70, name: "Employee ID" } }, fields: kept().fields });

    expect(applyOptionMaps(picked.map, { "EH Payroll ID": { id: 70 } }, fields).changed).toEqual([]);
    // Renamed in Connecteam: the map takes the new name.
    const renamed = applyOptionMaps(picked.map, { "EH Payroll ID": { id: 70 } }, [{ ...fields[0]!, name: "Payroll Number" }]);
    expect((renamed.map as any).identity.externalIdFrom).toEqual({ customFieldId: 70, name: "Payroll Number" });
    const skipped = applyOptionMaps(picked.map, { "EH Payroll ID": { skip: true } }, fields);
    expect(skipped.changed).toEqual(["EH Payroll ID"]);
    expect((skipped.map as any).identity.externalIdFrom).toBe("userId");
    // Never asked: the map is left as it is.
    expect(applyOptionMaps(kept(), {}, [])).toEqual({ map: kept(), changed: [] });
  });

  it("reports nothing changed when the map already has them", () => {
    const picks = { "Employee Status": { id: 60, options: { FullTime: "FullTime" } } };
    expect(applyOptionMaps(kept(), picks, []).changed).toEqual([]);
  });

  it("leaves a field the map reads from a different field ID alone", () => {
    const { map, changed } = applyOptionMaps(kept(), { "Employee Status": { id: 99, options: { "Full-time": "FullTime" } } }, []);
    expect(changed).toEqual([]);
    expect(map.fields[0]!.map).toEqual({ FullTime: "FullTime" });
  });

  it("writes the answers to leave out into the kept map's rules.exclude, replacing that field's entry", () => {
    const map = { ...kept(), rules: { ...kept().rules, exclude: [{ customFieldId: 60, values: ["Old"] }, { customFieldId: 9, values: ["X"] }] } };
    const { map: out, changed } = applyOptionMaps(map, { "Employee Status": { id: 60, options: { "Full-time": "FullTime", PBV: null }, exclude: ["PBV"] } }, []);
    expect(out.rules.exclude).toEqual([{ customFieldId: 9, values: ["X"] }, { customFieldId: 60, values: ["PBV"] }]);
    expect(changed).toContain("Employee Status");
  });
});
