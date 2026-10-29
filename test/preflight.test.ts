import { describe, it, expect } from "vitest";
import {
  classifyAll,
  classifyPerson,
  duplicateEmailGroups,
  duplicateTfnGroups,
  hasBlocking,
  renderPreflight,
  type PreflightEhEmployee,
  type PreflightPerson,
} from "../scripts/lib/preflight.js";

const person = (over: Partial<PreflightPerson> = {}): PreflightPerson => ({
  ctUserId: 100,
  name: "Jack Mitchell",
  email: "jack@example.com",
  tfn: "123456782",
  ...over,
});
const eh = (over: Partial<PreflightEhEmployee> = {}): PreflightEhEmployee => ({
  id: 9000,
  name: "Someone Else",
  email: "someone@example.com",
  tfn: "876543210",
  externalId: null,
  ...over,
});

describe("classifyPerson", () => {
  it("is linked when an EH record already carries their Connecteam ID, whatever the TFN says", () => {
    const r = classifyPerson(person(), [eh({ id: 1, externalId: "100", tfn: "999999999" })]);
    expect(r).toMatchObject({ outcome: "linked", ehIds: [1] });
  });

  it("is new when nothing in EH matches by TFN, email or name", () => {
    expect(classifyPerson(person(), [eh()]).outcome).toBe("new");
  });

  it("will merge into the one hand-made EH record with the same TFN", () => {
    const r = classifyPerson(person(), [eh({ id: 2, tfn: "123456782" })]);
    expect(r).toMatchObject({ outcome: "merge", ehIds: [2] });
  });

  it("is ambiguous when two EH records share their TFN (the two-Jacks rehearsal case)", () => {
    const r = classifyPerson(person({ ctUserId: 17760362 }), [
      eh({ id: 14506736, tfn: "123456782", externalId: "17760363" }),
      eh({ id: 14683486, tfn: "123456782" }),
    ]);
    expect(r).toMatchObject({ outcome: "ambiguous", ehIds: [14506736, 14683486] });
  });

  it("is taken when the one TFN match is already linked to another Connecteam person", () => {
    const r = classifyPerson(person(), [eh({ id: 3, tfn: "123456782", externalId: "555" })]);
    expect(r).toMatchObject({ outcome: "taken", ehIds: [3] });
  });

  it("is a likely duplicate when the name or email matches but the TFN does not", () => {
    expect(classifyPerson(person(), [eh({ id: 4, name: "jack  MITCHELL" })])).toMatchObject({
      outcome: "likely-duplicate",
      ehIds: [4],
    });
    expect(classifyPerson(person(), [eh({ id: 5, email: " JACK@example.com " })]).outcome).toBe("likely-duplicate");
  });

  it("does not match on a blank email", () => {
    expect(classifyPerson(person({ email: null }), [eh({ email: null })]).outcome).toBe("new");
  });

  it("reports no TFN rather than guessing", () => {
    expect(classifyPerson(person({ tfn: null }), [eh({ name: "Jack Mitchell" })]).outcome).toBe("no-tfn");
  });

  it("never TFN-matches an exemption code: EH keeps those as separate records", () => {
    const sharing = [eh({ id: 8, tfn: "333333333" }), eh({ id: 9, tfn: "333333333" })];
    expect(classifyPerson(person({ tfn: "333333333" }), sharing).outcome).toBe("new");
  });

  it("is a likely duplicate when an exemption-code person has a hand-made EH record (the two-Jacks case)", () => {
    const r = classifyPerson(person({ ctUserId: 17760363, tfn: "333333333" }), [
      eh({ id: 14683486, name: "Jack Mitchell", email: "jack@example.com", tfn: "333333333" }),
    ]);
    expect(r).toMatchObject({ outcome: "likely-duplicate", ehIds: [14683486] });
  });
});

describe("duplicateTfnGroups", () => {
  it("groups EH records sharing a real TFN and ignores exemption codes and blanks", () => {
    const groups = duplicateTfnGroups([
      eh({ id: 1, tfn: "123456782" }),
      eh({ id: 2, tfn: "123456782" }),
      eh({ id: 3, tfn: "111111111" }),
      eh({ id: 4, tfn: "111111111" }),
      eh({ id: 5, tfn: null }),
      eh({ id: 6, tfn: null }),
    ]);
    expect(groups.map((g) => g.map((e) => e.id))).toEqual([[1, 2]]);
  });
});

describe("duplicateEmailGroups", () => {
  it("groups EH records sharing an email, ignoring case and blanks", () => {
    const groups = duplicateEmailGroups([
      eh({ id: 1, email: "Jack@example.com" }),
      eh({ id: 2, email: " jack@example.com" }),
      eh({ id: 3, email: null }),
      eh({ id: 4, email: null }),
    ]);
    expect(groups.map((g) => g.map((e) => e.id))).toEqual([[1, 2]]);
  });
});

describe("hasBlocking / renderPreflight", () => {
  it("is safe to deploy when everyone is linked, new or a clean merge", () => {
    const ehs = [eh({ id: 1, externalId: "100" }), eh({ id: 2, tfn: "222222222", name: "B", email: "b@x" })];
    const rows = classifyAll(
      [person(), person({ ctUserId: 101, name: "A", email: null, tfn: "333333334" }), person({ ctUserId: 102, name: "Bb", email: null, tfn: "222222222" })],
      ehs,
    );
    expect(rows.map((r) => r.outcome)).toEqual(["linked", "new", "merge"]);
    expect(hasBlocking(rows, ehs)).toBe(false);
    expect(renderPreflight(rows, ehs)).toContain("✓ Nothing to fix. Safe to deploy.");
  });

  it("blocks on duplicate TFNs already in EH even when every person is fine", () => {
    const ehs = [
      eh({ id: 1, externalId: "100" }),
      eh({ id: 2, tfn: "444455556", email: "a@x" }),
      eh({ id: 3, tfn: "444455556", email: "b@x" }),
    ];
    const rows = classifyAll([person()], ehs);
    expect(hasBlocking(rows, ehs)).toBe(true);
    const text = renderPreflight(rows, ehs);
    expect(text).toContain("EH employees sharing a TFN (1 group)");
    expect(text).toContain("✗ 1 thing to fix before deploying.");
  });

  it("blocks on two EH records sharing an email", () => {
    const ehs = [eh({ id: 1, externalId: "100", email: "j@x" }), eh({ id: 2, email: "J@x" })];
    expect(hasBlocking(classifyAll([person()], ehs), ehs)).toBe(true);
    expect(renderPreflight(classifyAll([person()], ehs), ehs)).toContain("EH employees sharing an email (1 group)");
  });

  it("lists problems first and never prints a TFN", () => {
    const ehs = [eh({ id: 7, name: "Jack Mitchell" })];
    const rows = classifyAll([person(), person({ ctUserId: 101, name: "New Person", email: null, tfn: "565656565" })], ehs);
    const text = renderPreflight(rows, ehs);
    expect(text.indexOf("Likely duplicate")).toBeLessThan(text.indexOf("New to EH"));
    expect(text).toContain("Jack Mitchell (Connecteam 100) -> EH 7");
    expect(text).not.toMatch(/123456782|876543210|565656565/);
  });
});
