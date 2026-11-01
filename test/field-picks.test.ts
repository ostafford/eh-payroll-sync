import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { loadFieldPicks } from "../scripts/lib/field-picks.js";

const file = (picks: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "field-picks-")), "field-picks.json");
  writeFileSync(path, JSON.stringify(picks));
  return path;
};

describe("loadFieldPicks", () => {
  it("rejects some super fields skipped but not all: the sync needs all four or none (#117)", () => {
    const path = file({ "Super Fund USI": { skip: true }, "Super Fund ABN": { id: 5 } });
    expect(() => loadFieldPicks(path)).toThrow(/all four super fields or none.*Super Fund ABN, Super Fund Name, Member Number/);
  });

  it("accepts all four super fields skipped", () => {
    const skip = { skip: true };
    const picks = { "Super Fund USI": skip, "Super Fund ABN": skip, "Super Fund Name": skip, "Member Number": skip };
    expect(loadFieldPicks(file(picks))).toEqual(picks);
  });

  it("accepts a profile pick only for the legal-name fields", () => {
    expect(loadFieldPicks(file({ "Legal First Name": { profile: true } }))).toEqual({ "Legal First Name": { profile: true } });
    expect(() => loadFieldPicks(file({ Title: { profile: true } }))).toThrow(/"Title" can't be read from the Connecteam profile/);
  });

  it("accepts a list of answers to leave out, only where the field allows it", () => {
    const ok = { "Employee Status": { id: 1, options: { PBV: null }, exclude: ["PBV"] } };
    expect(loadFieldPicks(file(ok))).toEqual(ok);
    expect(() => loadFieldPicks(file({ Gender: { id: 1, exclude: ["Other"] } }))).toThrow(/"Gender" can't leave employees out/);
    expect(() => loadFieldPicks(file({ "Employee Status": { id: 1, exclude: "PBV" } }))).toThrow(/exclude must be a list/);
  });
});
