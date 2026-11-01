import { describe, it, expect } from "vitest";
import { applyChoice, pickerChoices, reviewFields } from "../scripts/lib/field-picker.js";
import type { FieldPicks } from "../scripts/lib/field-resolve.js";
import { FIELD_SPEC } from "../scripts/lib/field-spec.js";
import { DEMO_CUSTOM_FIELDS } from "./fixtures/demo-custom-fields.js";

const spec = (name: string) => FIELD_SPEC.find((s) => s.name === name)!;

describe("pickerChoices", () => {
  const fields = [
    { id: 1, name: "Notes", type: "str" },
    { id: 2, name: "Tax File Number (OLD)", type: "number" },
    { id: 3, name: "Tax File Number", type: "str" },
    { id: 4, name: "Start", type: "date" },
  ];

  it("lists only fields of a usable type, name matches first, and no Skip for a required field", () => {
    expect(pickerChoices(spec("TFN"), fields)).toEqual([
      { kind: "use", field: fields[2] },
      { kind: "use", field: fields[0] },
      { kind: "create" },
    ]);
  });

  it("offers Skip for a recommended field, and a date field where a birthday is expected", () => {
    expect(pickerChoices(spec("Birthday"), fields).map((c) => c.kind)).toEqual(["use", "create"]);
    expect(pickerChoices(spec("Suburb"), fields).at(-1)).toEqual({ kind: "skip" });
  });
});

describe("pickerChoices - number-type fields (#116)", () => {
  const fields = [
    { id: 1, name: "Old postcode", type: "number" },
    { id: 2, name: "Notes", type: "str" },
  ];
  const offered = (name: string) => pickerChoices(spec(name), fields).flatMap((c) => (c.kind === "use" ? [c.field.id] : []));

  it("offers a number field for Postcode and BSB, but not for TFN or Account Number", () => {
    expect(offered("Postcode")).toContain(1);
    expect(offered("BSB")).toContain(1);
    expect(offered("TFN")).not.toContain(1);
    expect(offered("Account Number")).not.toContain(1);
  });
});

describe("applyChoice", () => {
  const picks = { TFN: { id: 9 } };

  it("saves a used field by ID, and a skip, leaving other picks alone", () => {
    expect(applyChoice(picks, spec("Suburb"), { kind: "use", field: { id: 5, name: "Locality", type: "str" } })).toEqual({
      TFN: { id: 9 },
      Suburb: { id: 5 },
    });
    expect(applyChoice(picks, spec("Suburb"), { kind: "skip" })).toEqual({ TFN: { id: 9 }, Suburb: { skip: true } });
  });

  it("saves 'create' for create-fields, even when a wrong-type field matches the name", () => {
    expect(applyChoice(picks, spec("TFN"), { kind: "create" })).toEqual({ TFN: { create: true } });
  });
});

