import { describe, it, expect } from "vitest";
import type { ConnecteamUser } from "../src/connecteam/types.js";
import { linkListInput, type LinkStageData } from "../scripts/lib/link-input.js";

const ctUser = (over: Partial<ConnecteamUser> = {}): ConnecteamUser => ({
  userId: 100,
  firstName: "Jack",
  lastName: "Mitchell",
  email: "jack@example.com",
  customFields: [],
  ...over,
});
const data = (over: Partial<LinkStageData> = {}): LinkStageData => ({
  ctUsers: [],
  ehEmployees: [],
  assignments: [],
  employeeMap: [],
  pendingLinks: [],
  heldDetails: [],
  payrollIdFrom: "userId",
  ...over,
});

describe("linkListInput", () => {
  it("turns Connecteam users and EH's employee list into the link list's shapes, EH ids as strings", () => {
    const input = linkListInput(
      data({
        ctUsers: [ctUser(), { userId: 101, lastName: "Chen", email: "", customFields: [] }],
        ehEmployees: [
          { id: 40213, firstName: "Jack", surname: "Mitchell", emailAddress: "jack@example.com", externalId: "", status: "Active" },
          { id: 40377, firstName: "Mia", surname: "Chen", emailAddress: null, externalId: " 7001 ", status: "Terminated" },
        ],
      }),
    );
    expect(input.ctUsers).toEqual([
      { ctUserId: 100, firstName: "Jack", lastName: "Mitchell", email: "jack@example.com", payrollId: "100" },
      { ctUserId: 101, firstName: "", lastName: "Chen", email: null, payrollId: "101" },
    ]);
    expect(input.ehEmployees).toEqual([
      { id: "40213", firstName: "Jack", surname: "Mitchell", email: "jack@example.com", externalId: null, status: "Active" },
      { id: "40377", firstName: "Mia", surname: "Chen", email: null, externalId: "7001", status: "Terminated" },
    ]);
  });

  it("leaves out archived Connecteam users", () => {
    const input = linkListInput(data({ ctUsers: [ctUser(), ctUser({ userId: 101, isArchived: true })] }));
    expect(input.ctUsers.map((u) => u.ctUserId)).toEqual([100]);
  });

  it("takes the Payroll ID the sync would use: the copied field, the userId when it's blank, the stored one once synced", () => {
    const payrollField = (value: unknown) => [{ customFieldId: 77, value, type: "str", name: "Payroll ID" }];
    const input = linkListInput(
      data({
        payrollIdFrom: { customFieldId: 77 },
        ctUsers: [
          ctUser({ userId: 100, customFields: payrollField(" P-100 ") }),
          ctUser({ userId: 101, customFields: payrollField("") }),
          ctUser({ userId: 102, customFields: payrollField("P-102-edited") }),
        ],
        employeeMap: [{ ctUserId: 102, ehEmployeeId: "40500", lastOutcome: "created", externalId: "P-102" }],
      }),
    );
    expect(input.ctUsers.map((u) => u.payrollId)).toEqual(["P-100", "101", "P-102"]);
  });

  it("reads each Held employee's candidate EH ids from their existing_match detail", () => {
    const input = linkListInput(
      data({
        heldDetails: [
          { ctUserId: 100, detail: "existing_match: EH 40213 (email, nameDob; tfn differs) | EH 40377 terminated (tfn)" },
          { ctUserId: 101, detail: null },
        ],
      }),
    );
    expect(input.heldCandidates).toEqual(new Map([[100, ["40213", "40377"]]]));
  });
});
