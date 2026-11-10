import { describe, it, expect } from "vitest";
import { linkChanges, pendingLinkSql } from "../scripts/lib/link-changes.js";

describe("linkChanges", () => {
  it("adds a link the admin chose for someone not yet on the Link list", () => {
    expect(linkChanges([], [{ ctUserId: 100, onList: true, ehEmployeeId: "40213" }])).toEqual({
      upsert: [{ ctUserId: 100, ehEmployeeId: "40213" }],
      remove: [],
    });
  });

  it("writes nothing on a re-run where the admin changed nothing, a new hire included", () => {
    const existing = [
      { ctUserId: 100, ehEmployeeId: "40213" },
      { ctUserId: 101, ehEmployeeId: null },
    ];
    expect(
      linkChanges(existing, [
        { ctUserId: 100, onList: true, ehEmployeeId: "40213" },
        { ctUserId: 101, onList: true, ehEmployeeId: null },
        { ctUserId: 102, onList: false },
      ]),
    ).toEqual({ upsert: [], remove: [] });
  });

  it("removes a row the admin took off the Link list, and leaves one for someone not on the screen", () => {
    const existing = [
      { ctUserId: 100, ehEmployeeId: "40213" },
      { ctUserId: 101, ehEmployeeId: null },
      { ctUserId: 200, ehEmployeeId: "50001" },
    ];
    expect(
      linkChanges(existing, [
        { ctUserId: 100, onList: false },
        { ctUserId: 101, onList: false },
      ]),
    ).toEqual({ upsert: [], remove: [100, 101] });
  });
});

describe("pendingLinkSql", () => {
  it("upserts each link with when it was confirmed, writes a new hire as NULL, and deletes removed rows", () => {
    const sql = pendingLinkSql(
      { upsert: [{ ctUserId: 100, ehEmployeeId: "40213" }, { ctUserId: 101, ehEmployeeId: null }], remove: [102, 103] },
      1762790400000,
    );
    expect(sql).toBe(
      "INSERT INTO pending_link (ct_user_id, eh_employee_id, confirmed_at) VALUES " +
        "(100, '40213', 1762790400000), (101, NULL, 1762790400000) " +
        "ON CONFLICT(ct_user_id) DO UPDATE SET eh_employee_id = excluded.eh_employee_id, confirmed_at = excluded.confirmed_at;\n" +
        "DELETE FROM pending_link WHERE ct_user_id IN (102, 103);",
    );
  });

  it("is null when there is nothing to write, so the stage runs no command", () => {
    expect(pendingLinkSql({ upsert: [], remove: [] }, 1762790400000)).toBeNull();
  });
});
