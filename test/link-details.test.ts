import { describe, it, expect } from "vitest";
import { differingDetails } from "../scripts/lib/link-details.js";
import { applyFieldMap } from "../src/mapping/apply.js";
import { parseFieldMap } from "../src/mapping/schema.js";
import { phoneAu } from "../src/mapping/transforms.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";
import { syntheticUserInEh } from "./fixtures/synthetic-user-in-eh.js";
import demoFieldMap from "./fixtures/demo-field-map.json" with { type: "json" };
import ehRecord from "./fixtures/eh-bulk-employee.json" with { type: "json" };

const map = { rules: { constants: { bankAccount1_AllocatedPercentage: 100 } } };

/** A pack as the field map maps it. */
const payload = {
  externalId: "17760356",
  firstName: "Samuel",
  surname: "Rivera",
  dateOfBirth: "1990-01-02",
  residentialStreetAddress: "12 Example Rd",
  residentialPostCode: "3058",
  emergencyContact1_Name: "Alex Rivera",
  bankAccount1_AllocatedPercentage: 100,
  paySchedule: "Weekly",
  rate: 32.5,
};

/** The same person in EH's bulk employee list. */
const eh = {
  id: 40213,
  externalId: "17760356",
  firstName: "Samuel",
  surname: "Rivera",
  dateOfBirth: "1990-01-02T00:00:00",
  residentialStreetAddress: "12 Example Rd",
  residentialPostCode: "3058",
  emergencyContact1_Name: "Alex Rivera",
  bankAccount1_AllocatedPercentage: 50,
  paySchedule: "Fortnightly",
};

describe("differingDetails: what the link stage asks Keep EH's / Use Connecteam's about (#230)", () => {
  it("names a group by its unit, with the fields in it that differ", () => {
    expect(differingDetails({ ...payload, residentialPostCode: "3000" }, eh, map)).toEqual([
      { unit: "residentialAddress", label: "Residential address", fields: ["Postcode"] },
    ]);
  });

  it("names a single field by EH's on-screen label", () => {
    expect(differingDetails({ ...payload, firstName: "Sam" }, eh, map)).toEqual([
      { unit: "firstName", label: "First name", fields: ["First name"] },
    ]);
  });

  it("lists nothing when only case, spacing or a date's time differs", () => {
    expect(differingDetails({ ...payload, firstName: " samuel ", residentialStreetAddress: "12  Example rd" }, eh, map)).toEqual([]);
  });

  it("never asks about the pay-run set, a constant, the Payroll ID, or a field EH's list doesn't hold", () => {
    expect(differingDetails({ ...payload, externalId: "999", jobTitle: "Chef" }, eh, map)).toEqual([]);
  });

  it("never carries a value", () => {
    const text = JSON.stringify(differingDetails({ ...payload, residentialPostCode: "3000", firstName: "Sam" }, eh, map));
    for (const v of ["3000", "3058", "Sam\"", "Samuel"]) expect(text).not.toContain(v);
  });
});

/** The same person as the field map maps them, every detail in the form EH holds it; each test puts one into the form Connecteam gives. */
const ehFormPack = {
  firstName: "Jordan",
  surname: "Example",
  emailAddress: "jordan.example+test@example.com",
  mobilePhone: "0400 000 001",
  residentialStreetAddress: "100 Sample Street",
  residentialSuburb: "Sampleville",
  residentialState: "VIC",
  residentialPostCode: "3000",
  residentialCountry: "Australia",
  emergencyContact1_Name: "Casey Example",
  emergencyContact1_Relationship: "Partner",
  emergencyContact1_ContactNumber: "0400000002",
  jobTitle: "Barista",
  employmentType: "Full Time",
  bankAccount1_AccountName: "Jordan Example",
  bankAccount1_BSB: "000001",
  bankAccount1_AccountNumber: "123456789",
  superFund1_FundName: "Sample Super Fund Accumulation Plan",
  superFund1_ProductCode: "00000000000001",
  superFund1_MemberNumber: "100000001",
};

