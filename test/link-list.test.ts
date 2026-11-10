import { describe, it, expect } from "vitest";
import {
  buildLinkList,
  type LinkCtUser,
  type LinkEhEmployee,
  type LinkListInput,
} from "../scripts/lib/link-list.js";

const ct = (over: Partial<LinkCtUser> = {}): LinkCtUser => ({
  ctUserId: 100,
  firstName: "Jack",
  lastName: "Mitchell",
  email: "jack@example.com",
  payrollId: "100",
  ...over,
});
const eh = (over: Partial<LinkEhEmployee> = {}): LinkEhEmployee => ({
  id: 9000,
  firstName: "Jack",
  surname: "Mitchell",
  email: "jack@example.com",
  externalId: null,
  status: "Active",
  ...over,
});
const input = (over: Partial<LinkListInput> = {}): LinkListInput => ({
  ctUsers: [],
  ehEmployees: [],
  assignments: [],
  employeeMap: [],
  pendingLinks: [],
  heldCandidates: new Map(),
  ...over,
});

describe("buildLinkList", () => {
  it("matches one Connecteam user to the one EH employee with the same email and name, ignoring email case", () => {
    const { rows } = buildLinkList(
      input({ ctUsers: [ct({ email: "Jack@Example.com" })], ehEmployees: [eh({ id: 40213, email: "jack@EXAMPLE.com" })] }),
    );
    expect(rows).toEqual([
      expect.objectContaining({ ctUserId: 100, kind: "matched", suggestion: "40213" }),
    ]);
  });

  it("makes a Connecteam user with no EH match a new hire", () => {
    const { rows } = buildLinkList(
      input({ ctUsers: [ct()], ehEmployees: [eh({ firstName: "Mia", surname: "Chen", email: "mia@example.com" })] }),
    );
    expect(rows).toEqual([expect.objectContaining({ ctUserId: 100, kind: "newHire", suggestion: null })]);
  });

  it("counts EH employees no Connecteam user matches, without listing them", () => {
    const list = buildLinkList(
      input({
        ctUsers: [ct(), ct({ ctUserId: 555, firstName: "Mia", lastName: "Chen", email: "mia@example.com", payrollId: "555" })],
        ehEmployees: [
          eh({ id: 40213 }),
          eh({ id: 40377, firstName: "Mia", surname: "Chen", email: "mia@example.com", externalId: "555" }),
          eh({ id: 40400, firstName: "Ana", surname: "Silva", email: "ana@example.com" }),
          eh({ id: 40401, firstName: "Tom", surname: "Ng", email: "tom@example.com" }),
        ],
        employeeMap: [{ ctUserId: 555, ehEmployeeId: "40377", lastOutcome: "ok" }],
      }),
    );
    expect(list.ignoredEhCount).toBe(2);
    expect(list.rows.map((r) => r.ctUserId)).toEqual([100]);
  });

  describe("needs your choice, never auto-proposed", () => {
    it("when the email matches but the name differs", () => {
      const { rows } = buildLinkList(input({ ctUsers: [ct()], ehEmployees: [eh({ id: 40213, firstName: "John" })] }));
      expect(rows).toEqual([
        expect.objectContaining({
          kind: "choice",
          suggestion: null,
          candidates: [{ ehEmployeeId: "40213", reasons: ["nameDiffers"] }],
        }),
      ]);
    });

    it("when the same email is on several EH employees, even with agreeing names", () => {
      const { rows } = buildLinkList(
        input({ ctUsers: [ct()], ehEmployees: [eh({ id: 40213 }), eh({ id: 40377, firstName: "Jackson" })] }),
      );
      expect(rows).toEqual([
        expect.objectContaining({
          kind: "choice",
          candidates: [
            { ehEmployeeId: "40213", reasons: ["sameEmailSeveral"] },
            { ehEmployeeId: "40377", reasons: ["nameDiffers", "sameEmailSeveral"] },
          ],
        }),
      ]);
    });

    it("when the same email is on several Connecteam users", () => {
      const { rows } = buildLinkList(
        input({ ctUsers: [ct(), ct({ ctUserId: 101, payrollId: "101" })], ehEmployees: [eh({ id: 40213 })] }),
      );
      expect(rows.map((r) => [r.ctUserId, r.kind, r.candidates])).toEqual([
        [100, "choice", [{ ehEmployeeId: "40213", reasons: ["sameEmailSeveral"] }]],
        [101, "choice", [{ ehEmployeeId: "40213", reasons: ["sameEmailSeveral"] }]],
      ]);
    });

    it("when only the name matches, including a Connecteam user with no email", () => {
      const { rows } = buildLinkList(
        input({
          ctUsers: [ct(), ct({ ctUserId: 101, payrollId: "101", email: null })],
          ehEmployees: [eh({ id: 40213, firstName: " jack ", email: "jmitchell@old.example.com" })],
        }),
      );
      expect(rows.map((r) => [r.ctUserId, r.kind, r.candidates])).toEqual([
        [100, "choice", [{ ehEmployeeId: "40213", reasons: ["nameOnly"] }]],
        [101, "choice", [{ ehEmployeeId: "40213", reasons: ["nameOnly"] }]],
      ]);
    });

    it("when the EH employee already has a Payroll ID that is no Connecteam user's (linking would overwrite it)", () => {
      const { rows } = buildLinkList(input({ ctUsers: [ct()], ehEmployees: [eh({ id: 40213, externalId: "EMP042" })] }));
      expect(rows).toEqual([
        expect.objectContaining({
          kind: "choice",
          candidates: [{ ehEmployeeId: "40213", reasons: ["hasPayrollId"], payrollId: "EMP042" }],
        }),
      ]);
    });

    it("when the EH employee is terminated, though email and name agree", () => {
      const { rows } = buildLinkList(input({ ctUsers: [ct()], ehEmployees: [eh({ id: 40213, status: "Terminated" })] }));
      expect(rows).toEqual([
        expect.objectContaining({
          kind: "choice",
          suggestion: null,
          candidates: [{ ehEmployeeId: "40213", reasons: ["terminated"] }],
        }),
      ]);
    });
  });

  it("shows a Held employee with the Pre-create check's candidates and the choice of new hire", () => {
    const { rows } = buildLinkList(
      input({
        ctUsers: [ct({ email: "jack.new@example.com" })],
        ehEmployees: [
          eh({ id: 40213 }),
          eh({ id: 40377, firstName: "Jackson", email: "jm@example.com", status: "Terminated" }),
        ],
        employeeMap: [{ ctUserId: 100, ehEmployeeId: null, lastOutcome: "existing_match" }],
        heldCandidates: new Map([[100, ["40213", "40377"]]]),
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "held",
        suggestion: null,
        newHireChoice: true,
        candidates: [
          { ehEmployeeId: "40213", reasons: [] },
          { ehEmployeeId: "40377", reasons: ["terminated"] },
        ],
      }),
    ]);
  });

  it("shows a link saved on an earlier run as saved, so a re-run can keep or change it, held or not", () => {
    const { rows } = buildLinkList(
      input({
        ctUsers: [ct(), ct({ ctUserId: 101, firstName: "Mia", lastName: "Chen", email: "mia@example.com", payrollId: "101" })],
        ehEmployees: [eh({ id: 40213, firstName: "John" })],
        employeeMap: [{ ctUserId: 101, ehEmployeeId: null, lastOutcome: "existing_match" }],
        pendingLinks: [
          { ctUserId: 100, ehEmployeeId: "40213" },
          { ctUserId: 101, ehEmployeeId: null },
        ],
        heldCandidates: new Map([[101, ["40213"]]]),
      }),
    );
    expect(rows.map((r) => [r.ctUserId, r.kind, r.suggestion])).toEqual([
      [100, "saved", "40213"],
      [101, "saved", null],
    ]);
  });

  it("gives every row a pack status from Connecteam's status and isWaitingApproval, the furthest along when there are several", () => {
    const users = [100, 101, 102, 103, 104].map((id) =>
      ct({ ctUserId: id, firstName: `F${id}`, email: `u${id}@example.com`, payrollId: String(id) }),
    );
    const { rows } = buildLinkList(
      input({
        ctUsers: users,
        assignments: [
          { userId: 101, status: "in_progress", isWaitingApproval: false },
          { userId: 102, status: "completed", isWaitingApproval: true },
          { userId: 103, status: "completed", isWaitingApproval: false },
          { userId: 104, status: "completed", isWaitingApproval: false },
          { userId: 104, status: "in_progress", isWaitingApproval: false },
        ],
      }),
    );
    expect(rows.map((r) => [r.ctUserId, r.pack])).toEqual([
      [100, "notAssigned"],
      [101, "inProgress"],
      [102, "readyForReview"],
      [103, "approvedNotSynced"],
      [104, "approvedNotSynced"],
    ]);
  });

  it("never reads a TFN or date of birth, even when the records carry them", () => {
    const forbidden = ["tfn", "taxFileNumber", "dateOfBirth", "dob"];
    const guard = <T extends object>(o: T): T =>
      new Proxy(o, {
        get(target, key, receiver) {
          if (typeof key === "string" && forbidden.includes(key)) throw new Error(`read ${key}`);
          return Reflect.get(target, key, receiver);
        },
      });
    const list = buildLinkList(
      input({
        ctUsers: [guard({ ...ct(), tfn: "123456782", dateOfBirth: "1990-01-01" })],
        ehEmployees: [guard({ ...eh({ id: 40213 }), taxFileNumber: "123456782", dateOfBirth: "1990-01-01" })],
      }),
    );
    expect(list.rows).toEqual([expect.objectContaining({ kind: "matched", suggestion: "40213" })]);
    expect(JSON.stringify(list)).not.toMatch(/123456782|1990-01-01/);
  });

  it("handles a headcount of thousands, one row per Connecteam user", () => {
    const n = 3000;
    const users = Array.from({ length: n }, (_, i) =>
      ct({ ctUserId: i + 1, firstName: `First${i}`, lastName: `Last${i}`, email: `p${i}@example.com`, payrollId: String(i + 1) }),
    );
    const ehs = Array.from({ length: n }, (_, i) =>
      eh({ id: 50000 + i, firstName: `First${i}`, surname: `Last${i}`, email: i % 2 ? `p${i}@example.com` : `other${i}@example.com` }),
    );
    const { rows, ignoredEhCount } = buildLinkList(input({ ctUsers: users, ehEmployees: ehs }));
    expect(rows).toHaveLength(n);
    expect(rows.filter((r) => r.kind === "matched")).toHaveLength(n / 2);
    expect(rows.filter((r) => r.kind === "choice")).toHaveLength(n / 2);
    expect(ignoredEhCount).toBe(0);
  });

  describe("on a live client", () => {
    it("shows as already synced when an EH employee carries this user's Payroll ID, copied from a field or not", () => {
      const { rows } = buildLinkList(
        input({
          ctUsers: [ct(), ct({ ctUserId: 101, firstName: "Mia", lastName: "Chen", email: "mia@example.com", payrollId: "EMP042" })],
          ehEmployees: [
            eh({ id: 40213, externalId: "100" }),
            eh({ id: 40377, firstName: "Mia", surname: "Chen", email: "mia.c@example.com", externalId: "EMP042" }),
          ],
        }),
      );
      expect(rows.map((r) => [r.ctUserId, r.kind, r.suggestion])).toEqual([
        [100, "alreadySynced", "40213"],
        [101, "alreadySynced", "40377"],
      ]);
    });

    it("can't link when the EH match carries another Connecteam user's Payroll ID", () => {
      const { rows } = buildLinkList(
        input({
          ctUsers: [ct(), ct({ ctUserId: 555, firstName: "Mia", lastName: "Chen", email: "mia@example.com", payrollId: "555" })],
          ehEmployees: [eh({ id: 40213, externalId: "555" })],
        }),
      );
      expect(rows.find((r) => r.ctUserId === 100)).toEqual(
        expect.objectContaining({ kind: "taken", suggestion: null, candidates: [{ ehEmployeeId: "40213", reasons: ["linkedElsewhere"], linkedTo: 555 }] }),
      );
    });

    it("skips anyone whose employee_map row has an EH id, but still sees their Payroll ID as taken", () => {
      const { rows } = buildLinkList(
        input({
          ctUsers: [ct(), ct({ ctUserId: 555, firstName: "Mia", lastName: "Chen", email: "mia@example.com", payrollId: "555" })],
          ehEmployees: [eh({ id: 40213, externalId: "555" })],
          employeeMap: [{ ctUserId: 555, ehEmployeeId: "40213", lastOutcome: "ok" }],
        }),
      );
      expect(rows.map((r) => [r.ctUserId, r.kind])).toEqual([[100, "taken"]]);
    });
  });
});
