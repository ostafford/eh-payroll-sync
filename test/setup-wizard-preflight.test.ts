/**
 * The wizard's check before go-live (#168): `preflight_check` runs the
 * read-only preflight, shows its list and carries on only after a confirm,
 * whatever the check found. Runs the wizard's own functions, cut from the
 * script, with a stub `npm` first on PATH, so nothing reaches either API.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = readFileSync(join(root, "scripts/setup-wizard.sh"), "utf8");

/** A function's definition from the wizard: one line, or up to the closing `}`. */
function fn(name: string): string {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start === -1) throw new Error(`no ${name}() in the wizard`);
  if (lines[start]!.trimEnd().endsWith("}")) return lines[start]!;
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

/** Runs `preflight_check` with the stub npm exiting each code in `codes` in turn, then 0. */
function run(codes: number[], answers: string) {
  const bin = mkdtempSync(join(tmpdir(), "wizard-preflight-"));
  const log = join(bin, "npm.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
n=$(wc -l < "${log}" | tr -d ' ')
codes=(${codes.join(" ")})
echo "PREFLIGHT LIST $n"
exit "\${codes[$((n-1))]:-0}"
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const prelude = [
    "set -euo pipefail",
    "BOLD= DIM= RESET= BLUE= YELLOW= RED= GREEN=",
    ...["confirm", "warn", "note", "fail", "preflight_check"].map(fn),
    "preflight_check",
    "echo CARRIED-ON",
  ].join("\n");
  const r = spawnSync("bash", ["-c", prelude], {
    cwd: root,
    input: answers,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    timeout: 10_000,
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n");
  } catch {
    /* npm never ran */
  }
  return { ...r, calls };
}

describe("setup wizard, check before go-live", () => {
  it("runs right after the field map is written, before the pay-run settings", () => {
    const at = (s: string) => script.indexOf(s);
    expect(at('stage "Field map"')).toBeLessThan(at("\npreflight_check\n"));
    expect(at("\npreflight_check\n")).toBeLessThan(at('stage "Pay-run settings"'));
  });

  it("shows the list and carries on after a yes, even when someone needs a look", () => {
    const r = run([2], "y\n");
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(["run --silent preflight"]);
    expect(r.stdout).toContain("  PREFLIGHT LIST 1");
    expect(r.stdout).toContain("Some people need a look");
    expect(r.stdout).toContain("CARRIED-ON");
  });

  it("doesn't block when the check itself fails", () => {
    const r = run([1], "y\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("The check couldn't run");
    expect(r.stdout).toContain("CARRIED-ON");
  });

  it("checks again after a no, then carries on after a yes", () => {
    const r = run([2, 0], "n\ny\ny\n");
    expect(r.status).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.stdout).toContain("PREFLIGHT LIST 2");
    expect(r.stdout).toContain("CARRIED-ON");
  });

  it("stops, without carrying on, when there's no confirm", () => {
    const r = run([0], "");
    expect(r.status).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.stdout).toContain("Stopped here");
    expect(r.stdout).not.toContain("CARRIED-ON");
  });
});
