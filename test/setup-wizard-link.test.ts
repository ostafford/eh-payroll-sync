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
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [[ "$*" == *link* && -n "\${FAIL_LINK:-}" ]]; then exit 1; fi\nexit 0\n`,
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

  it("--stage link runs only the link stage", () => {
    const r = wizard(["--stage", "link"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Stage 1/1 · Link Pre-existing employees");
    expect(r.stdout).not.toContain("Cloudflare account");
    expect(r.calls).toEqual(["run --silent link"]);
  });

  it("stops, saying nothing changed, when the stage fails (e.g. the deploy settings don't check out)", () => {
    const r = wizard(["--stage", "link"], { FAIL_LINK: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("The link stage stopped: the Link list was not changed.");
  });

  it("refuses a stage it doesn't know", () => {
    const r = wizard(["--stage", "nope"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown stage: nope");
    expect(r.calls).toEqual([]);
  });

  it("refuses --stage with no name, rather than running the whole wizard", () => {
    const r = wizard(["--stage"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--stage needs a name");
    expect(r.calls).toEqual([]);
  });

  it("in a terminal, passes --stage link on to the copy of itself that keeps the session log", () => {
    // The log wrapper only runs in a terminal: give the wizard one with the real `script`,
    // and put a stub `script` first on PATH that records what the wrapper hands on.
    const bin = mkdtempSync(join(tmpdir(), "wizard-script-"));
    const log = join(bin, "script.log");
    writeFileSync(join(bin, "script"), `#!/usr/bin/env bash\n[[ "\${1:-}" == "--version" ]] && exit 1\nprintf '%s\\n' "$*" >> "${log}"\n`);
    chmodSync(join(bin, "script"), 0o755);
    const inner = `PATH="${bin}:$PATH" bash ${WIZARD} --stage link`;
    const outer = process.platform === "darwin" ? ["-q", "/dev/null", "bash", "-c", inner] : ["-qec", inner, "/dev/null"];
    // stdin from /dev/null: `script` refuses a pipe or socket.
    const r = spawnSync("/usr/bin/script", outer, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toMatch(/setup-wizard-\S+\.log bash scripts\/setup-wizard\.sh --stage link$/m);
  });
});
