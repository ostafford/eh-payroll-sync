import { describe, it, expect } from "vitest";
import { baselineAtConfirm, baselineKeyId, changedUnits, newUnits, takeBaseline, unitOf, unitsOf } from "../src/sync/baseline.js";

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

/** What a Linked employee's sync sends (ADR-0009): changed units, less those new to the Baseline (baselined, not sent). */
function sentAtLink(before: Awaited<ReturnType<typeof takeBaseline>>, now: Awaited<ReturnType<typeof takeBaseline>>): string[] {
  const fresh = new Set(newUnits(before, now));
  return changedUnits(before, now).filter((u) => !fresh.has(u)).sort();
}

describe("the Baseline taken when a pair is confirmed in the link stage (#230)", () => {
  it("sends at link only what changed since, and every detail marked Use Connecteam's", async () => {
    const confirmed = await baselineAtConfirm(payload, map, "k-one", { useConnecteam: ["residentialAddress"] });
    // Edited while waiting for approval (or while the link was blocked).
    const atLink = await takeBaseline({ ...payload, emergencyContact1_Name: "Jo Rivera" }, map, "k-one");

    expect(sentAtLink(confirmed, atLink)).toEqual(["emergencyContact1", "residentialAddress"]);
  });

  it("leaves the pay-run set out, so at link it's baselined as new and not sent", async () => {
    const confirmed = await baselineAtConfirm(payload, map, "k-one");
    const atLink = await takeBaseline({ ...payload, rate: 35 }, map, "k-one");

    expect(sentAtLink(confirmed, atLink)).toEqual([]);
    expect(newUnits(confirmed, atLink)).toEqual(["payRun"]);
  });

  it("holds no value, and the same key id as a Baseline taken at link", async () => {
    const confirmed = await baselineAtConfirm(payload, map, "k-one", { useConnecteam: ["firstName"] });
    expect(confirmed.keyId).toBe(await baselineKeyId("k-one"));
    const text = JSON.stringify(confirmed);
    for (const v of ["Samuel", "123456782", "012345", "00123456", "Example Rd", "Alex", "HOS0100AU", "Weekly"]) {
      expect(text).not.toContain(v);
    }
  });
});
