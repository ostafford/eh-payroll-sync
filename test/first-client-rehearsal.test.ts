/**
 * The first client's setup call (#112), replayed from their field definitions
 * (test/fixtures/first-client-fields.json): what stopped the call, then the
 * combined field check's questions answered as a person would, ending clean.
 */
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { readFieldsFile } from "../scripts/lib/connecteam-custom-fields.js";
import { checkFields, summarise } from "../scripts/lib/field-check.js";
import { reviewFields } from "../scripts/lib/field-picker.js";

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

  it("through the combined field check: Y fixes each problem, ending in a clean check", async () => {
    // Reads a choice's number off the screen, as a person would.
    let screen: string[] = [];
    const numberOf = (fieldName: string) => () =>
      screen.map((l) => /^\s*(\d+)\) Use "(.*)" \(/.exec(l)).find((m) => m?.[2] === fieldName)![1]!;
    // What a person answers to each question, keyed by the question.
    const answers: Array<[RegExp, string | (() => string)]> = [
      [/^Fix the 4 problems now\?/, "y"],
      [/^Gender: /, "3"], // Indeterminate (EH leaves it blank)
      [/^Employee Status: "Full-time"/, "1"],
      [/^Employee Status: "Part-time"/, "2"],
      [/^Employee Status: "PBV"/, "6"], // left out: the client says PBV staff don't go into EH
      [/^Employee Status: "Contractor"/, "5"], // not synced (still to confirm with the client)
      [/^Pick .* for Claim tax-free threshold\?/, numberOf("Claim Tax Free Threshold?")],
      [/^Claim tax-free threshold\?: "Yes, claim/, "1"],
      [/^Claim tax-free threshold\?: "(N\/A|TBC)"/, "3"], // not synced
      [/^Pick .* for Have a HELP/, numberOf(raw.find((f) => f.name.startsWith("Higher Education"))!.name)],
      [/^Keep "Not synced" for /, ""],
      [/^Everything's in place/, ""],
    ];
    const asked: string[] = [];
    const picks = await reviewFields(raw, {}, {
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

    // Fix prompt, Gender 3, Employee Status 4 (+1 confirm), pick the threshold question, its 3 answers (+2 confirms), pick HELP, finish.
    expect(asked).toHaveLength(1 + 3 + 4 + 1 + 1 + 3 + 2 + 1 + 1);
    expect(summarise(checkFields(raw, picks))).toEqual({ ok: 28, blocking: 0, warnings: 0, skipped: 1, toCreate: 0 });
    expect(picks["Employee Status"]).toMatchObject({ exclude: ["PBV"], options: { PBV: null, Contractor: null } });
    expect(picks["Claim tax-free threshold?"]).toMatchObject({ options: { "N/A": null, TBC: null } });
  });
});
