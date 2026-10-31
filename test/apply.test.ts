import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFieldMap } from "../src/mapping/schema.js";
import { applyFieldMap, type ConnecteamUser } from "../src/mapping/apply.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";

const map = parseFieldMap(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../clients/_example/field-map.json", import.meta.url)), "utf8"),
  ),
);

const clone = (): ConnecteamUser => structuredClone(syntheticUser);

describe("parseFieldMap", () => {
  it("accepts the example map and fills identity defaults", () => {
    expect(map.identity.externalIdFrom).toBe("userId");
    expect(map.fields.length).toBeGreaterThan(15);
  });
  it("rejects an unknown transform with a path-prefixed message", () => {
    const bad = { ...map, fields: [{ eh: "firstName", from: { customFieldId: 1 }, transform: "nope" }] };
    expect(() => parseFieldMap(bad)).toThrow(/fields\.0\.transform/);
  });
  it("rejects unknown top-level keys", () => {
    expect(() => parseFieldMap({ ...map, surprise: true })).toThrow(/Invalid field-map/);
  });

  it("accepts an optional employmentHero.defaults block (issues #26, #34)", () => {
    const withDefaults = {
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: {
          paySchedule: "Weekly",
          primaryLocation: "Head Office",
          primaryPayCategory: "Permanent Ordinary Hours",
          hoursPerWeek: 38,
        },
      },
    };
    expect(parseFieldMap(withDefaults).employmentHero.defaults).toEqual({
      paySchedule: "Weekly",
      primaryLocation: "Head Office",
      primaryPayCategory: "Permanent Ordinary Hours",
      hoursPerWeek: 38,
    });
  });

  it("rejects an unknown key inside employmentHero.defaults", () => {
    const bad = {
      ...map,
      employmentHero: { ...map.employmentHero, defaults: { standardHoursPerWeek: 38 } },
    };
    expect(() => parseFieldMap(bad)).toThrow(/employmentHero\.defaults/);
  });
});

describe("applyFieldMap - employmentHero.defaults (issues #26, #34)", () => {
  it("does nothing when the block is absent - no pay-run keys at all", () => {
    const { payload, payRunDefaultsComplete } = applyFieldMap(clone(), map);
    for (const k of ["paySchedule", "primaryLocation", "payScheduleId", "locationId", "primaryPayCategory", "rate", "awardId"]) {
      expect(payload[k as keyof typeof payload]).toBeUndefined();
    }
    expect(payRunDefaultsComplete).toBe(false);
  });

  it("stamps the complete pay-run set onto the payload verbatim, by name", () => {
    const withDefaults = parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: {
          paySchedule: "Weekly",
          primaryLocation: "Head Office",
          primaryPayCategory: "Permanent Ordinary Hours",
          rate: 30,
          rateUnit: "Hourly",
          hoursPerWeek: 38,
          hoursPerDay: 7.6,
          awardId: 12345,
        },
      },
    });
    const { payload, issues, payRunDefaultsComplete } = applyFieldMap(clone(), withDefaults);
    expect(issues).toEqual([]);
    expect(payRunDefaultsComplete).toBe(true);
    expect(payload.paySchedule).toBe("Weekly");
    expect(payload.primaryLocation).toBe("Head Office");
    expect(payload.primaryPayCategory).toBe("Permanent Ordinary Hours");
    expect(payload.rate).toBe(30);
    expect(payload.rateUnit).toBe("Hourly");
    expect(payload.hoursPerWeek).toBe(38);
    expect(payload.hoursPerDay).toBe(7.6);
    expect(payload.awardId).toBe(12345);
    // never the legacy keys EH ignores
    expect(payload.payScheduleId).toBeUndefined();
    expect(payload.locationId).toBeUndefined();
  });

  it("omits a default that is not set", () => {
    const withOne = parseFieldMap({
      ...map,
      employmentHero: { ...map.employmentHero, defaults: { primaryPayCategory: "Salary" } },
    });
    const { payload, payRunDefaultsComplete } = applyFieldMap(clone(), withOne);
    expect(payload.primaryPayCategory).toBe("Salary");
    expect(payload.hoursPerWeek).toBeUndefined();
    expect(payload.awardId).toBeUndefined();
    // a partial set is not "complete" - EH would 400 it, so no auto-flip
    expect(payRunDefaultsComplete).toBe(false);
  });
});

