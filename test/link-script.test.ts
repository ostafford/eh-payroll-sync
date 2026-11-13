/**
 * `npm run link` when it isn't run in a terminal (piped, CI): it prints the
 * list and writes nothing (#154). Runs the real script against a saved
 * fixture, so no API key, network or wrangler.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("link stage, not in a terminal", () => {
  it("prints everyone in plain text, says it needs a terminal, writes nothing, and exits 3 (nothing saved)", () => {
    const r = spawnSync(join(root, "node_modules/.bin/tsx"), ["scripts/link.ts", "--data-file", "test/fixtures/link-stage-data.json"], {
      cwd: root,
      input: "",
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CT_API_KEY: "", EH_API_KEY: "" },
      timeout: 30_000,
    });
    expect(r.status).toBe(3);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toMatch(/1 \[ok\]\s+Jack Mitchell .*matched by email/);
    expect(r.stdout).toMatch(/2 \[!\]\s+Mia Chen .*name differs/);
    expect(r.stdout).toMatch(/3 \[-\]\s+Omar Haddad .*new hire/);
    expect(r.stdout + r.stderr).toContain("needs a terminal");
    expect(r.stdout).not.toContain("Saved");
  });

  it("checks the built config before reading anything (the database, not the live secrets: it can run before the first deploy), and stops if it doesn't check out", () => {
    const bin = mkdtempSync(join(tmpdir(), "link-npm-"));
    const log = join(bin, "npm.log");
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho "D1 database not found"\nexit 1\n`);
    chmodSync(join(bin, "npm"), 0o755);
    const r = spawnSync(join(root, "node_modules/.bin/tsx"), ["scripts/link.ts"], {
      cwd: root,
      input: "",
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1", CT_API_KEY: "unused", EH_API_KEY: "unused" },
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The deploy settings aren't ready");
    expect(r.stderr).toContain("D1 database not found");
    expect(readFileSync(log, "utf8").trim()).toBe("run --silent deploy:config -- --check-live --allow-missing-secrets");
  });
});
