/**
 * The wizard's link stage (#154): `--stage link` runs it alone on a live
 * deployment. Runs the real wizard with a stub `npm` first on PATH that
 * records what it was asked to run, so nothing reaches Cloudflare.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const WIZARD = "scripts/setup-wizard.sh";

function wizard(args: string[], env: Record<string, string> = {}) {
  const bin = mkdtempSync(join(tmpdir(), "wizard-npm-"));
  const log = join(bin, "npm.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [[ "$*" == *deploy:config* && -n "\${FAIL_CONFIG:-}" ]]; then echo "D1 database not found"; exit 1; fi\nexit 0\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const r = spawnSync("bash", [WIZARD, ...args], {
    cwd: root,
    input: "",
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    timeout: 30_000,
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    /* npm never ran */
  }
  return { ...r, calls };
}

describe("setup wizard, link stage", () => {
  it("parses (bash -n)", () => {
    expect(spawnSync("bash", ["-n", WIZARD], { cwd: root, encoding: "utf8" }).status).toBe(0);
  });

  it("--stage link runs only the link stage: checks the built config against the live Worker, then the screen", () => {
    const r = wizard(["--stage", "link"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Stage 1/1 · Link Pre-existing employees");
    expect(r.stdout).not.toContain("Cloudflare account");
    expect(r.calls).toEqual(["run --silent deploy:config -- --check-live", "run --silent link"]);
  });

  it("stops before the screen when the deploy settings don't check out", () => {
    const r = wizard(["--stage", "link"], { FAIL_CONFIG: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("D1 database not found");
    expect(r.calls).toEqual(["run --silent deploy:config -- --check-live"]);
  });

  it("refuses a stage it doesn't know", () => {
    const r = wizard(["--stage", "nope"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown stage: nope");
    expect(r.calls).toEqual([]);
  });
});
