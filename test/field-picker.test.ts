import { describe, it, expect } from "vitest";
import { applyChoice, pickerChoices, runFieldPicker } from "../scripts/lib/field-picker.js";
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

describe("runFieldPicker (scripted answers)", () => {
  // The demo account plus an hours field (it has none), so one "y" answers every field.
  const demo = () => [
    ...DEMO_CUSTOM_FIELDS.map((f) => ({ id: f.customFieldId, name: f.name, type: f.type })),
    { id: 99001, name: "Standard hours per week", type: "number" },
  ];
  /** A function answer reads the screen so far, as a person would. */
  const run = async (
    raw: any[],
    picks: FieldPicks,
    answers: Array<string | ((screen: string) => string)>,
    { color = false }: { color?: boolean } = {},
  ) => {
    const asked: string[] = [];
    const out: string[] = [];
    const result = await runFieldPicker(raw, picks, {
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

  it("one 'y' confirms every automatic match, saving each by ID", async () => {
    const { result, asked } = await run(demo(), {}, ["y"]);
    expect(asked).toHaveLength(1);
    expect(Object.keys(result)).toHaveLength(FIELD_SPEC.length);
    expect(result.TFN).toEqual({ id: 42923222 });
  });

  describe("changing a match: every usable field is listed (your rehearsal)", () => {
    const row = (name: string) => (screen: string) => new RegExp(`(\\d+)\\) ${name}\\s`).exec(screen)![1]!;
    const choice = (field: string) => (screen: string) =>
      [...screen.matchAll(new RegExp(`(\\d+)\\) Use "${field}"`, "g"))].at(-1)![1]!;
    const question = (out: string, name: string) => {
      const from = out.lastIndexOf(`${name} (`);
      const to = out.indexOf("Matched automatically", from);
      return to === -1 ? out.slice(from) : out.slice(from, to);
    };

    it("lists fields in use elsewhere, saying what for, and why the rest aren't listed", async () => {
      const { out } = await run(demo(), {}, [row("Postcode"), "1", "y"]);
      const q = question(out, "Postcode");
      expect(q).toContain('Use "Postcode" (text)');
      expect(q).toContain('Use "Suburb" (text) - currently used for Suburb');
      expect(q).toContain('Use "Legal Surname" (text) - currently used for Legal Surname');
      expect(q).toMatch(/\d+ other fields aren't listed: .*can't hold this value/);
      expect(q).toContain('Use "Standard hours per week" (number) - currently used for');
    });

    it("picking a field in use moves it, and the field it came from is asked again", async () => {
      // The client's postcode is really in the field matched to Suburb.
      const raw = [...demo(), { id: 501, name: "Locality", type: "str" }];
      const { result, asked } = await run(raw, {}, [row("Postcode"), choice("Suburb"), "y", choice("Locality")]);
      expect(result.Postcode).toEqual({ id: 42920715 }); // the field named "Suburb"
      expect(asked.at(-1)).toBe("Pick 1-" + asked.at(-1)!.match(/1-(\d+)/)![1] + " for Suburb: ");
      expect(result.Suburb).toEqual({ id: 501 });
      const ids = Object.values(result).flatMap((p) => ("id" in p ? [p.id] : []));
      expect(new Set(ids).size).toBe(ids.length); // still no field used twice
    });

    /** The last "Matched automatically" table printed, rows only. */
    const lastTable = (out: string) => {
      const lines = out.slice(out.lastIndexOf("Matched automatically")).split("\n");
      const end = lines.indexOf("", 1);
      return lines.slice(0, end === -1 ? undefined : end).filter((l) => /^\s+\d+\) /.test(l));
    };

    it("keeps a changed row in the table, showing your choice, so the count never drops", async () => {
      const raw = [...demo(), { id: 77, name: "DOB (2026)", type: "date" }];
      const { asked, out } = await run(raw, {}, [row("Birthday"), choice("DOB \\(2026\\)"), "y"]);
      const table = lastTable(out);
      expect(table).toHaveLength(FIELD_SPEC.length);
      expect(table.find((l) => l.includes("Birthday"))).toMatch(/Birthday\s+"DOB \(2026\)"\s+← changed/);
      expect(asked.at(-1)).toBe(`Use the ${FIELD_SPEC.length - 1} automatic matches? Your 1 change is kept. [Y / n / number to change] `);
    });

    it("shows a moved field as asked below", async () => {
      const raw = [...demo(), { id: 501, name: "Locality", type: "str" }];
      const { out } = await run(raw, {}, [row("Postcode"), choice("Suburb"), "y", choice("Locality")]);
      const table = lastTable(out);
      expect(table).toHaveLength(FIELD_SPEC.length);
      expect(table.find((l) => / Suburb\s/.test(l))).toMatch(/\(asked below\)\s+← moved/);
      expect(table.find((l) => l.includes("Postcode"))).toMatch(/"Suburb"\s+← changed/);
    });

    it("heads the columns, and colours Employment Hero purple, Connecteam cyan, changes yellow", async () => {
      const raw = [...demo(), { id: 77, name: "DOB (2026)", type: "date" }];
      const answers = () => [row("Birthday"), choice("DOB \\(2026\\)"), "y"];
      const plain = (await run(raw, {}, answers())).out;
      expect(plain).toMatch(/Employment Hero needs\s+Your Connecteam field/);
      expect(plain).not.toContain("\u001b[");

      const coloured = (await run(raw, {}, answers(), { color: true })).out;
      expect(coloured).toContain("\u001b[35mBirthday"); // EH name: purple
      expect(coloured).toContain('\u001b[36m"DOB (2026)"'); // Connecteam field: cyan
      expect(coloured).toContain("\u001b[33m← changed"); // change: yellow
      expect(coloured).toContain('\u001b[36m"Legal Surname"'); // in the question too
    });

    it("the same for a field saved on an earlier run", async () => {
      const first = (await run(demo(), {}, ["y"])).result;
      const raw = demo().filter((f) => f.name !== "Postcode");
      const { result, asked } = await run(raw, first, [choice("Suburb"), choice("Employee ID")]);
      expect(asked.map((a) => a.replace(/1-\d+/, "1-N"))).toEqual(["Pick 1-N for Postcode: ", "Pick 1-N for Suburb: "]);
      expect(result.Postcode).toEqual({ id: 42920715 });
    });
  });

  it("asks about an ambiguous field on its own, by number", async () => {
    const raw = [...demo(), { id: 7, name: "Tax File Number", type: "str" }];
    const { result, asked, out } = await run(raw, {}, ["y", "2"]);
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("TFN");
    expect(out).toContain('1) Use "TFN"');
    expect(out).toContain('2) Use "Tax File Number"');
    expect(result.TFN).toEqual({ id: 7 });
  });

  it("a re-run with saved picks asks nothing, except about a pick whose field was deleted", async () => {
    const first = await run(demo(), {}, ["y"]);
    expect((await run(demo(), first.result, [])).asked).toEqual([]);

    const gone = demo().filter((f) => f.name !== "Suburb");
    const raw = [...gone, { id: 8, name: "Locality", type: "str" }];
    const locality = (screen: string) => [...screen.matchAll(/(\d+)\) Use "Locality"/g)].at(-1)![1]!;
    const again = await run(raw, first.result, [locality]);
    expect(again.asked).toHaveLength(1);
    expect(again.asked[0]).toMatch(/^Pick 1-\d+ for Suburb: $/);
    expect(again.out).toContain("was deleted");
    expect(again.result.Suburb).toEqual({ id: 8 });
  });

  it("a number changes that one match, then asks again for the rest", async () => {
    const raw = [...demo(), { id: 77, name: "DOB (2026)", type: "date" }];
    const dob = (screen: string) => [...screen.matchAll(/(\d+)\) Use "DOB \(2026\)"/g)].at(-1)![1]!;
    // Birthday is 3rd in the table (after the two legal names).
    const { result, asked, out } = await run(raw, {}, ["3", dob, "y"]);
    expect(out).toContain(' 3) Birthday');
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain("Use the 27 automatic matches? Your 1 change is kept.");
    expect(result.Birthday).toEqual({ id: 77 });
    expect(result.TFN).toEqual({ id: 42923222 });
  });

  it("'n' goes through every match one by one, the automatic match listed first", async () => {
    const all = await run(demo(), {}, ["y"]);
    const n = FIELD_SPEC.length;
    const oneByOne = await run(demo(), {}, ["n", ...Array(n).fill("1")]);
    expect(oneByOne.asked).toHaveLength(n + 1);
    expect(oneByOne.result).toEqual(all.result);
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

    it("asks about each option that isn't an EH value; exact matches map themselves", async () => {
      // Employee Status: 1 FullTime, 2 PartTime, 3 Casual, 4 LabourHire, 5 not synced.
      // Tax question:    1 Yes, 2 No, 3 not synced.
      const { result, asked, out } = await run(client(), {}, ["y", "1", "2", "5", "5", "1", "3", "3"]);
      expect(asked.slice(1)).toEqual([
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

      expect((await run(client(), result, [])).asked).toEqual([]);
    });

    it("asks only about an option added since the last run", async () => {
      const picks: FieldPicks = {
        ...(await run(demo(), {}, ["y"])).result,
        "Employee Status": { id: 42920839, options: { "Full-time": "FullTime", "Part-time": "PartTime", Casual: "Casual", PBV: null } },
        "Claim tax-free threshold?": { id: 42923276, options: { "Yes, claim tax free threshold": "yes", No: "no", "N/A": null, TBC: null } },
      };
      const { result, asked } = await run(client(), picks, ["4"]);
      expect(asked).toEqual(['Employee Status: "Contractor" -> ']);
      expect(result["Employee Status"]).toMatchObject({ options: { Contractor: "LabourHire", PBV: null } });
    });
  });

  describe("super fields: all four or none (#117)", () => {
    const SUPER = ["Super Fund USI", "Super Fund ABN", "Super Fund Name", "Member Number"];
    const noUsi = () => demo().filter((f) => f.name !== "Super Fund USI");
    const skip = (screen: string) => [...screen.matchAll(/(\d+)\) Skip/g)].at(-1)![1]!;

    it("skipping one asks to skip super entirely; yes skips all four", async () => {
      const { result, asked, out } = await run(noUsi(), {}, ["y", skip, "y"]);
      expect(asked.at(-1)).toMatch(/^Skip super entirely\?/);
      expect(out).toContain("The sync needs all four super fields or none.");
      for (const name of SUPER) expect(result[name]).toEqual({ skip: true });
    });

    it("no goes back to the choices for that field", async () => {
      const usiNumber = (screen: string) => [...screen.matchAll(/(\d+)\) Create a new "Super Fund USI"/g)].at(-1)![1]!;
      const { result } = await run(noUsi(), {}, ["y", skip, "n", usiNumber]);
      expect(result["Super Fund USI"]).toEqual({ create: true });
      expect(result["Super Fund ABN"]).toEqual({ id: 42920783 });
    });

    it("changing a matched super field to Skip, then yes, keeps 'use all' from undoing it", async () => {
      const usiRow = (screen: string) => /(\d+)\) Super Fund USI/.exec(screen)![1]!;
      const { result } = await run(demo(), {}, [usiRow, skip, "y", "y"]);
      for (const name of SUPER) expect(result[name]).toEqual({ skip: true });
      expect(result.TFN).toEqual({ id: 42923222 });
    });
  });

  describe("Standard hours per week: optional (#118)", () => {
    const noHours = () => demo().filter((f) => f.name !== "Standard hours per week");

    it("asks about it with what it's for, offers a number field named anything, and never Create", async () => {
      const raw = [...noHours(), { id: 80, name: "Contracted hours", type: "number" }];
      const contracted = (screen: string) => [...screen.matchAll(/(\d+)\) Use "Contracted hours" \(number\)/g)].at(-1)![1]!;
      const { result, out } = await run(raw, {}, ["y", contracted]);
      const q = out.slice(out.lastIndexOf("Standard hours per week (optional)"));
      expect(q).toContain("standard weekly hours");
      expect(q).not.toContain("Create a new");
      expect(q).toContain("Skip");
      expect(result["Standard hours per week"]).toEqual({ id: 80 });
      expect((await run(raw, result, [])).asked).toEqual([]);
    });

    it("can be skipped", async () => {
      const skip = (screen: string) => [...screen.matchAll(/(\d+)\) Skip/g)].at(-1)![1]!;
      const { result } = await run(noHours(), {}, ["y", skip]);
      expect(result["Standard hours per week"]).toEqual({ skip: true });
    });
  });

  describe("Connecteam's profile First name / Last name (legal-name fields only)", () => {
    const profile = (screen: string) => [...screen.matchAll(/(\d+)\) Use profile "First name"/g)].at(-1)![1]!;
    const firstRow = (screen: string) => /(\d+)\) Legal First Name\s/.exec(screen)![1]!;

    it("is offered for Legal First Name, with the warning, and needs the legal-name confirmation", async () => {
      const { result, asked, out } = await run(demo(), {}, [firstRow, profile, "y", "y"]);
      expect(out).toMatch(/Use profile "First name" \(Connecteam profile - may be a preferred name, not the legal one\)/);
      expect(asked[2]).toMatch(/^The ATO needs the legal name\. Are this client's profile first names their legal names\? \[y\/N\] $/);
      expect(result["Legal First Name"]).toEqual({ profile: true });
      const table = out.slice(out.lastIndexOf("Matched automatically"));
      expect(table).toMatch(/Legal First Name\s+profile "First name"\s+← changed/);
    });

    it("'n' to the confirmation goes back to the list", async () => {
      const keep = (screen: string) => [...screen.matchAll(/(\d+)\) Use "Legal First Name"/g)].at(-1)![1]!;
      const { result } = await run(demo(), {}, [firstRow, profile, "n", keep, "y"]);
      expect(result["Legal First Name"]).toEqual({ id: 42920713 });
    });

    it("isn't offered for any other field", async () => {
      const { out } = await run(demo(), {}, [(s) => /(\d+)\) Title\s/.exec(s)![1]!, "1", "y"]);
      const q = out.slice(out.lastIndexOf("Title ("));
      expect(q).not.toContain("Use profile");
    });
  });
});
