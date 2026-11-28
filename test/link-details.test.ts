import { describe, it, expect } from "vitest";
import { differingDetails } from "../scripts/lib/link-details.js";
import { applyFieldMap } from "../src/mapping/apply.js";
import { parseFieldMap } from "../src/mapping/schema.js";
import { locationField } from "../src/mapping/transforms.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";
import { syntheticUserInEh } from "./fixtures/synthetic-user-in-eh.js";
import demoFieldMap from "./fixtures/demo-field-map.json" with { type: "json" };
import ehBulkEmployee from "./fixtures/eh-bulk-employee.json" with { type: "json" };

/** A real EH bulk-list record's fields and formats with made-up values: shapes from the demo's `/employee/unstructured` list (#232). */
const ehRecord: Record<string, unknown> = ehBulkEmployee;

const map = { rules: { constants: { bankAccount1_AllocatedPercentage: 100 } } };

/** What `differingDetails` returns when only the Residential address group differs, in these fields. */
const residentialAddress = (...fields: string[]) => [{ unit: "residentialAddress", label: "Residential address", fields }];

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
    expect(differingDetails({ ...payload, residentialPostCode: "3000" }, eh, map)).toEqual(residentialAddress("Postcode"));
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

/**
 * The same person as the field map maps them, every detail in the form EH
 * holds it (taken from `ehRecord`); each test puts one into the form
 * Connecteam gives. Suburb is in Connecteam's case, as the demo's are.
 */
const mappedInEhForms: Record<string, unknown> = {
  ...Object.fromEntries(
    [
      "firstName", "surname", "emailAddress", "mobilePhone",
      "residentialStreetAddress", "residentialState", "residentialPostCode", "residentialCountry",
      "emergencyContact1_Name", "emergencyContact1_Relationship", "emergencyContact1_ContactNumber",
      "jobTitle", "employmentType",
      "bankAccount1_AccountName", "bankAccount1_BSB", "bankAccount1_AccountNumber",
      "superFund1_FundName", "superFund1_ProductCode", "superFund1_MemberNumber",
    ].map((f) => [f, ehRecord[f]]),
  ),
  residentialSuburb: "Sampleville",
};

