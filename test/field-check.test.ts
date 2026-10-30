import { describe, it, expect } from "vitest";
import { checkFields, renderFieldCheck, summarise } from "../scripts/lib/field-check.js";
import { DEMO_CUSTOM_FIELDS } from "./fixtures/demo-custom-fields.js";

// Raw `GET /users/v1/custom-fields` rows for the demo account: the fixture's
// definitions plus the options and permissions the check reads.
const OPTIONS: Record<string, string[]> = {
  Gender: ["Male", "Female", "Other"],
  State: ["QLD", "NSW", "VIC", "ACT", "TAS", "SA", "WA", "NT", "INTERNATIONAL"],
  "Employee Status": ["FullTime", "Casual", "PartTime", "LabourHire"],
  "Claim tax-free threshold?": ["Yes", "No"],
  "Australian resident for tax purposes?": ["Yes", "No"],
  "Have a HELP/STSL study debt?": ["Yes", "No"],
};
const demoRaw = () =>
  DEMO_CUSTOM_FIELDS.map((f) => ({
    id: f.customFieldId,
    name: f.name,
    type: f.type,
    isEditableForUsers: f.name !== "EH Pay Rate Template",
    dropdownOptions: (OPTIONS[f.name] ?? []).map((value) => ({ value, isDeleted: false })),
  }));

const without = (name: string) => demoRaw().filter((f) => f.name !== name);
const replace = (name: string, over: object) => demoRaw().map((f) => (f.name === name ? { ...f, ...over } : f));
const row = (rows: ReturnType<typeof checkFields>, name: string) => rows.find((r) => r.name === name)!;