describe("reviewFields: the combined field check (scripted answers)", () => {
  // The demo account (with its dropdown options) plus an hours field it lacks,
  // so a clean run has nothing to fix.
  const DEMO_OPTIONS: Record<string, string[]> = {
    Gender: ["Male", "Female", "Other"],
    State: ["QLD", "NSW", "VIC", "ACT", "TAS", "SA", "WA", "NT", "INTERNATIONAL"],
    "Employee Status": ["FullTime", "Casual", "PartTime", "LabourHire"],
    "Claim tax-free threshold?": ["Yes", "No"],
    "Australian resident for tax purposes?": ["Yes", "No"],
    "Have a HELP/STSL study debt?": ["Yes", "No"],
  };
  const demo = (): any[] => [
    ...DEMO_CUSTOM_FIELDS.map((f) => ({
      id: f.customFieldId,
      name: f.name,
      type: f.type,
      isEditableForUsers: f.name !== "EH Pay Rate Template",
      dropdownOptions: (DEMO_OPTIONS[f.name] ?? []).map((value) => ({ value, isDeleted: false })),
    })),
    { id: 99001, name: "Standard hours per week", type: "number" },
  ];
  const ALL_GOOD = "Everything's in place. Press Enter to finish, or type a number to change a row. ";
  const fixPrompt = (n: number) => `Fix the ${n} problem${n === 1 ? "" : "s"} now? [Y / number to change a row / done] `;
  /** A row's number in the table (FIELD_SPEC order). */
  const rowOf = (name: string) => String(FIELD_SPEC.findIndex((s) => s.name === name) + 1);
  /** Picks a choice by what it says, reading the screen as a person would. */
  const choice = (label: string) => (screen: string) => {
    const hits = [...screen.matchAll(/^\s*(\d+)\) (.*)$/gm)].filter((m) => m[2]!.startsWith(label));
    return hits.at(-1)![1]!;
  };
  const run = async (
    raw: any[],
    picks: FieldPicks,
    answers: Array<string | ((screen: string) => string)>,
    { color = false }: { color?: boolean } = {},
  ) => {
    const asked: string[] = [];
    const out: string[] = [];
    const result = await reviewFields(raw, picks, {
      ask: async (prompt) => {
        asked.push(prompt);
        const a = answers.shift();
        if (a === undefined) throw new Error(`no answer left for: ${prompt}`);
        // Read the screen as a person sees it: without colour codes.
        return typeof a === "string" ? a : a(out.join("\n").replace(/\u001b\[\d+m/g, ""));
      },
      print: (...lines) => out.push(...lines),
      color,
    });
    return { result, asked, out: out.join("\n") };
  };
  /** The last table drawn: its numbered rows. */
  const lastTable = (out: string) => {
    const from = out.lastIndexOf("Employment Hero needs");
    return out.slice(from).split("\n").filter((l) => /^\s+\d+\) /.test(l)).slice(0, FIELD_SPEC.length);
  };
  const tableRow = (out: string, name: string) => lastTable(out).find((l) => new RegExp(`\\) \\S+ ${name.replace(/[?()]/g, "\\$&")}\\s`).test(l))!;

  it("shows the table, and on a clean account one Enter saves every match by ID", async () => {
    const { result, asked, out } = await run(demo(), {}, [""]);
    expect(asked).toEqual([ALL_GOOD]);
    expect(out).toMatch(/Employment Hero needs\s+Your Connecteam field\s+Status/);
    expect(tableRow(out, "Legal First Name")).toMatch(/^\s+1\) \[ok\] Legal First Name\s+"Legal First Name"\s+matched by name$/);
    expect(Object.keys(result)).toHaveLength(FIELD_SPEC.length);
    expect(result.TFN).toEqual({ id: 42923222 });
  });

  it("a re-run shows them confirmed and needs only Enter", async () => {
    const first = (await run(demo(), {}, [""])).result;
    const { result, asked, out } = await run(demo(), first, [""]);
    expect(asked).toEqual([ALL_GOOD]);
    expect(tableRow(out, "TFN")).toMatch(/"TFN"\s+confirmed$/);
    expect(result).toEqual(first);
  });

  it("Y fixes each problem in turn, then redraws: an ambiguous field", async () => {
    const raw = [...demo(), { id: 7, name: "Tax File Number", type: "str" }];
    const { result, asked, out } = await run(raw, {}, ["y", choice('Use "Tax File Number"'), ""]);
    expect(asked[0]).toBe(fixPrompt(1));
    expect(asked[1]).toMatch(/^Pick 1-\d+ for TFN: $/);
    expect(asked.at(-1)).toBe(ALL_GOOD);
    expect(out).toContain("more than one of your fields could be it");
    expect(tableRow(out, "TFN")).toMatch(/"Tax File Number"\s+changed$/);
    expect(result.TFN).toEqual({ id: 7 });
  });

  it("a pick whose field was deleted is a problem to fix", async () => {
    const first = (await run(demo(), {}, [""])).result;
    const raw = [...demo().filter((f) => f.name !== "Suburb"), { id: 8, name: "Locality", type: "str" }];
    const { result, asked, out } = await run(raw, first, ["y", choice('Use "Locality"'), ""]);
    expect(asked[0]).toBe(fixPrompt(1));
    expect(out).toContain("was deleted");
    expect(result.Suburb).toEqual({ id: 8 });
  });

  it("a number changes that row; the table keeps every row and marks the change", async () => {
    const raw = [...demo(), { id: 77, name: "DOB (2026)", type: "date" }];
    const { result, out } = await run(raw, {}, [rowOf("Birthday"), choice('Use "DOB (2026)"'), ""]);
    expect(lastTable(out)).toHaveLength(FIELD_SPEC.length);
    expect(tableRow(out, "Birthday")).toMatch(/"DOB \(2026\)"\s+changed$/);
    expect(result.Birthday).toEqual({ id: 77 });
  });

  it("lists every usable field, saying what each in-use one is for, and why the rest aren't listed", async () => {
    const { out } = await run(demo(), {}, [rowOf("Postcode"), "1", ""]);
    const q = out.slice(out.lastIndexOf("Postcode (optional)"));
    expect(q).toContain('Use "Suburb" (text) - currently used for Suburb');
    expect(q).toMatch(/\d+ other fields aren't listed: .*can't hold this value/);
  });

  it("taking a field in use moves it; the field it came from becomes the problem to fix", async () => {
    const raw = [...demo(), { id: 501, name: "Locality", type: "str" }];
    const { result, asked, out } = await run(raw, {}, [rowOf("Postcode"), choice('Use "Suburb"'), "y", choice('Use "Locality"'), ""]);
    expect(out).toContain('"Suburb" is now used for Postcode; Suburb needs another field.');
    expect(asked[2]).toBe(fixPrompt(1));
    expect(result.Postcode).toEqual({ id: 42920715 });
    expect(result.Suburb).toEqual({ id: 501 });
    const ids = Object.values(result).flatMap((p) => ("id" in p ? [p.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("colours Employment Hero purple, Connecteam cyan and changes yellow, in the table and the questions", async () => {
    const raw = [...demo(), { id: 77, name: "DOB (2026)", type: "date" }];
    const answers = () => [rowOf("Birthday"), choice('Use "DOB (2026)"'), ""];
    expect((await run(raw, {}, answers())).out).not.toContain("\u001b[");
    const { out } = await run(raw, {}, answers(), { color: true });
    expect(out).toContain("\u001b[35mBirthday");
    expect(out).toContain('\u001b[36m"DOB (2026)"');
    expect(out).toContain("\u001b[33mchanged");
  });

  it("done finishes with problems left: what's decided is saved, the rest isn't", async () => {
    const raw = [...demo(), { id: 7, name: "Tax File Number", type: "str" }];
    const { result } = await run(raw, {}, ["done"]);
    expect(result.TFN).toBeUndefined();
    expect(result["Legal First Name"]).toEqual({ id: 42920713 });
  });

  describe("dropdown options (#112: the first client's options)", () => {
    const opts = (...values: string[]) => values.map((value) => ({ value, isDeleted: false }));
    const client = () =>
      demo().map((f) =>
        f.name === "Employee Status"
          ? { ...f, dropdownOptions: opts("Full-time", "Part-time", "Casual", "PBV", "Contractor") }
          : f.name === "Claim tax-free threshold?"
            ? { ...f, dropdownOptions: opts("Yes, claim tax free threshold", "No", "N/A", "TBC") }
            : f,
      );

    it("Y asks about each option that isn't an EH value; exact matches map themselves", async () => {
      // Employee Status: 1 FullTime, 2 PartTime, 3 Casual, 4 LabourHire, 5 not synced.
      // Tax question:    1 Yes, 2 No, 3 not synced.
      const { result, asked, out } = await run(client(), {}, ["y", "1", "2", "5", "", "5", "", "1", "3", "", "3", "", ""]);
      expect(asked[0]).toBe(fixPrompt(2));
      expect(asked.slice(1, -1).filter((q) => !q.startsWith("Keep "))).toEqual([
        'Employee Status: "Full-time" -> ',
        'Employee Status: "Part-time" -> ',
        'Employee Status: "PBV" -> ',
        'Employee Status: "Contractor" -> ',
        'Claim tax-free threshold?: "Yes, claim tax free threshold" -> ',
        'Claim tax-free threshold?: "N/A" -> ',
        'Claim tax-free threshold?: "TBC" -> ',
      ]);
      expect(out).toContain("Not synced: the employee gets a Correction message");
      expect(result["Employee Status"]).toEqual({
        id: 42920839,
        options: { "Full-time": "FullTime", "Part-time": "PartTime", Casual: "Casual", PBV: null, Contractor: null },
      });
      expect(result["Claim tax-free threshold?"]).toEqual({
        id: 42923276,
        options: { "Yes, claim tax free threshold": "yes", No: "no", "N/A": null, TBC: null },
      });
      expect((await run(client(), result, [""])).asked).toEqual([ALL_GOOD]);
    });

    it("warns when a tax answer that doesn't say Yes or No is sent as one; n asks again, y keeps it", async () => {
      // Employee Status as before; then the tax question: Yes / No / not synced = 1 / 2 / 3.
      const answers = ["y", "1", "2", "5", "", "5", "", "1", "2", "n", "3", "", "2", "y", "done"];
      const { result, asked, out } = await run(client(), {}, answers);
      const tax = asked.filter((q) => q.startsWith("Claim tax-free threshold?") || q.startsWith("Send "));
      expect(tax).toEqual([
        'Claim tax-free threshold?: "Yes, claim tax free threshold" -> ',
        'Claim tax-free threshold?: "N/A" -> ',
        'Send "N/A" as No anyway? [y/N] ',
        'Claim tax-free threshold?: "N/A" -> ',
        'Claim tax-free threshold?: "TBC" -> ',
        'Send "TBC" as No anyway? [y/N] ',
      ]);
      expect(out).toContain('"N/A" doesn\'t say Yes or No. Sending it as No tells Employment Hero the employee declared No');
      expect(result["Claim tax-free threshold?"]).toMatchObject({ options: { "N/A": null, TBC: "no" } });
      // Kept on purpose, but still shown as one to check.
      expect(asked.at(-1)).toBe(fixPrompt(1));
      expect(tableRow(out, "Claim tax-free threshold?")).toMatch(/1 answer to check$/);
    });

    it("Y on saved guesses asks again about just those answers", async () => {
      const picks: FieldPicks = {
        ...(await run(demo(), {}, [""])).result,
        "Employee Status": { id: 42920839, options: { "Full-time": "FullTime", "Part-time": "PartTime", Casual: "Casual", PBV: null, Contractor: null } },
        "Claim tax-free threshold?": { id: 42923276, options: { "Yes, claim tax free threshold": "yes", No: "no", "N/A": "no", TBC: "no" } },
      };
      const { result, asked } = await run(client(), picks, ["y", "3", "", "3", "", ""]);
      expect(asked).toEqual([
        fixPrompt(1),
        'Claim tax-free threshold?: "N/A" -> ',
        'Keep "Not synced" for "N/A"? [Y/n] ',
        'Claim tax-free threshold?: "TBC" -> ',
        'Keep "Not synced" for "TBC"? [Y/n] ',
        ALL_GOOD,
      ]);
      expect(result["Claim tax-free threshold?"]).toEqual({
        id: 42923276,
        options: { "Yes, claim tax free threshold": "yes", No: "no", "N/A": null, TBC: null },
      });
    });

    it("Employee Status can leave employees out: no EH record, no message", async () => {
      // Employee Status: 1-4 EH values, 5 not synced, 6 leave out. Tax: 1 Yes, 2 No, 3 not synced (+ Enter to confirm).
      const { result, out } = await run(client(), {}, ["y", "1", "2", "6", "6", "1", "3", "", "3", "", ""]);
      expect(out).toContain("6) Leave these employees out (no EH record, no message)");
      expect(result["Employee Status"]).toEqual({
        id: 42920839,
        options: { "Full-time": "FullTime", "Part-time": "PartTime", Casual: "Casual", PBV: null, Contractor: null },
        exclude: ["PBV", "Contractor"],
      });
      // Not offered for the tax question.
      expect(out.slice(out.indexOf("Claim tax-free threshold?: some"))).not.toContain("Leave these employees out");
    });

    it("Not synced shows the employee's message and confirms; n asks again", async () => {
      const answers = ["y", "1", "2", "5", "", "5", "", "1", "3", "n", "2", "y", "3", "", "done"];
      const { result, asked, out } = await run(client(), {}, answers);
      expect(out).toContain('Employees who answer "N/A" won\'t be synced. They\'ll be sent:');
      expect(out).toContain('"You answered "N/A" to "Claim tax-free threshold?". Employment Hero needs a Yes or No answer - please update it once you know."');
      expect(asked).toContain('Keep "Not synced" for "N/A"? [Y/n] ');
      expect(out).toContain('"You answered "PBV" to "Employee Status". Employment Hero can\'t use that answer - please choose a different option."');
      expect(result["Claim tax-free threshold?"]).toMatchObject({ options: { "N/A": "no", TBC: null } });
    });

    it("asks only about an option added since the last run", async () => {
      const picks: FieldPicks = {
        ...(await run(demo(), {}, [""])).result,
        "Employee Status": { id: 42920839, options: { "Full-time": "FullTime", "Part-time": "PartTime", Casual: "Casual", PBV: null } },
        "Claim tax-free threshold?": { id: 42923276, options: { "Yes, claim tax free threshold": "yes", No: "no", "N/A": null, TBC: null } },
      };
      const { result, asked, out } = await run(client(), picks, ["y", "4", ""]);
      expect(tableRow(out.slice(0, out.indexOf("Employee Status:")), "Employee Status")).toMatch(/1 option to map$/);
      expect(asked.slice(1, -1)).toEqual(['Employee Status: "Contractor" -> ']);
      expect(result["Employee Status"]).toMatchObject({ options: { Contractor: "LabourHire", PBV: null } });
    });
  });

  describe("super fields: all four or none (#117)", () => {
    const noUsi = () => demo().filter((f) => f.name !== "Super Fund USI");

    it("skipping one asks to skip super entirely; yes skips all four", async () => {
      const { result, asked, out } = await run(noUsi(), {}, ["y", choice("Skip"), "y", ""]);
      expect(asked[2]).toMatch(/^Skip super entirely\?/);
      expect(out).toContain("The sync needs all four super fields or none.");
      for (const name of ["Super Fund USI", "Super Fund ABN", "Super Fund Name", "Member Number"]) {
        expect(result[name]).toEqual({ skip: true });
      }
      expect(tableRow(out, "Super Fund ABN")).toMatch(/\(skipped\)\s+changed$/);
    });

    it("no goes back to the choices for that field", async () => {
      const { result } = await run(noUsi(), {}, ["y", choice("Skip"), "n", choice("Create"), ""]);
      expect(result["Super Fund USI"]).toEqual({ create: true });
      expect(result["Super Fund ABN"]).toEqual({ id: 42920783 });
    });
  });

  describe("Standard hours per week: optional (#118)", () => {
    const noHours = () => demo().filter((f) => f.name !== "Standard hours per week");

    it("isn't a problem when absent, and can be picked by number from a field named anything", async () => {
      const raw = [...noHours(), { id: 80, name: "Contracted hours", type: "number" }];
      const { result, asked, out } = await run(raw, {}, [rowOf("Standard hours per week"), choice('Use "Contracted hours"'), ""]);
      expect(asked[0]).toBe(ALL_GOOD);
      const q = out.slice(out.lastIndexOf("Standard hours per week (optional)"));
      expect(q).toContain("standard weekly hours");
      expect(q).not.toContain("Create a new");
      expect(result["Standard hours per week"]).toEqual({ id: 80 });
    });
  });

  describe("Connecteam's profile First name / Last name (legal-name fields only)", () => {
    it("is offered for Legal First Name, with the warning, and needs the legal-name confirmation", async () => {
      const { result, asked, out } = await run(demo(), {}, [rowOf("Legal First Name"), choice('Use profile "First name"'), "y", ""]);
      expect(out).toMatch(/Use profile "First name" \(Connecteam profile - may be a preferred name, not the legal one\)/);
      expect(asked[2]).toBe("The ATO needs the legal name. Are this client's profile first names their legal names? [y/N] ");
      expect(result["Legal First Name"]).toEqual({ profile: true });
      expect(tableRow(out, "Legal First Name")).toMatch(/profile "First name"\s+changed$/);
    });

    it("'n' to the confirmation goes back to the list", async () => {
      const { result } = await run(demo(), {}, [rowOf("Legal First Name"), choice('Use profile "First name"'), "n", choice('Use "Legal First Name"'), ""]);
      expect(result["Legal First Name"]).toEqual({ id: 42920713 });
    });

    it("isn't offered for any other field", async () => {
      const { out } = await run(demo(), {}, [rowOf("Title"), "1", ""]);
      expect(out.slice(out.lastIndexOf("Title ("))).not.toContain("Use profile");
    });
  });
});
