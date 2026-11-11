import { describe, it, expect, vi } from "vitest";
import { DATABASE_ID_PLACEHOLDER } from "../scripts/lib/deploy-config.js";
import { readSyncRecords, type RecordsIo } from "../scripts/lib/preflight-records.js";

const io = (over: Partial<RecordsIo> = {}): RecordsIo => ({
  check: vi.fn(),
  query: vi.fn((sql: string) =>
    sql.includes("employee_map")
      ? [{ ctUserId: 1, ehEmployeeId: 40, lastOutcome: "ok", linkedAt: null, externalId: null }]
      : [{ ctUserId: 2, ehEmployeeId: null }],
  ),
  ...over,
});

describe("readSyncRecords", () => {
  it("reads nothing before the first deploy: no database named, or still the placeholder", () => {
    for (const devVars of [{}, { D1_DATABASE_ID: " " }, { D1_DATABASE_ID: DATABASE_ID_PLACEHOLDER }]) {
      const i = io();
      expect(readSyncRecords(devVars, i)).toBeNull();
      expect(i.check).not.toHaveBeenCalled();
      expect(i.query).not.toHaveBeenCalled();
    }
  });

  it("once a database is named, a failed settings check throws rather than leaving the Link list out", () => {
    const i = io({ check: () => { throw new Error("The deploy settings aren't ready"); } });
    expect(() => readSyncRecords({ D1_DATABASE_ID: "db-1" }, i)).toThrow("The deploy settings aren't ready");
    expect(i.query).not.toHaveBeenCalled();
  });

  it("reads employee_map and the Link list, with EH ids as strings", () => {
    expect(readSyncRecords({ D1_DATABASE_ID: "db-1" }, io())).toEqual({
      employeeMap: [{ ctUserId: 1, ehEmployeeId: "40", lastOutcome: "ok", linkedAt: null, externalId: null }],
      pendingLinks: [{ ctUserId: 2, ehEmployeeId: null }],
    });
  });
});
