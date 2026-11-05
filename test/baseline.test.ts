import { describe, it, expect } from "vitest";
import { baselineKeyId, takeBaseline, unitOf, unitsOf } from "../src/sync/baseline.js";

const map = { rules: { constants: { bankAccount1_AllocatedPercentage: 100, bankAccount1: "Electronic" } } };

const payload = {
  externalId: "17760356",
  firstName: "Samuel",
  taxFileNumber: "123456782",
  bankAccount1_BSB: "012345",
  bankAccount1_AccountNumber: "00123456",
  bankAccount1_AllocatedPercentage: 100,
  bankAccount1: "Electronic",
  residentialStreetAddress: "12 Example Rd",
  residentialPostCode: "3058",
  emergencyContact1_Name: "Alex Rivera",
  superFund1_ProductCode: "HOS0100AU",
  claimTaxFreeThreshold: true,
  helpDebt: false,
  paySchedule: "Weekly",
  rate: 32.5,
};

describe("units (ADR-0009)", () => {
  it("groups what EH needs sent whole, and keeps other fields on their own", () => {
    expect(unitOf("bankAccount1_BSB")).toBe("bankAccount1");
    expect(unitOf("bankAccount1")).toBe("bankAccount1");
    expect(unitOf("residentialSuburb")).toBe("residentialAddress");
    expect(unitOf("emergencyContact1_Relationship")).toBe("emergencyContact1");
    expect(unitOf("superFund1_MemberNumber")).toBe("super");
    expect(unitOf("stslDebt")).toBe("taxDeclaration");
    expect(unitOf("rateUnit")).toBe("payRun");
    expect(unitOf("mobilePhone")).toBe("mobilePhone");
  });

  it("leaves out the Payroll ID and the constants", () => {
    const units = unitsOf(payload, map);
    expect(Object.keys(units).sort()).toEqual(
      ["bankAccount1", "emergencyContact1", "firstName", "payRun", "residentialAddress", "super", "taxDeclaration", "taxFileNumber"],
    );
    expect(units.bankAccount1).toEqual({ bankAccount1_BSB: "012345", bankAccount1_AccountNumber: "00123456" });
  });
});

describe("takeBaseline", () => {
  it("holds a key id and one HMAC fingerprint per unit, never a value", async () => {
    const b = await takeBaseline(payload, map, "k-one");
    expect(b.keyId).toBe(await baselineKeyId("k-one"));
    expect(b.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(b.units)).toHaveLength(8);
    for (const fp of Object.values(b.units)) expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(b);
    for (const v of ["Samuel", "123456782", "012345", "00123456", "Example Rd", "Alex", "HOS0100AU", "Weekly"]) {
      expect(text).not.toContain(v);
    }
  });

  it("is stable for the same pack and key, whatever the key order", async () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(await takeBaseline(reordered, map, "k-one")).toEqual(await takeBaseline(payload, map, "k-one"));
  });

  it("changes only the unit whose value changed", async () => {
    const a = await takeBaseline(payload, map, "k-one");
    const b = await takeBaseline({ ...payload, residentialPostCode: "3000" }, map, "k-one");
    const changed = Object.keys(a.units).filter((u) => a.units[u] !== b.units[u]);
    expect(changed).toEqual(["residentialAddress"]);
  });

  it("depends on the key, and the key id tells two keys apart", async () => {
    const a = await takeBaseline(payload, map, "k-one");
    const b = await takeBaseline(payload, map, "k-two");
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.units.taxFileNumber).not.toBe(b.units.taxFileNumber);
  });

  it("refuses to fingerprint without a key", async () => {
    await expect(takeBaseline(payload, map, "")).rejects.toThrow("BASELINE_KEY is not set");
  });
});