describe("applyFieldMap - employmentHero.perEmployeeRate (issue #42)", () => {
  const withRate = (defaultsOver: Record<string, unknown> = {}) =>
    parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: {
          paySchedule: "Weekly",
          primaryLocation: "Connecteam",
          primaryPayCategory: "Permanent Ordinary Hours",
          ...defaultsOver,
        },
        perEmployeeRate: { source: "connecteamPayRate" },
      },
    });

  const hourly = { rateType: "hourly", defaultRate: 35, isDefaultRateEnabled: true };

  it("completes the pay-run set from defaults + the Connecteam pay rate", () => {
    const r = applyFieldMap(clone(), withRate(), { payRate: hourly });
    expect(r.payRunIssues).toEqual([]);
    expect(r.payRunDefaultsComplete).toBe(true);
    expect(r.payload.paySchedule).toBe("Weekly");
    expect(r.payload.primaryLocation).toBe("Connecteam");
    expect(r.payload.primaryPayCategory).toBe("Permanent Ordinary Hours");
    expect(r.payload.rate).toBe(35);
    expect(r.payload.rateUnit).toBe("Hourly");
  });

  it("sends the Connecteam pay rate even when EH has one, but keeps EH's location settings (#102)", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: hourly,
      ehRecord: { primaryLocation: "Perth", rate: 30, rateUnit: "Hourly" },
    });
    expect(r.payload.rate).toBe(35);
    expect(r.payload.rateUnit).toBe("Hourly");
    expect(r.payload).not.toHaveProperty("primaryLocation");
    expect(r.payload.paySchedule).toBe("Weekly");
  });

  it("no Connecteam pay rate is fine when EH already has a rate (#102)", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: null,
      ehRecord: { rate: 30, rateUnit: "Hourly" },
    });
    expect(r.payRunIssues).toEqual([]);
    expect(r.payload).not.toHaveProperty("rate");
    expect(r.payload.paySchedule).toBe("Weekly");
    expect(r.payRunDefaultsComplete).toBe(true);
  });

  it("maps rateType yearly -> Annually", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: { rateType: "yearly", defaultRate: 92000, isDefaultRateEnabled: true },
    });
    expect(r.payload.rate).toBe(92000);
    expect(r.payload.rateUnit).toBe("Annually");
    expect(r.payRunDefaultsComplete).toBe(true);
  });

  it("no pay rate on file -> follow-up, and NOT one pay-run key on the payload", () => {
    const r = applyFieldMap(clone(), withRate(), { payRate: null });
    expect(r.payRunIssues).toHaveLength(1);
    expect(r.payRunIssues[0]).toMatch(/no pay rate/i);
    expect(r.payRunDefaultsComplete).toBe(false);
    expect(r.issues).toEqual([]); // admin/config, not an employee-facing correction
    // A per-employee data gap, not a field-map misconfiguration - the sync
    // still creates/updates the record (safety net), just without pay-run keys.
    expect(r.payRunBlocking).toBe(false);
    for (const k of ["paySchedule", "primaryLocation", "primaryPayCategory", "rate", "rateUnit"]) {
      expect(r.payload[k as keyof typeof r.payload]).toBeUndefined();
    }
  });

  it("maps rateType monthly -> Monthly (confirmed 2026-09-11, docs/eh-pay-defaults.md)", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: { rateType: "monthly", defaultRate: 8000, isDefaultRateEnabled: true },
    });
    expect(r.payload.rate).toBe(8000);
    expect(r.payload.rateUnit).toBe("Monthly");
    expect(r.payRunDefaultsComplete).toBe(true);
    expect(r.payRunIssues).toEqual([]);
  });

  it("rejects an unmapped rateType", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: { rateType: "fortnightly", defaultRate: 1500, isDefaultRateEnabled: true },
    });
    expect(r.payRunIssues[0]).toMatch(/fortnightly/i);
    expect(r.payload.rate).toBeUndefined();
    expect(r.payload.rateUnit).toBeUndefined();
    expect(r.payload.paySchedule).toBeUndefined();
  });

  it("rejects a disabled default rate", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: { rateType: "hourly", defaultRate: 35, isDefaultRateEnabled: false },
    });
    expect(r.payRunIssues[0]).toMatch(/turned off/i);
    expect(r.payload.rate).toBeUndefined();
  });

  it("rejects a zero / missing rate value", () => {
    const r = applyFieldMap(clone(), withRate(), {
      payRate: { rateType: "hourly", defaultRate: 0, isDefaultRateEnabled: true },
    });
    expect(r.payRunIssues[0]).toMatch(/zero or missing/i);
  });

  it("names a missing company-wide default - the set stays all-or-nothing", () => {
    const map2 = parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: { paySchedule: "Weekly", primaryLocation: "Connecteam" }, // no primaryPayCategory
        perEmployeeRate: { source: "connecteamPayRate" },
      },
    });
    const r = applyFieldMap(clone(), map2, { payRate: hourly });
    expect(r.payRunIssues.some((s) => s.includes("primaryPayCategory"))).toBe(true);
    expect(r.payload.rate).toBeUndefined();
    expect(r.payload.paySchedule).toBeUndefined();
    // A field-map misconfiguration (affects every employee identically) - blocks
    // the whole write, unlike a per-employee rate/classification gap.
    expect(r.payRunBlocking).toBe(true);
  });

  it("carries a per-employee hoursPerWeek number field, and strips it when the set fails", () => {
    const HOURS_CF = 90000001;
    const mapH = parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: {
          paySchedule: "Weekly",
          primaryLocation: "Connecteam",
          primaryPayCategory: "Permanent Ordinary Hours",
        },
        perEmployeeRate: { source: "connecteamPayRate" },
      },
      fields: [
        ...map.fields,
        { eh: "hoursPerWeek", from: { customFieldId: HOURS_CF }, transform: "number" },
      ],
    });
    const withHours = () => {
      const u = clone();
      u.customFields.push({ customFieldId: HOURS_CF, type: "str", name: "Standard hours/week", value: "38" });
      return u;
    };

    const ok = applyFieldMap(withHours(), mapH, { payRate: hourly });
    expect(ok.payload.hoursPerWeek).toBe(38);
    expect(ok.payRunDefaultsComplete).toBe(true);

    const bad = applyFieldMap(withHours(), mapH, { payRate: null });
    expect(bad.payload.hoursPerWeek).toBeUndefined();
  });

  it("without perEmployeeRate, a passed payRate is ignored (unchanged behaviour)", () => {
    const r = applyFieldMap(clone(), map, { payRate: hourly });
    expect(r.payload.rate).toBeUndefined();
    expect(r.payRunIssues).toEqual([]);
  });
});

