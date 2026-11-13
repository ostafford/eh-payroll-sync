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
// Run from inside the wizard (its test stage), the suite inherits the wizard's
// session-log vars: a WIZARD_LOG makes the copy under test skip the log
// wrapper and run the real stage against the live accounts.
const { WIZARD_LOG: _log, WIZARD_DETAILS: _details, ...cleanEnv } = process.env;

function wizard(args: string[], env: Record<string, string> = {}, input = "") {
  const bin = mkdtempSync(join(tmpdir(), "wizard-npm-"));
  const log = join(bin, "npm.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nif [[ "$*" == *link* && -n "\${FAIL_LINK:-}" ]]; then exit 1; fi\nif [[ "$*" == *preflight* ]]; then exit "\${PREFLIGHT_RC:-0}"; fi\nexit 0\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  const r = spawnSync("bash", [WIZARD, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...cleanEnv, PATH: `${bin}:${process.env.PATH}`, ...env },
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

  it("--stage link runs only the link stage, with the check before go-live first (#168)", () => {
    const r = wizard(["--stage", "link"], {}, "y\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Stage 1/1 · Link Pre-existing employees");
    expect(r.stdout).not.toContain("Cloudflare account");
    expect(r.calls).toEqual(["run --silent preflight", "run --silent link"]);
  });

  it("asks to open the Link list, pointing held people there", () => {
    const r = wizard(["--stage", "link"], { PREFLIGHT_RC: "2" }, "y\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Open the Link list?");
    expect(r.stdout).toContain("can be linked to that record in the Link list, next.");
    expect(r.calls).toEqual(["run --silent preflight", "run --silent link"]);
  });

  it("doesn't open the Link list until the check is confirmed", () => {
    const r = wizard(["--stage", "link"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Stopped here");
    expect(r.calls).toEqual(["run --silent preflight"]);
  });

  it("stops, saying nothing changed, when the stage fails (e.g. the deploy settings don't check out)", () => {
    const r = wizard(["--stage", "link"], { FAIL_LINK: "1" }, "y\n");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("The link stage stopped: the Link list was not changed.");
  });

  it("on a first setup, links before the deploy, so nothing goes live until the Link list is settled (ADR-0012)", () => {
    const script = readFileSync(join(root, WIZARD), "utf8");
    // Whole lines only, so a comment naming a call doesn't count.
    const at = (line: string) => {
      const i = script.search(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      expect(i, line).toBeGreaterThan(-1);
      return i;
    };
    const provision = at('stage "Provision Cloudflare resources"');
    const link = at("link_stage before-deploy");
    const deploy = at('stage "Push secrets + deploy"');
    expect(provision).toBeLessThan(link);
    expect(link).toBeLessThan(deploy);
    // The only other call is --stage link's, before the first stage.
    expect(script.slice(deploy)).not.toMatch(/^\s*link_stage\b/m);
  });

  it("before the deploy, runs the gated link and stops with nothing live if nothing was saved", () => {
    const script = readFileSync(join(root, WIZARD), "utf8");
    const body = script.slice(script.indexOf("link_stage() {"), script.indexOf('if [[ "$STAGE_ONLY" == "link" ]]'));
    expect(body).toContain("npm run --silent link -- --before-deploy");
    expect(body).toContain("nothing is live yet");
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
    const r = spawnSync("/usr/bin/script", outer, { cwd: root, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(log, "utf8")).toMatch(/setup-wizard-\S+\.log bash scripts\/setup-wizard\.sh --stage link$/m);
  });
});