/** `ehRecord`: a real EH bulk-list record's fields and formats, with made-up values: shapes from the demo's `/employee/unstructured` list. */
describe("differingDetails against EH's real formats (#232)", () => {
  const detailsAgainst = (pack: Record<string, unknown>, eh: Record<string, unknown> = {}) =>
    differingDetails({ ...ehFormPack, ...pack }, { ...ehRecord, ...eh }, map);
  const country = [{ unit: "residentialAddress", label: "Residential address", fields: ["Country"] }];

  it("doesn't list a country sent as its code when EH holds its name", () => {
    expect(detailsAgainst({ residentialCountry: "AU" })).toEqual([]);
  });

  it("leaves out a country code it can't match to EH's name, but still lists a different name", () => {
    expect(detailsAgainst({ residentialCountry: "NZ" }, { residentialCountry: "New Zealand" })).toEqual([]);
    expect(detailsAgainst({ residentialCountry: "New Zealand" })).toEqual(country);
  });

  it("lists another country's code where EH holds Australia: only AU and AUS are Australia", () => {
    expect(detailsAgainst({ residentialCountry: "NZ" })).toEqual(country);
  });

  it("matches AU's 3-letter code too", () => {
    expect(detailsAgainst({ residentialCountry: "AUS" })).toEqual([]);
    expect(detailsAgainst({ residentialCountry: "AUS" }, { residentialCountry: "New Zealand" })).toEqual(country);
  });

  it("still lists two different codes, and a code where EH holds no country", () => {
    expect(detailsAgainst({ residentialCountry: "NZ" }, { residentialCountry: "US" })).toEqual(country);
    expect(detailsAgainst({ residentialCountry: "NZ" }, { residentialCountry: null })).toEqual(country);
    expect(detailsAgainst({ residentialCountry: "UK" }, { residentialCountry: "UK" })).toEqual([]);
  });

  it("leaves out a name against a short form EH holds that it can't match", () => {
    expect(detailsAgainst({ residentialCountry: "United Kingdom" }, { residentialCountry: "UK" })).toEqual([]);
  });

  it("doesn't list a phone number EH holds as 61 without the plus, or typed with (0)", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "61400000001" })).toEqual([]);
    expect(detailsAgainst({ emergencyContact1_ContactNumber: "+61 (0)400 000 002" })).toEqual([]);
  });

  it("doesn't list a mobile typed with (0) in Connecteam, as the field map sends it", () => {
    expect(detailsAgainst({ mobilePhone: phoneAu("+61 (0)400 000 001") })).toEqual([]);
  });

  it("doesn't list an overseas number that differs only in spacing", () => {
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "+442079460000" })).toEqual([]);
  });

  it("doesn't list an account number EH returns as a number", () => {
    expect(detailsAgainst({ bankAccount1_AccountNumber: "00123456" }, { bankAccount1_AccountNumber: 123456 })).toEqual([]);
    expect(detailsAgainst({ bankAccount1_AccountNumber: "00123457" }, { bankAccount1_AccountNumber: 123456 })).toEqual([
      { unit: "bankAccount1", label: "Bank account", fields: ["Account number"] },
    ]);
  });

  it("doesn't list a BSB EH returns as a number, and leaves out a value that isn't text", () => {
    expect(detailsAgainst({ bankAccount1_BSB: "000-001" }, { bankAccount1_BSB: 1 })).toEqual([]);
    expect(detailsAgainst({ jobTitle: { name: "Barista" } })).toEqual([]);
  });

  it("doesn't list a phone number sent as +61 when EH holds it spaced, from 0", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001", emergencyContact1_ContactNumber: "+61 400 000 002" })).toEqual([]);
  });

  it("doesn't list an employment type sent without its space", () => {
    expect(detailsAgainst({ employmentType: "FullTime" })).toEqual([]);
    expect(detailsAgainst({ employmentType: "PartTime" })).toEqual([
      { unit: "employmentType", label: "Employment type", fields: ["Employment type"] },
    ]);
  });

  it("doesn't list a BSB, account number or USI sent with spaces or dashes", () => {
    expect(
      detailsAgainst({ bankAccount1_BSB: "000-001", bankAccount1_AccountNumber: "1234 5678 9", superFund1_ProductCode: "00 000 000 000 001" }),
    ).toEqual([]);
  });

  it("still lists a BSB that is different", () => {
    expect(detailsAgainst({ bankAccount1_BSB: "000-002" })).toEqual([{ unit: "bankAccount1", label: "Bank account", fields: ["BSB"] }]);
  });

  it("doesn't list an email or street address that differs only in case", () => {
    expect(detailsAgainst({ emailAddress: "Jordan.Example+test@Example.com", residentialStreetAddress: "100 sample street" })).toEqual([]);
  });

  it("lists nothing for a whole pack in the forms Connecteam gives, when EH holds the same details", () => {
    const fromConnecteam = {
      mobilePhone: "+61400000001",
      emergencyContact1_ContactNumber: "0400000002",
      residentialSuburb: "Sampleville",
      residentialCountry: "AU",
      employmentType: "FullTime",
      dateOfBirth: "1990-01-02",
      superFund1_ProductCode: "00 000 000 000 001",
    };
    expect(detailsAgainst(fromConnecteam)).toEqual([]);
  });

  it("lists nothing for a pack the demo field map makes from a Connecteam user, against EH holding the same details", () => {
    const { payload } = applyFieldMap(structuredClone(syntheticUser), parseFieldMap(demoFieldMap));
    expect(differingDetails(payload, syntheticUserInEh, parseFieldMap(demoFieldMap))).toEqual([]);
  });

  it("still lists a phone number that is different", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000009" })).toEqual([{ unit: "mobilePhone", label: "Mobile", fields: ["Mobile"] }]);
  });
});