describe("applyFieldMap - employmentHero.payRateTemplate (issue #39)", () => {
  const TEMPLATE_CF = 90000002;
  const TEMPLATE = "General Retail Casual L3 21yrs & over";

  const withTemplate = (defaultsOver: Record<string, unknown> = {}) =>
    parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: {
          paySchedule: "Weekly",
          primaryLocation: "Connecteam",
          primaryPayCategory: "Casual - Ordinary Hours",
          ...defaultsOver,
        },
        payRateTemplate: { source: "connecteamField" },
      },
      fields: [
        ...map.fields,
        { eh: "payRateTemplate", from: { customFieldId: TEMPLATE_CF }, transform: "trimString" },
      ],
    });

  const userWith = (value: string | undefined) => {
    const u = clone();
    if (value !== undefined) {
      u.customFields.push({ customFieldId: TEMPLATE_CF, type: "str", name: "EH classification", value });
    }
    return u;
  };

  it("rejects payRateTemplate + perEmployeeRate together", () => {
    const bad = {
      ...map,
      employmentHero: {
        ...map.employmentHero,
        perEmployeeRate: { source: "connecteamPayRate" },
        payRateTemplate: { source: "connecteamField" },
      },
    };
    expect(() => parseFieldMap(bad)).toThrow(/mutually exclusive/i);
  });

  it("completes the pay-run set from the location axis + the classification field", () => {
    const r = applyFieldMap(userWith(TEMPLATE), withTemplate());
    expect(r.payRunIssues).toEqual([]);
    expect(r.payRunDefaultsComplete).toBe(true);
    expect(r.payload.paySchedule).toBe("Weekly");
    expect(r.payload.primaryLocation).toBe("Connecteam");
    expect(r.payload.primaryPayCategory).toBe("Casual - Ordinary Hours");
    expect(r.payload.payRateTemplate).toBe(TEMPLATE);
    // EH derives these from the template - the sync never sends them here
    expect(r.payload.rate).toBeUndefined();
    expect(r.payload.rateUnit).toBeUndefined();
  });

  it("drops any explicit rate / rateUnit - the award template is the sole rate source", () => {
    const r = applyFieldMap(userWith(TEMPLATE), withTemplate({ rate: 30, rateUnit: "Hourly" }));
    expect(r.payload.rate).toBeUndefined();
    expect(r.payload.rateUnit).toBeUndefined();
    expect(r.payload.payRateTemplate).toBe(TEMPLATE);
    expect(r.payRunDefaultsComplete).toBe(true);
  });

  it("no classification on the employee -> follow-up, and not one pay-run key sent", () => {
    const r = applyFieldMap(userWith(undefined), withTemplate());
    expect(r.payRunIssues).toHaveLength(1);
    expect(r.payRunIssues[0]).toMatch(/no pay rate template/i);
    expect(r.payRunDefaultsComplete).toBe(false);
    expect(r.issues).toEqual([]); // admin/config, not an employee-facing correction
    // No classification picked yet is a per-employee data gap, not a
    // misconfiguration - the record still gets created/updated (safety net).
    expect(r.payRunBlocking).toBe(false);
    for (const k of ["paySchedule", "primaryLocation", "primaryPayCategory", "payRateTemplate"]) {
      expect(r.payload[k as keyof typeof r.payload]).toBeUndefined();
    }
  });

  it("names a missing location-axis default - stays all-or-nothing", () => {
    const map2 = parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: { paySchedule: "Weekly", primaryLocation: "Connecteam" }, // no primaryPayCategory
        payRateTemplate: { source: "connecteamField" },
      },
      fields: [
        ...map.fields,
        { eh: "payRateTemplate", from: { customFieldId: TEMPLATE_CF }, transform: "trimString" },
      ],
    });
    const r = applyFieldMap(userWith(TEMPLATE), map2);
    expect(r.payRunIssues.some((s) => s.includes("primaryPayCategory"))).toBe(true);
    expect(r.payload.payRateTemplate).toBeUndefined();
    expect(r.payload.paySchedule).toBeUndefined();
    expect(r.payRunBlocking).toBe(true);
  });

  describe("against EH's existing record (issue #102)", () => {
    const L2 = "General Retail Casual L2 21yrs & over";
    const held = {
      paySchedule: "Fortnightly", // set by hand in EH
      primaryLocation: "Perth",
      primaryPayCategory: "Casual - Ordinary Hours",
      payRateTemplate: TEMPLATE,
    };

    it("a create (no EH record) sends the defaults, as before", () => {
      const r = applyFieldMap(userWith(TEMPLATE), withTemplate(), { ehRecord: null });
      expect(r.payload.paySchedule).toBe("Weekly");
      expect(r.payload.primaryLocation).toBe("Connecteam");
      expect(r.payRunDefaultsComplete).toBe(true);
    });

    it("leaves out a default EH already has a value for, so a hand-set value survives", () => {
      const r = applyFieldMap(userWith(TEMPLATE), withTemplate(), { ehRecord: { paySchedule: "Fortnightly" } });
      expect(r.payload).not.toHaveProperty("paySchedule");
      // EH is blank for these, so the defaults still fill them
      expect(r.payload.primaryLocation).toBe("Connecteam");
      expect(r.payload.primaryPayCategory).toBe("Casual - Ordinary Hours");
      expect(r.payRunIssues).toEqual([]);
      expect(r.payRunDefaultsComplete).toBe(true);
    });

    it("treats a blank EH value as missing and fills it from the default", () => {
      const r = applyFieldMap(userWith(TEMPLATE), withTemplate(), {
        ehRecord: { paySchedule: "", primaryLocation: null },
      });
      expect(r.payload.paySchedule).toBe("Weekly");
      expect(r.payload.primaryLocation).toBe("Connecteam");
    });

    it("always sends the employee's own classification, even when EH has a different one", () => {
      const r = applyFieldMap(userWith(L2), withTemplate(), { ehRecord: held });
      expect(r.payload.payRateTemplate).toBe(L2);
      for (const k of ["paySchedule", "primaryLocation", "primaryPayCategory"]) {
        expect(r.payload).not.toHaveProperty(k);
      }
      expect(r.payRunDefaultsComplete).toBe(true);
    });

    it("a default missing from the field map is fine when EH already has it", () => {
      const r = applyFieldMap(userWith(TEMPLATE), withTemplate({ primaryPayCategory: undefined }), {
        ehRecord: { primaryPayCategory: "Casual - Ordinary Hours" },
      });
      expect(r.payRunIssues).toEqual([]);
      expect(r.payRunBlocking).toBe(false);
      expect(r.payload.payRateTemplate).toBe(TEMPLATE);
      expect(r.payload.paySchedule).toBe("Weekly");
    });

    it("still flags a setting that is blank in both the field map and EH", () => {
      const r = applyFieldMap(userWith(TEMPLATE), withTemplate({ primaryPayCategory: undefined }), {
        ehRecord: { paySchedule: "Weekly" },
      });
      expect(r.payRunIssues.some((s) => s.includes("primaryPayCategory"))).toBe(true);
      expect(r.payRunBlocking).toBe(true);
    });

    it("no classification in Connecteam is fine when EH already has one", () => {
      const r = applyFieldMap(userWith(undefined), withTemplate(), { ehRecord: held });
      expect(r.payRunIssues).toEqual([]);
      expect(r.payload).not.toHaveProperty("payRateTemplate");
      expect(r.payRunDefaultsComplete).toBe(true);
    });
  });

  it("a company-wide defaults.payRateTemplate satisfies the rate axis on its own", () => {
    const m = parseFieldMap({
      ...map,
      employmentHero: {
        ...map.employmentHero,
        defaults: {
          paySchedule: "Weekly",
          primaryLocation: "Connecteam",
          primaryPayCategory: "Casual - Ordinary Hours",
          payRateTemplate: TEMPLATE,
        },
      },
    });
    const r = applyFieldMap(clone(), m);
    expect(r.payRunDefaultsComplete).toBe(true);
    expect(r.payload.payRateTemplate).toBe(TEMPLATE);
    expect(r.payload.rate).toBeUndefined();
  });
});

