/**
 * The wizard's session log (#83) keeps a copy of the run for the integrator,
 * but never the link stage's screen: names and emails stay on screen (#154).
 * Runs the wizard's own clean_log on a sample recording.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function cleanLog(recording: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wizard-log-"));
  const log = join(dir, "run.log");
  writeFileSync(log, recording);
  const r = spawnSync(
    "bash",
    ["-c", `eval "$(sed -n '/^clean_log() {/,/^}/p' scripts/setup-wizard.sh)"; ENV_FILE="${join(dir, "none")}"; clean_log "${log}"`],
    { cwd: root, encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(log, "utf8");
}

const screen = (body: string) => `\u001b[?1049h\u001b[?25l\u001b[H\u001b[2J${body}`;

describe("wizard session log", () => {
  it("keeps the stage text but drops everything drawn on the link stage's screen", () => {
    const out = cleanLog(
      `Stage 13/14 · Link Pre-existing employees\r\n` +
        screen("> 2 [!] Mia Chen  mia@example.com → Mia Chen-Wong ?\r\n  Row 2  Mia Chen  mia@example.com\r\n") +
        `\u001b[?25h\u001b[?1049lSaved: 1 link added or changed.\r\n`,
    );
    expect(out).toContain("Stage 13/14 · Link Pre-existing employees");
    expect(out).toContain("Saved: 1 link added or changed.");
    expect(out).not.toContain("Mia");
    expect(out).not.toContain("mia@example.com");
  });

  it("drops a screen that never closed (the run stopped mid-screen) to the end of the log", () => {
    const out = cleanLog(`Stage 1/1 · Link Pre-existing employees\n${screen("  Row 2  Mia Chen  mia@example.com\n")}`);
    expect(out).toContain("Stage 1/1");
    expect(out).not.toContain("mia@example.com");
  });
});
