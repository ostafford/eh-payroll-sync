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
  const demo = () => DEMO_CUSTOM_FIELDS.map((f) => ({ id: f.customFieldId, name: f.name, type: f.type }));
  const run = async (raw: any[], picks: FieldPicks, answers: string[]) => {
    const asked: string[] = [];
    const out: string[] = [];
    const result = await runFieldPicker(raw, picks, {
      ask: async (prompt) => {
        asked.push(prompt);
        const a = answers.shift();
        if (a === undefined) throw new Error(`no answer left for: ${prompt}`);
        return a;
      },
      print: (...lines) => out.push(...lines),
    });
    return { result, asked, out: out.join("\n") };
  };

  it("one 'y' confirms every automatic match, saving each by ID", async () => {
    const { result, asked } = await run(demo(), {}, ["y"]);
    expect(asked).toHaveLength(1);
    expect(Object.keys(result)).toHaveLength(FIELD_SPEC.filter((s) => s.create).length);
    expect(result.TFN).toEqual({ id: 42923222 });
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
    const n = String(pickerChoices(spec("Suburb"), raw).findIndex((c) => c.kind === "use" && c.field.id === 8) + 1);
    const again = await run(raw, first.result, [n]);
    expect(again.asked).toHaveLength(1);
    expect(again.asked[0]).toMatch(/^Pick 1-\d+ for Suburb: $/);
    expect(again.out).toContain("was deleted");
    expect(again.result.Suburb).toEqual({ id: 8 });
  });

  it("a number changes that one match, then asks again for the rest", async () => {
    const raw = demo();
    const startDate = pickerChoices(spec("Birthday"), raw).findIndex((c) => c.kind === "use" && c.field.name === "Employment Start Date");
    // Birthday is 3rd in the table (after the two legal names).
    const { result, asked, out } = await run(raw, {}, ["3", String(startDate + 1), "y"]);
    expect(out).toContain(' 3) Birthday');
    expect(asked).toHaveLength(3);
    expect(asked[2]).toContain("Use all 26");
    expect(result.Birthday).toEqual({ id: raw.find((f) => f.name === "Employment Start Date")!.id });
    expect(result.TFN).toEqual({ id: 42923222 });
  });

  it("'n' goes through every match one by one, the automatic match listed first", async () => {
    const all = await run(demo(), {}, ["y"]);
    const n = FIELD_SPEC.filter((s) => s.create).length;
    const oneByOne = await run(demo(), {}, ["n", ...Array(n).fill("1")]);
    expect(oneByOne.asked).toHaveLength(n + 1);
    expect(oneByOne.result).toEqual(all.result);
  });
});