describe("checkFields", () => {
  it("passes the demo account: everything found, nothing blocking", () => {
    const rows = checkFields(demoRaw());
    expect(rows.filter((r) => r.result.status !== "found")).toEqual([]);
    expect(summarise(rows)).toEqual({ ok: 28, blocking: 0, warnings: 0, skipped: 0 });
  });

  it("a missing required field blocks; a missing recommended one only warns", () => {
    const rows = checkFields(without("TFN").filter((f) => f.name !== "Suburb"));
    expect(row(rows, "TFN")).toMatchObject({ level: "required", blocking: true, result: { status: "missing" } });
    expect(row(rows, "Suburb")).toMatchObject({ level: "recommended", blocking: false, result: { status: "missing" } });
    expect(summarise(rows)).toEqual({ ok: 26, blocking: 1, warnings: 1, skipped: 0 });
  });

  it("flags a wrong type, and blocks when the field is required", () => {
    const rows = checkFields(replace("Birthday", { type: "str" }));
    expect(row(rows, "Birthday")).toMatchObject({ blocking: true, result: { status: "wrongType", got: "str", want: "birthday" } });
  });

  it("accepts a date field where a birthday is expected (same DD/MM/YYYY value)", () => {
    expect(row(checkFields(replace("Birthday", { type: "date" })), "Birthday").result.status).toBe("found");
  });

  it("flags dropdown options EH won't recognise", () => {
    const rows = checkFields(
      replace("Employee Status", { dropdownOptions: ["Full time", "Casual"].map((value) => ({ value, isDeleted: false })) }),
    );
    expect(row(rows, "Employee Status")).toMatchObject({ blocking: false, result: { status: "options", unknown: ["Full time"], absent: [] } });
  });

  it("ignores deleted options", () => {
    const opts = [...OPTIONS.Gender!.map((value) => ({ value, isDeleted: false })), { value: "Prefer not to say", isDeleted: true }];
    expect(row(checkFields(replace("Gender", { dropdownOptions: opts })), "Gender").result.status).toBe("found");
  });

  it("a Yes/No question needs both answers", () => {
    const rows = checkFields(replace("Claim tax-free threshold?", { dropdownOptions: [{ value: "Yes", isDeleted: false }] }));
    expect(row(rows, "Claim tax-free threshold?").result).toEqual({ status: "options", unknown: [], absent: ["No"] });
  });

  it("compares Yes/No answers the way the sync reads them: any case", () => {
    const opts = ["yes", "NO"].map((value) => ({ value, isDeleted: false }));
    expect(row(checkFields(replace("Claim tax-free threshold?", { dropdownOptions: opts })), "Claim tax-free threshold?").result.status).toBe(
      "found",
    );
  });

  it("names Connecteam's types the way its UI does", () => {
    const out = renderFieldCheck(checkFields(replace("Birthday", { type: "str" })), { color: false });
    expect(out.replace(/\n {8}(?![\[WF])/g, " ")).toContain('"Birthday" is a text field; the sync needs a birthday field');
  });

  it("checks the new field, not an '(OLD)' one of the wrong type listed first (first client's setup)", () => {
    const old = { id: 1, name: "Emergency Contact Number (OLD)", type: "phone", isEditableForUsers: true, dropdownOptions: [] };
    const rows = checkFields([old, ...demoRaw()]);
    expect(row(rows, "Emergency Contact Number")).toMatchObject({ field: { id: 42708537 }, result: { status: "found" } });
  });

  it("asks when two current fields match, and blocks if the field is required", () => {
    const second = { id: 7, name: "Tax File Number", type: "str", isEditableForUsers: true, dropdownOptions: [] };
    const rows = checkFields([...demoRaw(), second]);
    expect(row(rows, "TFN")).toMatchObject({
      blocking: true,
      result: { status: "ambiguous", candidates: [{ id: 42923222, name: "TFN" }, { id: 7, name: "Tax File Number" }] },
    });
    expect(row(rows, "TFN").field).toBeUndefined();
  });

  it("reads a picked field the name pattern misses (first client's HELP question)", () => {
    const help = "Higher Education Loan Program (HELP), Student Startup Loan (SSL), Trade Support Loan?";
    const raw = replace("Have a HELP/STSL study debt?", { name: help });
    expect(row(checkFields(raw), "Have a HELP/STSL study debt?").result.status).toBe("missing");

    const rows = checkFields(raw, { "Have a HELP/STSL study debt?": { id: 42923316 } });
    expect(row(rows, "Have a HELP/STSL study debt?")).toMatchObject({ field: { id: 42923316, name: help }, result: { status: "found" } });
  });

  it("reports a picked field that was since deleted, and blocks if required", () => {
    const rows = checkFields(demoRaw(), { TFN: { id: 99 } });
    expect(row(rows, "TFN")).toMatchObject({ blocking: true, result: { status: "stalePick", id: 99 } });
  });

  it("a skipped recommended field is neither missing nor a warning", () => {
    const rows = checkFields(without("Suburb"), { Suburb: { skip: true } });
    expect(row(rows, "Suburb")).toMatchObject({ blocking: false, result: { status: "skipped" } });
    expect(summarise(rows)).toEqual({ ok: 27, blocking: 0, warnings: 0, skipped: 1 });
    expect(renderFieldCheck(rows, { color: false }).trim().split("\n").at(-1)).toBe(
      "27 ok · 0 required missing or wrong · 0 warnings · 1 skipped",
    );
  });

  it("warns when employees can edit the award field", () => {
    const rows = checkFields(replace("EH Pay Rate Template", { isEditableForUsers: true }));
    expect(row(rows, "EH Pay Rate Template")).toMatchObject({ level: "admin", blocking: false, result: { status: "userEditable" } });
  });

  it("treats a missing award field as a warning, not a block", () => {
    expect(row(checkFields(without("EH Pay Rate Template")), "EH Pay Rate Template")).toMatchObject({
      blocking: false,
      result: { status: "missing" },
    });
  });
});

describe("renderFieldCheck", () => {
  const rows = checkFields(without("TFN"));

  it("groups by area, explains every non-green result, and ends with a summary", () => {
    const out = renderFieldCheck(rows, { color: false });
    expect(out).toContain("Identity");
    expect(out).toContain("[x] TFN");
    const unwrapped = out.replace(/\n {8}(?![\[WF])/g, " ");
    expect(unwrapped).toMatch(/Why: .*Correction message/);
    expect(unwrapped).toMatch(/Fix: .*npm run create-fields/);
    expect(out.trim().split("\n").at(-1)).toBe("27 ok · 1 required missing or wrong · 0 warnings");
  });

  it("fits a 100-column terminal", () => {
    const wide = renderFieldCheck(checkFields(replace("Birthday", { type: "str" })), { color: false });
    for (const line of wide.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("uses colour only when asked", () => {
    expect(renderFieldCheck(rows, { color: false })).not.toContain("\u001b[");
    expect(renderFieldCheck(rows, { color: true })).toContain("\u001b[");
  });
});
