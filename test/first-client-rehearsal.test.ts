/**
 * The first client's setup call (#112), replayed from their field definitions
 * (test/fixtures/first-client-fields.json): what stopped the call, then the
 * picker answers a person would give, ending with a clean field check.
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { readFieldsFile } from "../scripts/lib/connecteam-custom-fields.js";
import { checkFields, summarise } from "../scripts/lib/field-check.js";
import { runFieldPicker } from "../scripts/lib/field-picker.js";

const raw = readFieldsFile(fileURLToPath(new URL("./fixtures/first-client-fields.json", import.meta.url)));
const row = (rows: ReturnType<typeof checkFields>, name: string) => rows.find((r) => r.name === name)!;
const idOf = (name: string) => raw.find((f) => f.name === name)!.id;

describe("first client's setup, replayed", () => {
  it("without picks: the (OLD) fields are passed over, the renamed questions and options need a human", () => {
    const rows = checkFields(raw);
    expect(row(rows, "Emergency Contact Number")).toMatchObject({ field: { id: idOf("Emergency Contact Number") }, result: { status: "found" } });
    expect(row(rows, "TFN").result.status).toBe("found");
    expect(row(rows, "Claim tax-free threshold?").result.status).toBe("missing");
    expect(row(rows, "Have a HELP/STSL study debt?").result.status).toBe("missing");
    expect(row(rows, "Employee Status")).toMatchObject({ blocking: true, result: { status: "options" } });
  });

  it("after the picker: a clean field check", async () => {
    // Reads a choice's number off the screen, as a person would.
    let screen: string[] = [];
    const numberOf = (fieldName: string) => () =>
      screen.map((l) => /^\s*(\d+)\) Use "(.*)" \(/.exec(l)).find((m) => m?.[2] === fieldName)![1]!;
    // What a person answers to each question, keyed by the question.
    const answers: Array<[RegExp, string | (() => string)]> = [
      [/^Use all \d+ matches/, "y"],
      [/^Pick .* for Claim tax-free threshold\?/, numberOf("Claim Tax Free Threshold?")],
      [/^Pick .* for Have a HELP/, numberOf(raw.find((f) => f.name.startsWith("Higher Education"))!.name)],
      [/^Gender: /, "3"], // Indeterminate (EH leaves it blank)
      [/^Employee Status: "Full-time"/, "1"],
      [/^Employee Status: "Part-time"/, "2"],
      [/^Employee Status: "(PBV|Contractor)"/, "5"], // not synced
      [/^Claim tax-free threshold\?: "Yes, claim/, "1"],
      [/^Claim tax-free threshold\?: "(N\/A|TBC)"/, "3"], // not synced
    ];
    const asked: string[] = [];
    const picks = await runFieldPicker(raw, {}, {
      ask: async (prompt) => {
        asked.push(prompt);
        const hit = answers.find(([q]) => q.test(prompt));
        if (!hit) throw new Error(`unexpected question: ${prompt}`);
        const answer = typeof hit[1] === "string" ? hit[1] : hit[1]();
        screen = [];
        return answer;
      },
      print: (...lines) => screen.push(...lines),
    });

    expect(asked).toHaveLength(1 + 2 + 3 + 4 + 3);
    expect(summarise(checkFields(raw, picks))).toEqual({ ok: 28, blocking: 0, warnings: 0, skipped: 0 });
  });
});
