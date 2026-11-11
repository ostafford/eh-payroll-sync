import { describe, it, expect } from "vitest";
import {
  classifyAll,
  needsAttention,
  renderPreflight,
  type PreflightEhEmployee,
  type PreflightOptions,
  type PreflightPerson,
  type PreflightRecords,
} from "../scripts/lib/preflight.js";

const person = (over: Partial<PreflightPerson> = {}): PreflightPerson => ({
  ctUserId: 100,
  payrollId: "E0042",
  payrollIdFromField: true,
  detailsComplete: true,
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
  status: "Active",
  ...over,
});
const records = (over: Partial<PreflightRecords> = {}): PreflightRecords => ({ employeeMap: [], pendingLinks: [], ...over });

const opts = (over: Partial<PreflightOptions> = {}): PreflightOptions => ({ payrollIdField: true, records: null, ...over });
const one = (p: PreflightPerson, list: PreflightEhEmployee[], o: Partial<PreflightOptions> = {}) => classifyAll([p], list, opts(o))[0]!;

describe("classifyAll", () => {
  it("is found when the Payroll ID finds one EH employee, listing the keys that agree and differ", () => {
    const r = one(person(), [eh({ id: 1, externalId: "E0042", emailAddress: "JACK@example.com " })]);
    expect(r).toMatchObject({ outcome: "found", eh: [{ ehEmployeeId: 1, agree: ["email"], differs: ["tfn", "nameDob"] }] });
    expect(needsAttention(r)).toBe(false);
  });

  it("is found, nothing agrees, when the Payroll ID finds someone with no agreeing detail: they'll be held", () => {
    const r = one(person(), [eh({ id: 2, externalId: "E0042" })]);
    expect(r).toMatchObject({ outcome: "found-no-agreement", eh: [{ ehEmployeeId: 2, agree: [], differs: ["email", "tfn", "nameDob"] }] });
    expect(needsAttention(r)).toBe(true);
  });

  it("is not found, and created, when nobody holds the Payroll ID and the Pre-create check is clear", () => {
    const r = one(person(), [eh()]);
    expect(r).toMatchObject({ outcome: "not-found", eh: [], hits: [] });
    expect(needsAttention(r)).toBe(false);
  });

  it("is not found but held when the Pre-create check would hit, naming the keys", () => {
    const r = one(person(), [eh({ id: 3, firstName: "JACK", surname: "mitchell", dateOfBirth: "1990-04-01T00:00:00" })]);
    expect(r).toMatchObject({ outcome: "not-found", hits: [{ ehEmployeeId: 3, agree: ["nameDob"] }] });
    expect(needsAttention(r)).toBe(true);
  });

  it("counts a terminated EH employee as a hit, and flags it", () => {
    const r = one(person(), [eh({ id: 4, emailAddress: "jack@example.com", status: "Terminated" })]);
    expect(r.hits).toMatchObject([{ ehEmployeeId: 4, terminated: true, agree: ["email"] }]);
  });

  it("never counts an ATO placeholder TFN as a Pre-create hit", () => {
    const p = person({ payload: { ...person().payload, taxFileNumber: "333333333" } });
    expect(one(p, [eh({ taxFileNumber: "333333333" })]).hits).toEqual([]);
  });

  it("is ID used twice when two Connecteam people share a Payroll ID, for both", () => {
    const rows = classifyAll([person({ ctUserId: 1 }), person({ ctUserId: 2 }), person({ ctUserId: 3, payrollId: "E0043" })], [], opts());
    expect(rows.map((r) => r.outcome)).toEqual(["id-used-twice", "id-used-twice", "not-found"]);
    expect(needsAttention(rows[0]!)).toBe(true);
  });

  it("is ID used twice when more than one EH record holds the Payroll ID", () => {
    const r = one(person(), [eh({ id: 5, externalId: "E0042" }), eh({ id: 6, externalId: "E0042" })]);
    expect(r).toMatchObject({ outcome: "id-used-twice", eh: [{ ehEmployeeId: 5 }, { ehEmployeeId: 6 }] });
  });

  it("is no ID when the setting is on but their field is blank, flagged only on a Pre-create hit", () => {
    const blank = person({ payrollId: "100", payrollIdFromField: false });
    const clear = one(blank, [eh()]);
    expect(clear).toMatchObject({ outcome: "no-id", hits: [] });
    expect(needsAttention(clear)).toBe(false);

    const hit = one(blank, [eh({ id: 7, emailAddress: "jack@example.com" })]);
    expect(hit).toMatchObject({ outcome: "no-id", hits: [{ ehEmployeeId: 7, agree: ["email"] }] });
    expect(needsAttention(hit)).toBe(true);
  });

  it("without the setting, uses the userId: not found is not 'no ID'", () => {
    expect(one(person({ payrollId: "100", payrollIdFromField: false }), [eh()], { payrollIdField: false }).outcome).toBe("not-found");
  });

  it("carries whether their details map cleanly", () => {
    expect(one(person({ detailsComplete: false }), [eh()])).toMatchObject({ outcome: "not-found", detailsComplete: false });
  });

  describe("already synced", () => {
    it("when EH holds their userId (no database to read)", () => {
      const r = one(person({ payrollId: "100", payrollIdFromField: false }), [eh({ id: 8, externalId: "100" })], { payrollIdField: false });
      expect(r).toMatchObject({ outcome: "already-synced", eh: [{ ehEmployeeId: 8 }] });
    });

    it("not held, when they synced before their Payroll ID field was filled: the stored key wins", () => {
      const r = one(person(), [eh({ id: 9, externalId: "100", emailAddress: "jack@example.com" })]);
      expect(r).toMatchObject({ outcome: "already-synced", hits: [] });
    });

    it("from the database, when they synced or were linked under a copied Payroll ID", () => {
      const synced = records({ employeeMap: [{ ctUserId: 100, ehEmployeeId: "10", lastOutcome: "ok" }] });
      const r = one(person(), [eh({ id: 10, externalId: "E0042" })], { records: synced });
      expect(r).toMatchObject({ outcome: "already-synced", eh: [{ ehEmployeeId: 10 }] });
    });

    it("not from a database row that never synced (held, or a failed first attempt)", () => {
      const held = records({ employeeMap: [{ ctUserId: 100, ehEmployeeId: null, lastOutcome: "existing_match" }] });
      expect(one(person(), [eh({ id: 11, externalId: "E0042" })], { records: held }).outcome).toBe("found-no-agreement");
    });
  });

  describe("the Link list", () => {
    it("a pending link to an EH employee links them, whatever their Payroll ID finds", () => {
      const list = records({ pendingLinks: [{ ctUserId: 100, ehEmployeeId: "12" }] });
      const r = one(person(), [eh({ id: 12, status: "Terminated" }), eh({ id: 13, externalId: "E0042" })], { records: list });
      expect(r).toMatchObject({ outcome: "on-link-list", eh: [{ ehEmployeeId: 12, terminated: true }] });
      expect(needsAttention(r)).toBe(false);
    });

    it("'New hire, not this person' skips the Pre-create check, so they're created, not held", () => {
      const list = records({ pendingLinks: [{ ctUserId: 100, ehEmployeeId: null }] });
      const r = one(person(), [eh({ id: 14, emailAddress: "jack@example.com" })], { records: list });
      expect(r).toMatchObject({ outcome: "not-found", hits: [], newHire: true });
      expect(needsAttention(r)).toBe(false);
    });

    it("'New hire' still links when a copied Payroll ID finds them first, as the sync does", () => {
      const list = records({ pendingLinks: [{ ctUserId: 100, ehEmployeeId: null }] });
      expect(one(person(), [eh({ id: 15, externalId: "E0042", emailAddress: "jack@example.com" })], { records: list }).outcome).toBe("found");
    });

    it("someone who already synced isn't re-linked by a pending link", () => {
      const both = records({
        employeeMap: [{ ctUserId: 100, ehEmployeeId: "16", lastOutcome: "follow_up" }],
        pendingLinks: [{ ctUserId: 100, ehEmployeeId: "17" }],
      });
      expect(one(person(), [], { records: both }).outcome).toBe("already-synced");
    });
  });
});