describe("applyFieldMap - happy path", () => {
  const { payload, issues, externalId, emailFallback, followUps } = applyFieldMap(clone(), map);

  it("produces no issues and no follow-ups for a complete, valid user", () => {
    expect(issues).toEqual([]);
    expect(followUps).toEqual([]);
  });
  it("uses the Connecteam userId as the Employment Hero externalId", () => {
    expect(externalId).toBe("17760356");
    expect(emailFallback).toBe("sam.rivera@example.com");
  });
  it("maps names from the Legal fields, not the display name", () => {
    expect(payload.firstName).toBe("Samuel");
    expect(payload.surname).toBe("Rivera");
  });
  it("converts dates to ISO", () => {
    expect(payload.dateOfBirth).toBe("1992-04-07");
    expect(payload.startDate).toBe("2026-09-01");
  });
  it("reads single-select dropdowns and applies the value map", () => {
    expect(payload.gender).toBe("Female");
    expect(payload.residentialState).toBe("VIC");
    expect(payload.employmentType).toBe("FullTime");
  });
  it("normalises phone to E.164 and email to lower-case", () => {
    expect(payload.mobilePhone).toBe("+61411000111");
    expect(payload.emailAddress).toBe("sam.rivera@example.com");
  });
  it("takes the street line from the location and pads the postcode", () => {
    expect(payload.residentialStreetAddress).toBe("12 Example Rd");
    expect(payload.residentialSuburb).toBe("Coburg");
    expect(payload.residentialPostCode).toBe("3058");
  });
  it("maps country via the lookup", () => {
    expect(payload.residentialCountry).toBe("AU");
  });

  it("resolves the tax file declaration to booleans", () => {
    expect(payload.claimTaxFreeThreshold).toBe(true);
    expect(payload.australianResident).toBe(true);
    expect(payload.helpDebt).toBe(false);
    expect(payload.stslDebt).toBe(false);
  });

  it("maps an APRA super fund (USI present)", () => {
    expect(payload.superFund1_ProductCode).toBe("HOS0100AU");
    expect(payload.superFund1_FundName).toBe("Hostplus");
    expect(payload.superFund1_MemberNumber).toBe("M123456");
    // EH rejects super details with no allocation; v1 is a single fund at 100%.
    expect(payload.superFund1_AllocatedPercentage).toBe(100);
  });

  it("folds in constants and the external id", () => {
    expect(payload.bankAccount1_AllocatedPercentage).toBe(100);
    expect(payload.externalId).toBe("17760356");
  });
  it("does NOT emit the legacy payScheduleId / locationId keys (issue #34)", () => {
    expect(payload.payScheduleId).toBeUndefined();
    expect(payload.locationId).toBeUndefined();
  });
  it("keeps leading zeros on BSB and account number, strips separators from TFN", () => {
    expect(payload.taxFileNumber).toBe("123456782");
    expect(payload.bankAccount1_BSB).toBe("012345");
    expect(payload.bankAccount1_AccountNumber).toBe("00123456");
  });
});

