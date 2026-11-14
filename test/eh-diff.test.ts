/**
 * The EH before/after diff (#157): read-only, field names only, snapshot
 * git-ignored. The API tests run the real EH client over a fake fetch that
 * records every method it's asked for.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { EhPayrollClient } from "../src/eh/client.js";
import {
  DEFAULT_SNAPSHOT_FILE,
  beyondPayrollId,
  diffRecords,
  diffSnapshot,
  renderDiff,
  takeSnapshot,
  type EmployeeDiff,
} from "../scripts/lib/eh-diff.js";

const root = fileURLToPath(new URL("..", import.meta.url));

const BEFORE = {
  id: 9001,
  externalId: null,
  firstName: "Zelda",
  surname: "Quixote",
  emailAddress: "zelda.quixote@example.com",
  taxFileNumber: "123456782",
  bankAccounts: [{ bsb: "062000", accountNumber: "99887766" }],
  residentialAddress: { postCode: "2000", suburb: "Sydney" },
  middleName: "",
};

/** A fake EH: serves `records` by id, and records each request's method. */
function fakeEh(records: Record<number, unknown>, failWith?: { status: number; body: unknown }) {
  const methods: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    methods.push((init?.method ?? "GET").toUpperCase());
    if (failWith) return new Response(JSON.stringify(failWith.body), { status: failWith.status, headers: { "content-type": "application/json" } });
    const id = Number(String(url).split("/").pop());
    const body = records[id];
    return body === undefined
      ? new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const eh = new EhPayrollClient({ apiKey: "k", businessId: "555", baseUrl: "https://eh.test/api/v2", fetchImpl });
  return { methods, get: (id: number) => eh.getEmployee(String(id)) };
}

describe("diffRecords", () => {
  it("names set, changed and cleared fields, sorted, with dot paths into objects", () => {
    const after = {
      ...BEFORE,
      externalId: "E0042",
      emailAddress: "other@example.com",
      taxFileNumber: null,
      residentialAddress: { postCode: "2000", suburb: "Newtown" },
    };
    expect(diffRecords(BEFORE, after)).toEqual([
      { field: "emailAddress", change: "changed" },
      { field: "externalId", change: "set" },
      { field: "residentialAddress.suburb", change: "changed" },
      { field: "taxFileNumber", change: "cleared" },
    ]);
  });

  it("compares arrays whole", () => {
    const after = { ...BEFORE, bankAccounts: [{ bsb: "062000", accountNumber: "11112222" }] };
    expect(diffRecords(BEFORE, after)).toEqual([{ field: "bankAccounts", change: "changed" }]);
  });

  it("treats null, missing, empty text and an empty list as the same", () => {
    expect(diffRecords({ a: null, b: "", c: [] }, { a: "", c: null, d: undefined })).toEqual([]);
  });

  it("finds nothing in an identical record", () => {
    expect(diffRecords(BEFORE, structuredClone(BEFORE))).toEqual([]);
  });
});

describe("snapshot and diff against EH", () => {
  it("only ever sends GET", async () => {
    const eh = fakeEh({ 9001: BEFORE, 9002: { ...BEFORE, id: 9002 } });
    const snapshot = await takeSnapshot([9001, 9002], eh.get, "555", new Date("2026-11-14T00:00:00Z"));
    await diffSnapshot(snapshot, eh.get);
    expect(eh.methods).toEqual(["GET", "GET", "GET", "GET"]);
  });

  it("keeps the full record in the snapshot, keyed by EH id", async () => {
    const snapshot = await takeSnapshot([9001], fakeEh({ 9001: BEFORE }).get, "555", new Date("2026-11-14T00:00:00Z"));
    expect(snapshot).toEqual({ takenAt: "2026-11-14T00:00:00.000Z", businessId: "555", employees: { "9001": BEFORE } });
  });

  it("refuses to snapshot an EH id that isn't there", async () => {
    await expect(takeSnapshot([404], fakeEh({}).get, "555", new Date())).rejects.toThrow("no employee 404");
  });

  it("reports an employee gone since the snapshot, and counts it as beyond the Payroll ID", async () => {
    const snapshot = { takenAt: "t", businessId: "555", employees: { "9001": BEFORE } };
    const diffs = await diffSnapshot(snapshot, fakeEh({}).get);
    expect(diffs).toEqual([{ id: 9001, gone: true }]);
    expect(beyondPayrollId(diffs[0]!)).toBe(true);
  });

  it("names the HTTP status of a failed read, not the body it sent back", async () => {
    const eh = fakeEh({}, { status: 500, body: { message: `Error for ${BEFORE.emailAddress}` } });
    const err = await takeSnapshot([9001], eh.get, "555", new Date()).catch((e: Error) => e);
    expect(String(err)).toContain("Employment Hero employee 9001 -> HTTP 500");
    expect(String(err)).not.toContain(BEFORE.emailAddress);
  });
});

