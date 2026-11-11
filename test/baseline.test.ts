import { describe, it, expect } from "vitest";
import { baselineKeyId, changedUnits, takeBaseline, unitOf, unitsOf } from "../src/sync/baseline.js";

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

  it("holds a field that couldn't be mapped, so fixing it changes that unit", async () => {
    const { taxFileNumber: _tfn, bankAccount1_BSB: _bsb, ...gappy } = payload;
    const withGap = await takeBaseline(gappy, map, "k-one", ["taxFileNumber", "bankAccount1_BSB"]);
    const fixed = await takeBaseline(payload, map, "k-one");

    expect(Object.keys(withGap.units).sort()).toEqual(Object.keys(fixed.units).sort());
    const changed = Object.keys(fixed.units).filter((u) => fixed.units[u] !== withGap.units[u]);
    expect(changed.sort()).toEqual(["bankAccount1", "taxFileNumber"]);
  });

  it("refuses to fingerprint without a key", async () => {
    await expect(takeBaseline(payload, map, "")).rejects.toThrow("BASELINE_KEY is not set");
  });
});

describe("changedUnits", () => {
  it("names each unit that differs, a group once however many of its values changed", async () => {
    const before = await takeBaseline(payload, map, "k-one");
    const now = await takeBaseline({ ...payload, bankAccount1_BSB: "063000", bankAccount1_AccountNumber: "99999999", firstName: "Sam" }, map, "k-one");
    expect(changedUnits(before, now).sort()).toEqual(["bankAccount1", "firstName"]);
    expect(changedUnits(before, before)).toEqual([]);
  });
});

describe("the pay-run unit's fingerprint", () => {
  it("moves with the Connecteam pay rate, not with a field-map default", async () => {
    const before = await takeBaseline(payload, map, "k-one");
    const newDefault = await takeBaseline({ ...payload, paySchedule: "Monthly" }, map, "k-one");
    const newRate = await takeBaseline({ ...payload, rate: 35 }, map, "k-one");

    expect(newDefault.units.payRun).toBe(before.units.payRun);
    expect(newRate.units.payRun).not.toBe(before.units.payRun);
  });
});
