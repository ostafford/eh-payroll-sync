// `self` here is test/fixtures/demo-field-map.json, not the clone's own map
// (vitest.config.ts), so these pass the same on every clone.
import { describe, it, expect, beforeEach } from "vitest";
import { loadFieldMap, resetFieldMapCache, FieldMapError } from "../src/mapping/loader.js";

beforeEach(resetFieldMapCache);

describe("loadFieldMap", () => {
  it("loads and validates the bundled _example map", () => {
    const map = loadFieldMap("_example");
    expect(map.client).toBe("example");
    expect(map.fields.length).toBeGreaterThan(10);
    expect(map.employmentHero.businessId).toBe("555455");
  });

  it("memoises the parsed map for the same client", () => {
    expect(loadFieldMap("_example")).toBe(loadFieldMap("_example"));
  });

  it("defaults to clients/self when given no client (or a blank one)", () => {
    expect(loadFieldMap().client).toBe("self");
    resetFieldMapCache();
    expect(loadFieldMap("").client).toBe("self");
    resetFieldMapCache();
    expect(loadFieldMap("   ").client).toBe("self");
    resetFieldMapCache();
    expect(loadFieldMap(undefined).client).toBe("self");
  });

  it("throws a helpful FieldMapError for an unregistered client", () => {
    try {
      loadFieldMap("acme");
      throw new Error("expected loadFieldMap to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FieldMapError);
      expect((err as Error).message).toContain('FIELD_MAP_CLIENT="acme"');
      expect((err as Error).message).toContain("clients/acme/field-map.json");
      expect((err as Error).message).toContain("_example");
    }
  });
});

describe("messages.employeeSuccess (issue #71)", () => {
  it("defaults on when a client's map leaves it out", () => {
    expect(loadFieldMap("_example").messages.employeeSuccess).toBe(true);
  });

  it("is on for the demo client's map", () => {
    expect(loadFieldMap("self").messages.employeeSuccess).toBe(true);
  });
});
