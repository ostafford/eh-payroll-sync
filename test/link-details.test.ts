import { describe, it, expect } from "vitest";
import { differingDetails } from "../scripts/lib/link-details.js";

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
