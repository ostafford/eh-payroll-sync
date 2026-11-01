import { describe, it, expect } from "vitest";
import {
  DEAD_LETTER_REASON,
  deriveRosterEntry,
  leftOutLabel,
  summarizeRoster,
  parseRosterRows,
  type RosterRow,
} from "../src/status/roster.js";

function row(over: Partial<RosterRow>): RosterRow {
  return {
    ctUserId: 100,
    ehEmployeeId: "555",
    failureCycleCount: 0,
    lastOutcome: "ok",
    latestOutcome: "ok",
    latestDetail: "synced",
    ...over,
  };
}

describe("deriveRosterEntry", () => {
  it("is ready when the last outcome was a clean sync", () => {
    expect(deriveRosterEntry(row({}))).toEqual({
      ctUserId: 100,
      ehEmployeeId: "555",
      state: "ready",
      reasons: [],
    });
  });

  it("is ready when the daily recheck (#43) resolved a follow-up", () => {
    const r = row({ lastOutcome: "resolved", latestOutcome: "resolved", latestDetail: 'resolved: status now "Complete"' });
    expect(deriveRosterEntry(r).state).toBe("ready");
  });

  it("is waiting_on_employee for an open correction cycle, with field names and cycle count", () => {
    const r = row({
      lastOutcome: "correction",
      latestOutcome: "correction",
      latestDetail: "correction: taxFileNumber, bsb",
      failureCycleCount: 2,
    });
    expect(deriveRosterEntry(r)).toEqual({
      ctUserId: 100,
      ehEmployeeId: "555",
      state: "waiting_on_employee",
      reasons: ["taxFileNumber", "bsb"],
      cycleCount: 2,
    });
  });

  it("is waiting_on_admin for a manual follow-up, with the reason phrases", () => {
    const r = row({
      lastOutcome: "follow_up",
      latestOutcome: "follow_up",
      latestDetail: "follow_up: Pay Run Defaults are incomplete | SMSF super needs manual setup",
    });
    expect(deriveRosterEntry(r)).toEqual({
      ctUserId: 100,
      ehEmployeeId: "555",
      state: "waiting_on_admin",
      reasons: ["Pay Run Defaults are incomplete", "SMSF super needs manual setup"],
    });
  });

  it("falls back to a generic reason when the detail carries no prefix", () => {
    const r = row({ lastOutcome: "follow_up", latestOutcome: "follow_up", latestDetail: null });
    expect(deriveRosterEntry(r).reasons).toEqual(["Employment Hero flagged this record - see the audit log."]);
  });

  it("is broken when the latest sync_log row dead-lettered, even if employee_map is stale", () => {
    // employee_map still says "ok" from an older successful sync - the LATEST
    // sync_log row (dead_letter) wins, per handleDeadLetter never touching
    // employee_map (src/sync/consumer.ts).
    const r = row({ lastOutcome: "ok", latestOutcome: "dead_letter", latestDetail: "retries exhausted: employment hero unavailable: 503" });
    expect(deriveRosterEntry(r)).toEqual({
      ctUserId: 100,
      ehEmployeeId: "555",
      state: "broken",
      reasons: [DEAD_LETTER_REASON],
    });
  });

  it("gives a dead-letter a plain reason: not the employee's data, see the System alert, how to retry", () => {
    const [reason] = deriveRosterEntry(row({ latestOutcome: "dead_letter", latestDetail: "retries exhausted" })).reasons;
    expect(reason).toMatch(/not the employee's data/);
    expect(reason).toMatch(/System alert/);
    expect(reason).toMatch(/edit their profile in Connecteam to retry/);
    expect(reason).not.toMatch(/retries exhausted|retry limit/);
  });

  it("is broken when the latest sync_log row is an EH identity collision", () => {
    const r = row({
      ehEmployeeId: null,
      failureCycleCount: null,
      lastOutcome: null,
      latestOutcome: "collision",
      latestDetail: "collision: EH employee 555 already linked to Connecteam user 99999",
    });
    expect(deriveRosterEntry(r)).toEqual({
      ctUserId: 100,
      ehEmployeeId: null,
      state: "broken",
      reasons: ["collision: EH employee 555 already linked to Connecteam user 99999"],
    });
  });

  it("is broken for a person with no employee_map row at all (dead-lettered on their first-ever attempt)", () => {
    const r = row({
      ehEmployeeId: null,
      failureCycleCount: null,
      lastOutcome: null,
      latestOutcome: "dead_letter",
      latestDetail: "retries exhausted: connecteam unavailable: 503",
    });
    expect(deriveRosterEntry(r)).toEqual({
      ctUserId: 100,
      ehEmployeeId: null,
      state: "broken",
      reasons: [DEAD_LETTER_REASON],
    });
  });
});

describe("deriveRosterEntry - left out by choice", () => {
  it("is left_out, naming the field that left them out, never broken or waiting", () => {
    const entry = deriveRosterEntry(
      row({ lastOutcome: "excluded", latestOutcome: "excluded", latestDetail: "excluded: customField 42920839 (Employee Status)" }),
    );
    expect(entry).toEqual({ ctUserId: 100, ehEmployeeId: "555", state: "left_out", reasons: ["customField 42920839 (Employee Status)"] });
  });

  it("labels it with the field map's values when known", () => {
    const exclude = [{ customFieldId: 42920839, values: ["PBV", "Volunteer"] }];
    expect(leftOutLabel("customField 42920839 (Employee Status)", exclude)).toBe("Employee Status: PBV, Volunteer");
    expect(leftOutLabel("customField 42920839 (Employee Status)")).toBe("Employee Status");
  });
});

describe("summarizeRoster", () => {
  it("tallies each state", () => {
    const entries = [
      deriveRosterEntry(row({ ctUserId: 1 })),
      deriveRosterEntry(row({ ctUserId: 2, lastOutcome: "correction", latestOutcome: "correction", latestDetail: "correction: bsb" })),
      deriveRosterEntry(row({ ctUserId: 3, lastOutcome: "follow_up", latestOutcome: "follow_up", latestDetail: "follow_up: reason" })),
      deriveRosterEntry(row({ ctUserId: 4, latestOutcome: "dead_letter", latestDetail: "retries exhausted" })),
      deriveRosterEntry(row({ ctUserId: 5, lastOutcome: "excluded", latestOutcome: "excluded", latestDetail: "excluded: customField 1 (X)" })),
    ];
    expect(summarizeRoster(entries)).toEqual({ ready: 1, waitingEmployee: 1, waitingAdmin: 1, broken: 1, leftOut: 1 });
  });

  it("is all zeroes for an empty roster", () => {
    expect(summarizeRoster([])).toEqual({ ready: 0, waitingEmployee: 0, waitingAdmin: 0, broken: 0, leftOut: 0 });
  });
});

describe("parseRosterRows", () => {
  it("normalises a raw D1 result row into a RosterRow", () => {
    const rows = parseRosterRows([
      { ctUserId: "100", ehEmployeeId: "555", failureCycleCount: "2", lastOutcome: "correction", latestOutcome: "correction", latestDetail: "correction: bsb" },
    ]);
    expect(rows).toEqual([
      { ctUserId: 100, ehEmployeeId: "555", failureCycleCount: 2, lastOutcome: "correction", latestOutcome: "correction", latestDetail: "correction: bsb" },
    ]);
  });

  it("defaults missing/null fields", () => {
    const rows = parseRosterRows([{ ctUserId: 4 }]);
    expect(rows).toEqual([
      { ctUserId: 4, ehEmployeeId: null, failureCycleCount: null, lastOutcome: null, latestOutcome: null, latestDetail: null },
    ]);
  });
});
