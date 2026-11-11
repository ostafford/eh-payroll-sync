import { describe, it, expect } from "vitest";
import {
  classifyAll,
  needsAttention,
  renderPreflight,
  type PreflightEhEmployee,
  type PreflightPerson,
} from "../scripts/lib/preflight.js";

const person = (over: Partial<PreflightPerson> = {}): PreflightPerson => ({
  ctUserId: 100,
  key: "E0042",
  keyFromField: true,
  payload: {
    firstName: "Jack",
    surname: "Mitchell",
    emailAddress: "jack@example.com",
    taxFileNumber: "123456782",
    dateOfBirth: "1990-04-01",
    bankAccounts_0_accountNumber: "11223344",
    externalId: "E0042",
  },
  ...over,
});
const eh = (over: Partial<PreflightEhEmployee> = {}): PreflightEhEmployee => ({
  id: 9000,
  externalId: null,
  firstName: "Someone",
  surname: "Else",
  emailAddress: "someone@example.com",
  taxFileNumber: "876543210",
  dateOfBirth: "1970-01-01T00:00:00",
  ...over,
});

const one = (p: PreflightPerson, records: PreflightEhEmployee[], fromField = true) => classifyAll([p], records, fromField)[0]!;

describe("classifyAll", () => {
  it("is found when the key finds one EH employee, listing the keys that agree and differ", () => {
    const r = one(person(), [eh({ id: 1, externalId: "E0042", emailAddress: "JACK@example.com " })]);
    expect(r).toMatchObject({ outcome: "found", ehIds: [1], agree: ["email"], differs: ["tfn", "nameDob"] });
    expect(needsAttention(r)).toBe(false);
  });

  it("is found, nothing agrees, when the key finds someone with no agreeing detail: they'll be held", () => {
    const r = one(person(), [eh({ id: 2, externalId: "E0042" })]);
    expect(r).toMatchObject({ outcome: "found-no-agreement", ehIds: [2], agree: [], differs: ["email", "tfn", "nameDob"] });
    expect(needsAttention(r)).toBe(true);
  });

  it("is not found, and created, when nobody holds the key and the Pre-create check is clear", () => {
    const r = one(person(), [eh()]);
    expect(r).toMatchObject({ outcome: "not-found", ehIds: [], hits: [] });
    expect(needsAttention(r)).toBe(false);
  });

  it("is not found but held when the Pre-create check would hit, naming the keys", () => {
    const r = one(person(), [eh({ id: 3, firstName: "JACK", surname: "mitchell", dateOfBirth: "1990-04-01T00:00:00" })]);
    expect(r).toMatchObject({ outcome: "not-found", hits: [{ ehEmployeeId: 3, agree: ["nameDob"] }] });
    expect(needsAttention(r)).toBe(true);
  });

  it("never counts an ATO placeholder TFN as a Pre-create hit", () => {
    const p = person({ payload: { ...person().payload, taxFileNumber: "333333333" } });
    expect(one(p, [eh({ taxFileNumber: "333333333" })]).hits).toEqual([]);
  });

  it("is ID used twice when two Connecteam people share a key, for both", () => {
    const rows = classifyAll([person({ ctUserId: 1 }), person({ ctUserId: 2 }), person({ ctUserId: 3, key: "E0043" })], [], true);
    expect(rows.map((r) => r.outcome)).toEqual(["id-used-twice", "id-used-twice", "not-found"]);
    expect(needsAttention(rows[0]!)).toBe(true);
  });

  it("is ID used twice when more than one EH record holds the key", () => {
    const r = one(person(), [eh({ id: 4, externalId: "E0042" }), eh({ id: 5, externalId: "E0042" })]);
    expect(r).toMatchObject({ outcome: "id-used-twice", ehIds: [4, 5] });
  });

  it("is no ID when the setting is on but their field is blank, flagged only on a Pre-create hit", () => {
    const blank = person({ key: "100", keyFromField: false });
    const clear = one(blank, [eh()]);
    expect(clear).toMatchObject({ outcome: "no-id", hits: [] });
    expect(needsAttention(clear)).toBe(false);

    const hit = one(blank, [eh({ id: 6, emailAddress: "jack@example.com" })]);
    expect(hit).toMatchObject({ outcome: "no-id", hits: [{ ehEmployeeId: 6, agree: ["email"] }] });
    expect(needsAttention(hit)).toBe(true);
  });

  it("without the setting, keys on the userId: not found is not 'no ID'", () => {
    expect(one(person({ key: "100", keyFromField: false }), [eh()], false).outcome).toBe("not-found");
  });

  it("is already synced when EH holds their userId, whatever else agrees", () => {
    const r = one(person({ key: "100", keyFromField: false }), [eh({ id: 7, externalId: "100" })], false);
    expect(r).toMatchObject({ outcome: "already-synced", ehIds: [7] });
  });

  it("is already synced, not held, when they synced before their Payroll ID field was filled: the stored key wins", () => {
    const r = one(person(), [eh({ id: 8, externalId: "100", emailAddress: "jack@example.com" })]);
    expect(r).toMatchObject({ outcome: "already-synced", ehIds: [8], hits: [] });
  });
});

describe("renderPreflight", () => {
  const records = [
    eh({ id: 1, externalId: "E0042", emailAddress: "jack@example.com" }),
    eh({ id: 2, externalId: "E0050" }),
    eh({ id: 3, firstName: "Jack", surname: "Mitchell", dateOfBirth: "1990-04-01T00:00:00" }),
  ];
  const people = [
    person({ ctUserId: 11 }),
    person({ ctUserId: 12, key: "E0050" }),
    person({ ctUserId: 13, key: "E0099" }),
    person({ ctUserId: 14, key: "14", keyFromField: false }),
    person({ ctUserId: 15, key: "E0060" }),
    person({ ctUserId: 16, key: "E0060" }),
  ];

  it("lists problems first, with ids and key names", () => {
    const text = renderPreflight(classifyAll(people, records, true), records.length);
    const order = ["Payroll ID used twice", "nothing else agrees", "No Payroll ID, and already in EH", "Not found, but already in EH", "Found: will be linked"];
    const at = order.map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("Connecteam 11 -> EH 1 (agrees: email; differs: TFN, name + date of birth)");
    expect(text).toContain("Connecteam 13 -> EH 1 (email), EH 3 (name + date of birth)");
    expect(text).toContain("⚠ 5 people need a look");
  });

  it("never prints a TFN, bank, email, name, date of birth or Payroll ID value", () => {
    const text = renderPreflight(classifyAll(people, records, true), records.length);
    for (const value of ["123456782", "876543210", "11223344", "jack@example.com", "someone@example.com", "Jack", "Mitchell", "Someone", "1990-04-01", "E0042", "E0050", "E0060", "E0099"]) {
      expect(text).not.toContain(value);
    }
  });

  it("counts pack assignees with no Connecteam profile", () => {
    expect(renderPreflight([], 0, 3)).toContain("3 more in the pack have no active Connecteam profile (archived or deleted), so aren't checked.");
    expect(renderPreflight([], 0)).not.toContain("no Connecteam profile");
  });

  it("says nothing needs a look when everyone is clear", () => {
    expect(renderPreflight(classifyAll([person()], [eh()], true), 1)).toContain("✓ Nothing to look at.");
  });
});
