import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkDeployableFieldMap, checkFieldMapText, renderFieldMapCheck } from "../scripts/lib/validate-field-map.js";

const example = readFileSync(new URL("../clients/_example/field-map.json", import.meta.url), "utf8");
const PATH = "clients/acme/field-map.json";

describe("checkFieldMapText (issue #56)", () => {
  it("passes a valid map", () => {
    expect(checkFieldMapText(example)).toEqual({ ok: true });
  });

  it("lists only the schema problems, one per line, by path", () => {
    const map = JSON.parse(example);
    delete map.rules.taxDeclaration.claimTaxFreeThreshold;
    const result = checkFieldMapText(JSON.stringify(map));
    expect(result).toEqual({
      ok: false,
      problems: ["rules.taxDeclaration.claimTaxFreeThreshold: Required"],
    });
  });

  it("reports a JSON syntax error instead of throwing", () => {
    const result = checkFieldMapText('{ "client": "acme", }');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/^Not valid JSON: /);
    }
  });
});

describe("renderFieldMapCheck", () => {
  it("names the file on a pass", () => {
    expect(renderFieldMapCheck(PATH, { ok: true })).toBe(`✓ ${PATH} is valid.`);
  });

  it("names the file, counts the problems and lists each one", () => {
    const out = renderFieldMapCheck(PATH, { ok: false, problems: ["a: bad", "b: worse"] });
    expect(out).toBe(`✗ ${PATH} has 2 problems:\n    a: bad\n    b: worse`);
  });

  it("uses the singular for one problem", () => {
    expect(renderFieldMapCheck(PATH, { ok: false, problems: ["a: bad"] })).toContain("has 1 problem:");
  });
});

describe("checkDeployableFieldMap: a deploy needs this client's own map", () => {
  const real = JSON.stringify({ ...JSON.parse(example), client: "acme" });

  it("passes a valid map of the client's own", () => {
    expect(checkDeployableFieldMap(real)).toEqual({ ok: true });
  });

  it("stops when the map is missing, naming both ways to get it back", () => {
    const result = checkDeployableFieldMap(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join("\n")).toMatch(/not found[\s\S]*backup[\s\S]*npm run discover/);
  });

  it("stops on the placeholder a fresh clone builds with, even though it is a valid map", () => {
    expect(checkFieldMapText(example)).toEqual({ ok: true });
    const result = checkDeployableFieldMap(example);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join("\n")).toMatch(/placeholder[\s\S]*npm run discover/);
  });

  it("stops on an invalid map, listing its problems", () => {
    const map = JSON.parse(real);
    delete map.rules.taxDeclaration.claimTaxFreeThreshold;
    expect(checkDeployableFieldMap(JSON.stringify(map))).toEqual({
      ok: false,
      problems: ["rules.taxDeclaration.claimTaxFreeThreshold: Required"],
    });
  });
});
