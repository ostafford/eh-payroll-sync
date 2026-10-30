import { describe, it, expect } from "vitest";
import { FIELD_SPEC } from "../scripts/lib/field-spec.js";
import { resolveField } from "../scripts/lib/field-resolve.js";

const spec = (name: string) => FIELD_SPEC.find((s) => s.name === name)!;

describe("resolveField", () => {
  it("prefers the new field over a renamed '(OLD)' one listed first (first client's setup)", () => {
    const fields = [
      { id: 1, name: "Emergency Contact Number (OLD)", type: "phone" },
      { id: 2, name: "Emergency Contact Number", type: "str" },
    ];
    expect(resolveField(spec("Emergency Contact Number"), fields)).toEqual({
      status: "matched",
      field: fields[1],
      picked: false,
    });
  });

  it.each(["Postcode (OLD)", "Postcode old", "Postcode - deprecated"])("drops '%s' when a same-type field remains", (oldName) => {
    const fields = [
      { id: 1, name: oldName, type: "str" },
      { id: 2, name: "Postcode", type: "str" },
    ];
    expect(resolveField(spec("Postcode"), fields)).toMatchObject({ status: "matched", field: { id: 2 } });
  });

  it("keeps a lone match of the wrong type, so the check can say so instead of 'missing'", () => {
    const fields = [{ id: 1, name: "TFN (OLD)", type: "number" }];
    expect(resolveField(spec("TFN"), fields)).toMatchObject({ status: "matched", field: { id: 1 } });
  });

  it("never picks by list order: two current, right-type matches are ambiguous", () => {
    const fields = [
      { id: 1, name: "Start Date", type: "date" },
      { id: 2, name: "Employment Start Date", type: "date" },
    ];
    expect(resolveField(spec("Employment Start Date"), fields)).toEqual({ status: "ambiguous", candidates: fields });
  });

  it("a saved pick wins by ID, whatever the field is named", () => {
    const fields = [
      { id: 1, name: "Claim tax-free threshold? (OLD)", type: "dropdown" },
      { id: 2, name: "Claim Tax Free Threshold?", type: "dropdown" },
    ];
    const picks = { "Claim tax-free threshold?": { id: 2 } };
    expect(resolveField(spec("Claim tax-free threshold?"), fields, picks)).toEqual({ status: "matched", field: fields[1], picked: true });
  });

  it("reports a pick whose field was deleted, rather than falling back to the name", () => {
    const fields = [{ id: 1, name: "TFN", type: "str" }];
    expect(resolveField(spec("TFN"), fields, { TFN: { id: 99 } })).toEqual({ status: "stalePick", id: 99 });
  });

  it("finds nothing when no name matches", () => {
    expect(resolveField(spec("TFN"), [{ id: 1, name: "Suburb", type: "str" }])).toEqual({ status: "none" });
  });
});
