/**
 * `npm run link` when it isn't run in a terminal (piped, CI): it prints the
 * list and writes nothing (#154). Runs the real script against a saved
 * fixture, so no API key, network or wrangler.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("link stage, not in a terminal", () => {
  it("prints everyone in plain text, says it needs a terminal, and writes nothing", () => {
    const r = spawnSync(join(root, "node_modules/.bin/tsx"), ["scripts/link.ts", "--data-file", "test/fixtures/link-stage-data.json"], {
      cwd: root,
      input: "",
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CT_API_KEY: "", EH_API_KEY: "" },
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).toMatch(/1 \[ok\]\s+Jack Mitchell .*matched by email/);
    expect(r.stdout).toMatch(/2 \[!\]\s+Mia Chen .*name differs/);
    expect(r.stdout).toMatch(/3 \[-\]\s+Omar Haddad .*new hire/);
    expect(r.stdout + r.stderr).toContain("needs a terminal");
    expect(r.stdout).not.toContain("Saved");
  });
});