describe("applyFieldMap - missing and bad values", () => {
  it("flags a missing required field as an issue, keyed to the EH + source field", () => {
    const u = clone();
    u.customFields = u.customFields.filter((f) => f.customFieldId !== 42920714); // drop Legal Surname
    const { issues, payload } = applyFieldMap(u, map);
    expect(payload.surname).toBeUndefined();
    expect(issues).toContainEqual({
      ehField: "surname",
      source: "customField 42920714 (not present)",
      reason: "required value is missing or blank",
    });
  });

  it("silently skips a missing optional field", () => {
    const u = clone();
    u.customFields = u.customFields.filter((f) => f.customFieldId !== 25145108); // drop Title
    const { issues, payload } = applyFieldMap(u, map);
    expect(payload.jobTitle).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it("reports a bad date rather than throwing", () => {
    const u = clone();
    u.customFields.find((f) => f.customFieldId === 25145118)!.value = "1992-04-07";
    const { issues } = applyFieldMap(u, map);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.ehField).toBe("dateOfBirth");
    expect(issues[0]!.reason).toMatch(/DD\/MM\/YYYY/);
  });

  it("reports an unmapped dropdown value against the allowed list", () => {
    const u = clone();
    u.customFields.find((f) => f.customFieldId === 42920839)!.value = [{ id: 9, value: "Contractor" }];
    const { issues } = applyFieldMap(u, map);
    expect(issues[0]!.ehField).toBe("employmentType");
    expect(issues[0]!.reason).toMatch(/FullTime, PartTime, Casual, LabourHire/);
  });

  it("falls back to the default when the source is blank", () => {
    const u = clone();
    u.customFields.find((f) => f.customFieldId === 42920716)!.value = null;
    const { payload, issues } = applyFieldMap(u, map);
    expect(issues).toEqual([]);
    expect(payload.residentialCountry).toBe("AU");
  });
});

describe("applyFieldMap - rules engine", () => {
  const setField = (u: ConnecteamUser, id: number, value: unknown) => {
    u.customFields.find((f) => f.customFieldId === id)!.value = value;
  };
  const dropField = (u: ConnecteamUser, id: number) => {
    u.customFields = u.customFields.filter((f) => f.customFieldId !== id);
  };

  it("marks a non-resident and raises a follow-up", () => {
    const u = clone();
    setField(u, 42923315, [{ id: 1, value: "No" }]); // not an Australian resident
    setField(u, 42923276, [{ id: 1, value: "No" }]); // ...so, consistently, no tax-free threshold
    const { payload, followUps, issues } = applyFieldMap(u, map);
    expect(issues).toEqual([]);
    expect(payload.australianResident).toBe(false);
    expect(payload.isNonResident).toBeUndefined();
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/foreign-resident or working-holiday-maker/);
  });

  it("raises a correction when a non-resident still claims the tax-free threshold", () => {
    const u = clone();
    setField(u, 42923315, [{ id: 1, value: "No" }]); // non-resident
    // 42923276 (claim tax-free threshold) stays "Yes" from the fixture - the conflict
    const { issues } = applyFieldMap(u, map);
    expect(issues).toContainEqual(
      expect.objectContaining({
        ehField: "claimTaxFreeThreshold",
        reason: expect.stringContaining("non-resident"),
      }),
    );
  });

  it("does not sync an SMSF, raises a follow-up instead", () => {
    const u = clone();
    setField(u, 42920803, ""); // clear USI
    const { payload, followUps } = applyFieldMap(u, map);
    expect(payload.superFund1_ProductCode).toBeUndefined();
    expect(payload.superFund1_MemberNumber).toBeUndefined();
    expect(payload.superFund1_AllocatedPercentage).toBeUndefined();
    expect(followUps).toContain(
      "Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.",
    );
  });

  it("flags an APRA fund with a missing member number", () => {
    const u = clone();
    setField(u, 42920804, "");
    const { issues } = applyFieldMap(u, map);
    expect(issues).toContainEqual({
      ehField: "superFund1_MemberNumber",
      source: "customField 42920804 (Member Number)",
      reason: "APRA super fund USI is set but the member number is missing",
    });
  });

  it("flags each missing tax-declaration answer", () => {
    const u = clone();
    dropField(u, 42923276);
    dropField(u, 42923315);
    const { issues } = applyFieldMap(u, map);
    const ehFields = issues.map((i) => i.ehField).sort();
    expect(ehFields).toEqual(["australianResident", "claimTaxFreeThreshold"]);
    expect(issues.every((i) => i.reason === "required Yes/No answer is missing")).toBe(true);
  });

  describe("a tax-declaration option map (#112: a client's own answer wording)", () => {
    const withOptions = parseFieldMap({
      ...map,
      rules: {
        ...map.rules,
        taxDeclaration: {
          ...map.rules!.taxDeclaration,
          claimTaxFreeThreshold: { customFieldId: 42923276, options: { "Yes, claim tax free threshold": "yes", No: "no" } },
        },
      },
    });

    it("reads a mapped answer as Yes or No", () => {
      const u = clone();
      setField(u, 42923276, [{ id: 1, value: "Yes, claim tax free threshold" }]);
      const { payload, issues } = applyFieldMap(u, withOptions);
      expect(issues).toEqual([]);
      expect(payload.claimTaxFreeThreshold).toBe(true);
    });

    it("holds an unmapped answer (N/A, TBC) for a Correction, even a plain 'Yes'", () => {
      for (const answer of ["N/A", "TBC", "Yes"]) {
        const u = clone();
        setField(u, 42923276, [{ id: 1, value: answer }]);
        const { payload, issues } = applyFieldMap(u, withOptions);
        expect(payload.claimTaxFreeThreshold).toBeUndefined();
        expect(issues).toContainEqual(
          expect.objectContaining({ ehField: "claimTaxFreeThreshold", reason: expect.stringContaining(`"${answer}"`) }),
        );
      }
    });
  });

  it("flags a tax-declaration answer that isn't Yes or No", () => {
    const u = clone();
    setField(u, 42923316, [{ id: 2, value: "Unsure" }]);
    const { issues } = applyFieldMap(u, map);
    expect(issues[0]!.ehField).toBe("helpDebt");
    expect(issues[0]!.reason).toMatch(/expected "Yes" or "No"/);
  });

  it("raises a follow-up for an INTERNATIONAL address", () => {
    const u = clone();
    setField(u, 42920838, [{ id: 9, value: "INTERNATIONAL" }]);
    const { payload, followUps } = applyFieldMap(u, map);
    expect(payload.residentialState).toBe("INTERNATIONAL");
    expect(followUps).toContain(
      "Address state is INTERNATIONAL - enter the overseas residential address in Employment Hero manually.",
    );
  });
});
