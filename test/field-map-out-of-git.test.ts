// A client's field map is that deployment's own data, like .dev.vars: if git
// tracked it, a client who committed theirs could never `git pull` an update
// again (`--ff-only` refuses a split history), and a change to the file
// upstream would collide with theirs. So git ignores it, a fresh clone builds
// against the placeholder, and a deploy refuses anything but a real map.
// field-picks.json (the field check's choices) is the same kind of data.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFieldMap, resetFieldMapCache } from "../src/mapping/loader.js";

const MAP = "clients/self/field-map.json";
const PICKS = "clients/self/field-picks.json";
const read = (p: string) => readFileSync(p, "utf8");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });

describe("the client's field map stays out of git", () => {
  it.each([MAP, PICKS])("git ignores %s and doesn't track it", (file) => {
    expect(git("check-ignore", file).trim()).toBe(file);
    expect(git("ls-files", file).trim()).toBe("");
  });

  it("the deploy config refuses to build before checking the map", () => {
    const src = read("scripts/deploy-config.ts");
    expect(src).toContain("checkDeployableFieldMap");
    expect(src.indexOf("checkDeployableFieldMap(")).toBeLessThan(src.indexOf("writeFileSync(DEPLOY_CONFIG_PATH"));
  });

  it("tests build against the fixture, never the client's own map", () => {
    resetFieldMapCache();
    expect(loadFieldMap()).toEqual(loadFieldMap("self"));
    expect(loadFieldMap().employmentHero).toEqual(JSON.parse(read("test/fixtures/demo-field-map.json")).employmentHero);
  });
});

describe("npm install gives a fresh clone a placeholder map to build with", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  const run = (cwd: string) => execFileSync("node", [join(process.cwd(), "scripts/ensure-field-map.mjs")], { cwd });
  const clone = () => {
    const dir = mkdtempSync(join(tmpdir(), "eh-map-"));
    cpSync("clients/_example", join(dir, "clients/_example"), { recursive: true });
    return dir;
  };

  it("runs on postinstall", () => {
    expect(scripts.postinstall).toBe("node scripts/ensure-field-map.mjs");
  });

  it("copies the example in when the map is missing", () => {
    const dir = clone();
    run(dir);
    expect(read(join(dir, MAP))).toBe(read("clients/_example/field-map.json"));
  });

  it("never touches a map that is already there", () => {
    const dir = clone();
    run(dir);
    writeFileSync(join(dir, MAP), '{"client":"acme"}');
    run(dir);
    expect(read(join(dir, MAP))).toBe('{"client":"acme"}');
  });
});
