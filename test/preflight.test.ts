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
  excluded: false,
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
type MapRow = PreflightRecords["employeeMap"][number];
const mapRow = (over: Partial<MapRow> & Pick<MapRow, "ctUserId">): MapRow => ({ ehEmployeeId: null, lastOutcome: null, linkedAt: null, externalId: null, ...over });

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

  it("matches EH's Payroll ID as EH's lookup does: case and a trailing space are ignored, a leading space or zero isn't", () => {
    expect(one(person(), [eh({ id: 21, externalId: "e0042", emailAddress: "jack@example.com" })]).outcome).toBe("found");
    expect(one(person(), [eh({ id: 18, externalId: "E0042 ", emailAddress: "jack@example.com" })]).outcome).toBe("found");
    expect(one(person(), [eh({ id: 19, externalId: " E0042", emailAddress: "jack@example.com" })]).outcome).toBe("not-found");
    expect(one(person(), [eh({ id: 20, externalId: "0E0042", emailAddress: "jack@example.com" })]).outcome).toBe("not-found");
  });

  it("is ID used twice when two Connecteam people share a Payroll ID, for both", () => {
    const rows = classifyAll([person({ ctUserId: 1 }), person({ ctUserId: 2 }), person({ ctUserId: 3, payrollId: "E0043" })], [], opts());
    expect(rows.map((r) => r.outcome)).toEqual(["id-used-twice", "id-used-twice", "not-found"]);
    expect(needsAttention(rows[0]!)).toBe(true);
  });

  it("is ID used twice when two Connecteam Payroll IDs differ only in case, as EH treats them as one", () => {
    const rows = classifyAll([person({ ctUserId: 1 }), person({ ctUserId: 2, payrollId: "e0042" })], [], opts());
    expect(rows.map((r) => r.outcome)).toEqual(["id-used-twice", "id-used-twice"]);
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

  describe("details incomplete: the sync asks them to finish before an update or a create", () => {
    const incomplete = person({ detailsComplete: false });

    it("before a create", () => {
      expect(one(incomplete, [eh()])).toMatchObject({ outcome: "not-found", waitsForDetails: true });
    });

    it("before an update of someone synced before, but not a Linked employee (changed-units sync)", () => {
      const synced = records({ employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: "50", lastOutcome: "ok" })] });
      expect(one(incomplete, [], { records: synced })).toMatchObject({ outcome: "already-synced", waitsForDetails: true });
      const linked = records({ employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: "50", lastOutcome: "ok", linkedAt: 1 })] });
      expect(one(incomplete, [], { records: linked })).toMatchObject({ outcome: "already-synced", waitsForDetails: false });
    });

    it("not before a link or a hold by a copied Payroll ID", () => {
      expect(one(incomplete, [eh({ id: 51, externalId: "E0042", emailAddress: "jack@example.com" })])).toMatchObject({ outcome: "found", waitsForDetails: false });
      expect(one(incomplete, [eh({ id: 52, externalId: "E0042" })])).toMatchObject({ outcome: "found-no-agreement", waitsForDetails: false });
    });
  });

  describe("already synced", () => {
    it("from the database, when they synced or were linked under a copied Payroll ID", () => {
      const synced = records({ employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: "10", lastOutcome: "ok" })] });
      const r = one(person(), [eh({ id: 10, externalId: "E0042" })], { records: synced });
      expect(r).toMatchObject({ outcome: "already-synced", eh: [{ ehEmployeeId: 10 }] });
    });

    it("not from a database row that never synced (held, or a failed first attempt)", () => {
      const held = records({ employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: null, lastOutcome: "existing_match" })] });
      expect(one(person(), [eh({ id: 11, externalId: "E0042" })], { records: held }).outcome).toBe("found-no-agreement");
    });
  });

  describe("no database yet (before the first deploy): the same empty start as the sync", () => {
    it("their userId in EH is a previous deployment's, so approval overwrites it", () => {
      const r = one(person({ payrollId: "100", payrollIdFromField: false }), [eh({ id: 8, externalId: "100" })], { payrollIdField: false });
      expect(r).toMatchObject({ outcome: "in-eh-not-synced", eh: [{ ehEmployeeId: 8 }] });
      expect(needsAttention(r)).toBe(true);
    });

    it("with a copied Payroll ID, that's what the sync looks up, so their old record is a Pre-create hit", () => {
      const r = one(person(), [eh({ id: 9, externalId: "100", emailAddress: "jack@example.com" })]);
      expect(r).toMatchObject({ outcome: "not-found", hits: [{ ehEmployeeId: 9, agree: ["email"] }] });
    });
  });

  describe("an EH record the sync already gives to someone else", () => {
    const takenBy200 = records({ employeeMap: [mapRow({ ctUserId: 200, ehEmployeeId: "60", lastOutcome: "ok", externalId: "E0042" })] });

    it("is refused for a copied Payroll ID that agrees, so it's 'used twice', not 'will be linked'", () => {
      const r = one(person(), [eh({ id: 60, externalId: "E0042", emailAddress: "jack@example.com" })], { records: takenBy200 });
      expect(r).toMatchObject({ outcome: "id-used-twice", eh: [{ ehEmployeeId: 60 }] });
      expect(needsAttention(r)).toBe(true);
    });

    it("is refused for any other Payroll ID too (the collision alert)", () => {
      const r = one(person({ payrollId: "E0042", payrollIdFromField: false }), [eh({ id: 60, externalId: "E0042" })], { payrollIdField: false, records: takenBy200 });
      expect(r.outcome).toBe("id-used-twice");
    });

    it("isn't checked against the Link list, as the sync doesn't", () => {
      const listed = records({ pendingLinks: [{ ctUserId: 200, ehEmployeeId: "60" }] });
      expect(one(person(), [eh({ id: 60, externalId: "E0042", emailAddress: "jack@example.com" })], { records: listed }).outcome).toBe("found");
    });
  });

  describe("decided before the Payroll ID is compared, as the sync does", () => {
    it("left out by the exclude rule, whatever EH holds", () => {
      const r = one(person({ excluded: true }), [eh({ id: 30, externalId: "E0042" })]);
      expect(r.outcome).toBe("excluded");
      expect(needsAttention(r)).toBe(false);
    });

    it("a Linked employee stays synced, even when their last outcome wasn't a success", () => {
      const linked = records({ employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: "31", lastOutcome: "correction", linkedAt: 1 })] });
      expect(one(person(), [eh({ id: 32, externalId: "E0042" })], { records: linked })).toMatchObject({ outcome: "already-synced", eh: [{ ehEmployeeId: 31 }] });
    });

    it("compares the Payroll ID stored at their first sync, not a newer copied one", () => {
      const stored = records({ employeeMap: [mapRow({ ctUserId: 100, lastOutcome: "correction", externalId: "E0001" })] });
      const r = one(person(), [eh({ id: 33, externalId: "E0001", emailAddress: "jack@example.com" }), eh({ id: 34, externalId: "E0042" })], { records: stored });
      expect(r).toMatchObject({ outcome: "found", eh: [{ ehEmployeeId: 33 }] });
    });

    it("with the database read, trusts it over a Connecteam ID found in EH (e.g. after a reset)", () => {
      const r = one(person(), [eh({ id: 37, externalId: "100" })], { records: records() });
      expect(r.outcome).toBe("not-found");
    });

    it("keyed by their Connecteam ID, unknown to the database but in EH: approval overwrites that record, so it needs a look", () => {
      const r = one(person({ payrollId: "100", payrollIdFromField: false }), [eh({ id: 39, externalId: "100" })], { payrollIdField: false, records: records() });
      expect(r).toMatchObject({ outcome: "in-eh-not-synced", eh: [{ ehEmployeeId: 39 }] });
      expect(needsAttention(r)).toBe(true);
      expect(renderPreflight([r], 1, { recordsRead: true })).toContain("In EH under this Payroll ID, but never synced: approval overwrites that record (1)");
    });

    it("a stored Payroll ID, with their field now blank, updates their own record with no agreement check, not held", () => {
      // Stored only once EH accepted a write, so a later correction doesn't make the record anyone else's.
      const stored = records({ employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: "38", lastOutcome: "correction", externalId: "E0001" })] });
      const blank = person({ payrollId: "100", payrollIdFromField: false });
      const r = one(blank, [eh({ id: 38, externalId: "E0001" })], { records: stored });
      expect(r).toMatchObject({ outcome: "already-synced", eh: [{ ehEmployeeId: 38 }] });
      expect(needsAttention(r)).toBe(false);
      // And it isn't "no ID": the stored one is used.
      expect(one(blank, [eh()], { records: stored }).outcome).toBe("not-found");
    });

    it("doesn't count someone excluded, synced or on the Link list towards 'used twice'", () => {
      const rec = records({
        employeeMap: [mapRow({ ctUserId: 2, ehEmployeeId: "35", lastOutcome: "ok" })],
        pendingLinks: [{ ctUserId: 3, ehEmployeeId: "36" }],
      });
      const rows = classifyAll([person({ ctUserId: 1 }), person({ ctUserId: 2 }), person({ ctUserId: 3 }), person({ ctUserId: 4, excluded: true })], [], opts({ records: rec }));
      expect(rows.map((r) => r.outcome)).toEqual(["not-found", "already-synced", "on-link-list", "excluded"]);
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
        employeeMap: [mapRow({ ctUserId: 100, ehEmployeeId: "16", lastOutcome: "follow_up" })],
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

  it("says when there's no database yet, and not when it was read", () => {
    expect(text).toContain("There's no database yet");
    expect(renderPreflight([], 0, { recordsRead: true })).not.toContain("no database yet");
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

describe("scripts/preflight.ts errors", () => {
  it("name the HTTP status only, never a response body that could echo an employee's details", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../scripts/preflight.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/r\.text\(\)|\.detail\b/);
    expect(src).toMatch(/throw new Error\(`[^`]*HTTP \$\{/);
  });
});
