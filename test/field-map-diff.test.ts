import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chooseFieldMapWrite, diffFieldMaps } from "../scripts/lib/field-map-diff.js";

const map = (packId: number, businessId: string, fields: Array<{ eh: string; id: number }> = [], extra: object = {}) => ({
  client: "self",
  connecteam: { onboardingPackId: packId },
  employmentHero: { businessId },
  fields: fields.map(({ eh, id }) => ({ eh, from: { customFieldId: id }, transform: "trimString" })),
  rules: { taxDeclaration: {}, super: {} },
  ...extra,
});

describe("chooseFieldMapWrite", () => {
  it("writes the map when none exists", () => {
    expect(chooseFieldMapWrite(undefined, map(1, "2"))).toEqual({ action: "write" });
  });

  it("keeps a map tuned for the same account and writes a draft beside it", () => {
    expect(chooseFieldMapWrite(map(5474, "555455"), map(5474, "555455"))).toEqual({ action: "draft" });
  });

  it("replaces a map that belongs to another account (the demo map in a fresh clone)", () => {
    expect(chooseFieldMapWrite(map(5474, "555455"), map(6120, "701233"))).toEqual({
      action: "replace",
      previous: { packId: 5474, businessId: "555455" },
    });
  });

  it("treats a different EH business on the same pack as another account", () => {
    expect(chooseFieldMapWrite(map(5474, "555455"), map(5474, "999")).action).toBe("replace");
  });

  it("replaces the placeholder npm install copies in, even when it's from this account (#172)", () => {
    const placeholder = JSON.parse(readFileSync(fileURLToPath(new URL("../clients/_example/field-map.json", import.meta.url)), "utf8"));
    const sameAccount = map(placeholder.connecteam.onboardingPackId, placeholder.employmentHero.businessId);
    expect(placeholder.client).toBe("example");
    expect(chooseFieldMapWrite(placeholder, sameAccount)).toEqual({ action: "write" });
  });

  it("keeps an existing map it cannot read the account from", () => {
    expect(chooseFieldMapWrite({ not: "a field map" }, map(1, "2"))).toEqual({ action: "draft" });
  });
});

describe("diffFieldMaps", () => {
  it("reports identical, changed, map-only and draft-only fields", () => {
    const tuned = map(1, "2", [
      { eh: "firstName", id: 10 },
      { eh: "surname", id: 11 },
      { eh: "payRateTemplate", id: 12 },
    ]);
    const draft = map(1, "2", [
      { eh: "firstName", id: 10 },
      { eh: "surname", id: 99 },
      { eh: "jobTitle", id: 13 },
    ]);

    expect(diffFieldMaps(tuned, draft)).toEqual([
      "= 1 field identical",
      "~ surname: your map uses field 11, the draft found field 99",
      "- payRateTemplate: only in your map (kept)",
      "+ jobTitle: only in the draft (field 13)",
    ]);
  });

  it("compares the tax-declaration and super rule fields", () => {
    const tuned = map(1, "2", [], { rules: { taxDeclaration: { australianResident: { customFieldId: 5 } }, super: { usiField: 7 } } });
    const draft = map(1, "2", [], { rules: { taxDeclaration: { australianResident: { customFieldId: 6 } }, super: { usiField: 7 } } });

    expect(diffFieldMaps(tuned, draft)).toEqual([
      "= 1 field identical",
      "~ taxDeclaration.australianResident: your map uses field 5, the draft found field 6",
    ]);
  });

  it("ignores rule options discover doesn't produce (required, default, map)", () => {
    const tuned = map(1, "2", [], {
      fields: [{ eh: "residentialCountry", from: { customFieldId: 4 }, transform: "locationFull", default: "AU", required: true }],
    });
    const draft = map(1, "2", [{ eh: "residentialCountry", id: 4 }]);

    expect(diffFieldMaps(tuned, draft)).toEqual(["= 1 field identical"]);
  });

  it("matches user fields by name", () => {
    const user = { fields: [{ eh: "emailAddress", from: { userField: "email" }, transform: "lowerTrim" }] };
    expect(diffFieldMaps(map(1, "2", [], user), map(1, "2", [], user))).toEqual(["= 1 field identical"]);
  });
});