describe("renderDiff", () => {
  const diffs: EmployeeDiff[] = [
    { id: 9001, gone: false, changes: [{ field: "externalId", change: "set" }] },
    { id: 9002, gone: false, changes: [] },
  ];

  it("passes when only the Payroll ID changed", () => {
    const out = renderDiff(diffs, { takenAt: "2026-11-14T00:00:00.000Z" });
    expect(out).toContain("[ok] EH employee 9001: externalId set");
    expect(out).toContain("[ok] EH employee 9002: no changes");
    expect(out).toContain("Nothing beyond the Payroll ID (externalId) changed for any of the 2 employees.");
    expect(diffs.some(beyondPayrollId)).toBe(false);
  });

  it("flags any other change, and points at the Emergency stop", () => {
    const out = renderDiff(
      [...diffs, { id: 9003, gone: false, changes: [{ field: "bankAccounts", change: "changed" }] }, { id: 9004, gone: true }],
      { takenAt: "t" },
    );
    expect(out).toContain("[!] EH employee 9003: bankAccounts changed");
    expect(out).toContain("[!] EH employee 9004: no longer in Employment Hero");
    expect(out).toContain("2 of 4 employees changed beyond the Payroll ID");
    expect(out).toContain("Emergency stop");
  });

  it("never prints a field value, before or after", async () => {
    const after = {
      ...BEFORE,
      externalId: "E0042",
      emailAddress: "changed.address@example.com",
      taxFileNumber: "876543210",
      bankAccounts: [{ bsb: "063000", accountNumber: "55443322" }],
      residentialAddress: { postCode: "3000", suburb: "Melbourne" },
    };
    const snapshot = { takenAt: "t", businessId: "555", employees: { "9001": BEFORE } };
    const out = renderDiff(await diffSnapshot(snapshot, fakeEh({ 9001: after }).get), snapshot);
    const values = [BEFORE, after].flatMap((r) => [
      r.firstName, r.surname, r.emailAddress, r.taxFileNumber, r.externalId,
      ...r.bankAccounts.flatMap((b) => [b.bsb, b.accountNumber]),
      r.residentialAddress.postCode, r.residentialAddress.suburb,
    ]);
    for (const v of values.filter((v): v is string => !!v)) expect(out).not.toContain(v);
  });
});

describe("eh-diff script", () => {
  it("has no EH write call anywhere", () => {
    for (const file of ["scripts/eh-diff.ts", "scripts/lib/eh-diff.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      expect(src, file).not.toMatch(/setExternalId|upsertByExternalId|deleteEmployee|\b(POST|PUT|PATCH|DELETE)\b|fetch\(/);
    }
  });

  it("keeps the default snapshot file out of git", () => {
    const r = spawnSync("git", ["check-ignore", "-q", DEFAULT_SNAPSHOT_FILE], { cwd: root });
    expect(r.status).toBe(0);
  });

  const run = (args: string[]) =>
    spawnSync(join(root, "node_modules/.bin/tsx"), ["scripts/eh-diff.ts", ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EH_API_KEY: "unused", EH_BUSINESS_ID: "555" },
      timeout: 30_000,
    });

  it("won't replace an existing snapshot without --force, before reading EH", () => {
    const file = join(mkdtempSync(join(tmpdir(), "eh-diff-")), "snap.json");
    writeFileSync(file, "{}");
    const r = run(["snapshot", "9001", "--file", file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already holds a snapshot");
    expect(readFileSync(file, "utf8")).toBe("{}");
  });

  it("won't diff against a snapshot from another EH business", () => {
    const file = join(mkdtempSync(join(tmpdir(), "eh-diff-")), "snap.json");
    writeFileSync(file, JSON.stringify({ takenAt: "t", businessId: "999", employees: {} }));
    const r = run(["diff", "--file", file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("from EH business 999");
  });

  it("says how to use it when the command is missing", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: npm run eh-diff -- snapshot");
  });
});
