/**
 * `npm run field-check` when it isn't run in a terminal (the wizard piping it,
 * CI): it prints the check and asks nothing (#112). Runs the real script
 * against the first client's saved field list, so no API key or network.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (...args: string[]) => {
  const scratch = mkdtempSync(join(tmpdir(), "field-check-"));
  const r = spawnSync(
    join(root, "node_modules/.bin/tsx"),
    [
      "scripts/field-check.ts",
      "--fields-file",
      "test/fixtures/first-client-fields.json",
      ...args,
    ],
    {
      cwd: root,
      input: "y\n1\n",
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratch, NO_COLOR: "1" },
      timeout: 30_000,
    },
  );
  return { ...r, scratch };
};

describe("field-check, not in a terminal", () => {
  it.each([
    { mode: "piped", args: [] },
    { mode: "--check-only", args: ["--check-only"] },
  ])(
    "$mode: prints the table with why + fix, asks nothing, saves nothing, exits 2 on a blocking problem",
    ({ args }) => {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.stdout).toMatch(
        /Employment Hero needs\s+Your Connecteam field\s+Status/,
      );
      expect(r.stdout).toMatch(
        /\[x\] Employee Status\s+"Employee Status"\s+4 options to map/,
      );
      expect(r.stdout).toContain("Why:");
      expect(r.stdout).not.toMatch(/Fix the \d+ problems? now\?/);
      expect(existsSync(join(r.scratch, "eh-field-picks.rehearsal.json"))).toBe(
        false,
      );
    },
  );
});