describe("renderPreflight", () => {
  const list = [
    eh({ id: 1, externalId: "E0042", emailAddress: "jack@example.com" }),
    eh({ id: 2, externalId: "E0050" }),
    eh({ id: 3, firstName: "Jack", surname: "Mitchell", dateOfBirth: "1990-04-01T00:00:00", status: "Terminated" }),
  ];
  const people = [
    person({ ctUserId: 11 }),
    person({ ctUserId: 12, payrollId: "E0050" }),
    person({ ctUserId: 13, payrollId: "E0099" }),
    person({ ctUserId: 14, payrollId: "14", payrollIdFromField: false }),
    person({ ctUserId: 15, payrollId: "E0060" }),
    person({ ctUserId: 16, payrollId: "E0060" }),
    person({ ctUserId: 17, payrollId: "E0070", detailsComplete: false, payload: { firstName: "New", surname: "Person" } }),
  ];
  const text = renderPreflight(classifyAll(people, list, opts()), list.length, { recordsRead: false });

  it("lists problems first, with ids and key names", () => {
    const order = ["Payroll ID used twice", "nothing else agrees", "No Payroll ID, and already in EH", "Not found, but already in EH", "Not found: will be created", "Found: will be linked"];
    const at = order.map((t) => text.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("Connecteam 11 -> EH 1 (agrees: email; differs: TFN, name + date of birth)");
    expect(text).toContain("Connecteam 13 -> EH 1 (email), EH 3 terminated (name + date of birth)");
    expect(text).toContain("⚠ 5 people need a look");
  });

  it("marks people whose details don't map yet, and explains it once", () => {
    expect(text).toContain("Connecteam 17 [details incomplete]");
    expect(text).toContain("The sync asks them to finish first");
  });

  it("never prints a TFN, bank, email, name, date of birth or Payroll ID value", () => {
    for (const value of ["123456782", "876543210", "11223344", "jack@example.com", "someone@example.com", "Jack", "Mitchell", "Someone", "1990-04-01", "E0042", "E0050", "E0060", "E0070", "E0099"]) {
      expect(text).not.toContain(value);
    }
  });

  it("says when the database wasn't read, and not when it was", () => {
    expect(text).toContain("The sync's database wasn't read");
    expect(renderPreflight([], 0, { recordsRead: true })).not.toContain("database wasn't read");
  });

  it("shows the Link list's rows", () => {
    const linked = records({ pendingLinks: [{ ctUserId: 21, ehEmployeeId: "5" }, { ctUserId: 22, ehEmployeeId: null }] });
    const out = renderPreflight(classifyAll([person({ ctUserId: 21 }), person({ ctUserId: 22, payrollId: "E0100" })], [], opts({ records: linked })), 0, { recordsRead: true });
    expect(out).toContain("On the Link list: will be linked (1)");
    expect(out).toContain("Connecteam 21 -> EH 5");
    expect(out).toContain("Connecteam 22 [Link list: new hire]");
  });

  it("counts pack assignees with no Connecteam profile", () => {
    expect(renderPreflight([], 0, { missing: 3, recordsRead: true })).toContain("3 more in the pack have no active Connecteam profile (archived or deleted), so aren't checked.");
    expect(renderPreflight([], 0, { recordsRead: true })).not.toContain("no Connecteam profile");
  });

  it("says nothing needs a look when everyone is clear", () => {
    expect(renderPreflight(classifyAll([person()], [eh()], opts()), 1, { recordsRead: true })).toContain("✓ Nothing to look at.");
  });
});