describe("differingDetails against EH's real formats (#232)", () => {
  const detailsAgainst = (pack: Record<string, unknown>, eh: Record<string, unknown> = {}) =>
    differingDetails({ ...mappedInEhForms, ...pack }, { ...ehRecord, ...eh }, map);
  const country = residentialAddress("Country");
  const mobile = [{ unit: "mobilePhone", label: "Mobile", fields: ["Mobile"] }];
  const bankAccount = (...fields: string[]) => [{ unit: "bankAccount1", label: "Bank account", fields }];

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

  it("leaves out two codes from different code systems, unless both are Australia's", () => {
    expect(detailsAgainst({ residentialCountry: "US" }, { residentialCountry: "USA" })).toEqual([]);
    expect(detailsAgainst({ residentialCountry: "AU" }, { residentialCountry: "AUS" })).toEqual([]);
    expect(detailsAgainst({ residentialCountry: "AU" }, { residentialCountry: "NZL" })).toEqual(country);
  });

  it("doesn't list the UK's two codes against each other", () => {
    expect(detailsAgainst({ residentialCountry: "GB" }, { residentialCountry: "UK" })).toEqual([]);
  });

  it("compares the working holiday visa country as the others", () => {
    expect(detailsAgainst({ workingHolidayVisaCountry: "AU" }, { workingHolidayVisaCountry: "Australia" })).toEqual([]);
  });

  it("leaves out a name against a short form EH holds that it can't match", () => {
    expect(detailsAgainst({ residentialCountry: "United Kingdom" }, { residentialCountry: "UK" })).toEqual([]);
  });

  it("doesn't list a phone number EH holds as 61 without the plus", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "61400000001" })).toEqual([]);
  });

  it("doesn't list a number EH holds as +610…, with the trunk 0 kept", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "+610400000001" })).toEqual([]);
  });

  it("doesn't list a home phone that differs only in format", () => {
    expect(detailsAgainst({ homePhone: "+61390000000" }, { homePhone: "(03) 9000 0000" })).toEqual([]);
  });

  it("leaves out an overseas number against a local form, which has no country to compare", () => {
    expect(detailsAgainst({ mobilePhone: "+64 21 123 4567" }, { mobilePhone: "021 123 4567" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+64 21 123 4567" }, { mobilePhone: "+61 400 000 001" })).toEqual(mobile);
  });

  it("leaves out 13, 1300 and 1800 numbers, which phoneAu can't read", () => {
    expect(detailsAgainst({ mobilePhone: "1300 000 000" }, { mobilePhone: "1800 000 000" })).toEqual([]);
    expect(detailsAgainst({ homePhone: "13 00 00" }, { homePhone: "131 000" })).toEqual([]);
  });

  it("still lists a number typed with (0) that is a different number", () => {
    expect(detailsAgainst({ mobilePhone: "+61 (0)400 000 001" }, { mobilePhone: "0400 000 009" })).toEqual(mobile);
    expect(detailsAgainst({ mobilePhone: "+610400000001" }, { mobilePhone: "0400 000 009" })).toEqual(mobile);
  });

  it("keeps the (0) of a country that dials it", () => {
    expect(detailsAgainst({ mobilePhone: "+39 (0)6 1234 5678" }, { mobilePhone: "+39 06 1234 5678" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+39 (0)6 1234 5678" }, { mobilePhone: "+39 6 1234 5678" })).toEqual(mobile);
  });

  it("lists an Australian number of the wrong length against a well-formed one: a real difference", () => {
    expect(detailsAgainst({ mobilePhone: "+6140000000" }, { mobilePhone: "+61400000009" })).toEqual(mobile);
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "0400 000 00" })).toEqual(mobile);
  });

  it("reads 0061 as +61, spaced or not", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "0061 400 000 001" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "00 61 400 000 001" })).toEqual([]);
  });

  it("reads a country code typed in brackets as written, so it's compared against an overseas number", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "(+61) 400 000 001" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "(+61) 400 000 001" })).toEqual(mobile);
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "(61) 400 000 001" })).toEqual(mobile);
  });

  it("leaves out another country's code typed in brackets with its trunk 0, which phoneAu can't settle", () => {
    expect(detailsAgainst({ mobilePhone: "+64 21 123 4567" }, { mobilePhone: "(+64) 021 123 4567" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "(+44)(0)20 7946 0000" })).toEqual([]);
  });

  it("doesn't list a number typed with (0), on either side", () => {
    expect(detailsAgainst({ emergencyContact1_ContactNumber: "+61 (0)400 000 002" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "+61 (0)400 000 001" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: "(0)400 000 001" })).toEqual([]);
  });

  it("reads a dial-out prefix in brackets as overseas, so a different overseas number is listed (#235)", () => {
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "(0011) 44 20 7946 0000" })).toEqual([]);
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0009" }, { mobilePhone: "(0011) 44 20 7946 0000" })).toEqual(mobile);
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "00 (61) 400 000 001" })).toEqual(mobile);
  });

  it("doesn't list a number EH holds with Australia's 0011 international prefix", () => {
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "0011 44 20 7946 0000" })).toEqual([]);
  });

  it("leaves out a number it can't read, rather than listing it", () => {
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "020 7946 0000" })).toEqual([]);
    expect(detailsAgainst({ emergencyContact1_ContactNumber: "ask reception" })).toEqual([]);
  });

  it("still lists a number where EH holds none, readable or not", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000001" }, { mobilePhone: null })).toEqual(mobile);
    expect(detailsAgainst({ mobilePhone: "1300 000 000" }, { mobilePhone: null })).toEqual(mobile);
  });

  it("reads Australia's other international prefixes (0014, 0015, 0018, 0019)", () => {
    for (const prefix of ["0014", "0015", "0018", "0019"]) {
      expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: `${prefix} 44 20 7946 0000` })).toEqual([]);
    }
  });

  it("compares every phone field the field map can fill the same way", () => {
    const fields = ["workPhone", "emergencyContact1_AlternateContactNumber", "emergencyContact2_ContactNumber"];
    for (const f of fields) expect(detailsAgainst({ [f]: "+61400000009" }, { [f]: "0400 000 009" })).toEqual([]);
  });

  it("compares the postal country, second bank accounts and second super funds as their first ones", () => {
    expect(detailsAgainst({ postalCountry: "AU" })).toEqual([]);
    expect(
      detailsAgainst(
        { bankAccount2_BSB: "000-001", bankAccount2_AccountNumber: "1234 5678 9", superFund2_ProductCode: "00 000 000 000 001" },
        { bankAccount2_BSB: "000001", bankAccount2_AccountNumber: "123456789", superFund2_ProductCode: "00000000000001" },
      ),
    ).toEqual([]);
  });

  it("doesn't list an overseas number that differs only in spacing", () => {
    expect(detailsAgainst({ mobilePhone: "+44 20 7946 0000" }, { mobilePhone: "+442079460000" })).toEqual([]);
  });

  it("doesn't list a TFN or ABN typed with spaces", () => {
    expect(detailsAgainst({ taxFileNumber: "000000000" }, { taxFileNumber: "000 000 000" })).toEqual([]);
    expect(detailsAgainst({ contractorABN: "00 000 000 000" }, { contractorABN: "00000000000" })).toEqual([]);
  });

  it("leaves out a value that isn't text (an object or a list), on either side", () => {
    expect(detailsAgainst({ jobTitle: { name: "Barista" } })).toEqual([]);
    expect(detailsAgainst({ jobTitle: ["Barista"] })).toEqual([]);
    expect(detailsAgainst({}, { jobTitle: { name: "Chef" } })).toEqual([]);
  });

  it("lists a street address the field map cut at its first comma: a real difference in what's sent", () => {
    const streetLine = locationField({ address: "Unit 3, 100 Sample Street, Sampleville VIC 3000" }, "streetLine");
    expect(detailsAgainst({ residentialStreetAddress: streetLine }, { residentialStreetAddress: "Unit 3, 100 Sample Street" })).toEqual(residentialAddress("Street address"));
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
    expect(detailsAgainst({ bankAccount1_BSB: "000-002" })).toEqual(bankAccount("BSB"));
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
    const demoMap = parseFieldMap(demoFieldMap);
    const { payload } = applyFieldMap(structuredClone(syntheticUser), demoMap);
    expect(differingDetails(payload, syntheticUserInEh, demoMap)).toEqual([]);
  });

  it("still lists a phone number that is different", () => {
    expect(detailsAgainst({ mobilePhone: "+61400000009" })).toEqual(mobile);
  });

  // The demo's EH list returns all of these as text: a JSON number was never seen.
  describe("defensive: EH returning a number", () => {
    it("doesn't list a postcode EH returns as a number", () => {
      expect(detailsAgainst({ residentialPostCode: "0800" }, { residentialPostCode: 800 })).toEqual([]);
      // Text is compared as typed: an overseas "101" isn't "0101".
      expect(detailsAgainst({ residentialPostCode: "0101" }, { residentialPostCode: "101" })).toEqual(residentialAddress("Postcode"));
    });

    it("doesn't list an account number EH returns as a number", () => {
      expect(detailsAgainst({ bankAccount1_AccountNumber: "00123456" }, { bankAccount1_AccountNumber: 123456 })).toEqual([]);
      expect(detailsAgainst({ bankAccount1_AccountNumber: "00123457" }, { bankAccount1_AccountNumber: 123456 })).toEqual(bankAccount("Account number"));
      expect(detailsAgainst({ bankAccount1_AccountNumber: null }, { bankAccount1_AccountNumber: 0 })).toEqual(bankAccount("Account number"));
    });

    it("doesn't list a BSB that lost its leading zeros, as a number or as text", () => {
      expect(detailsAgainst({ bankAccount1_BSB: "000-001" }, { bankAccount1_BSB: 1 })).toEqual([]);
      expect(detailsAgainst({ bankAccount1_BSB: "012-345" }, { bankAccount1_BSB: "12345" })).toEqual([]);
    });
  });
});
