/**
 * `npm run eh-diff -- snapshot <EH id>...` / `npm run eh-diff -- diff`
 *
 * Read-only. Proves EH changed nothing but the Payroll ID (#157): `snapshot`
 * saves the full record of each chosen EH employee to a git-ignored local
 * file; `diff` reads them again and lists the fields that changed, by name
 * only ("set" / "changed" / "cleared"), never a value. Take the snapshot
 * before releasing a canary's approvals, diff after. See scripts/lib/eh-diff.ts.
 *
 * Options: `--file <path>` (default eh-snapshot.json, git-ignored); `--force`
 * lets `snapshot` replace an existing file, which loses that "before".
 *
 * Exit code: 0 = nothing beyond the Payroll ID changed (or a snapshot was
 * saved), 2 = something else changed, 1 = the check itself failed.
 *
 * Env (from .dev.vars or the shell): EH_API_KEY, EH_BUSINESS_ID.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EhPayrollClient } from "../src/eh/client.js";
import {
  DEFAULT_SNAPSHOT_FILE,
  beyondPayrollId,
  diffSnapshot,
  renderDiff,
  takeSnapshot,
  type Snapshot,
} from "./lib/eh-diff.js";

// --- env -----------------------------------------------------------------

function loadDevVars(): void {
  try {
    const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/\r$/, "");
    }
  } catch {
    /* no .dev.vars - rely on the shell env */
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set (in .dev.vars or the shell)`);
  return v;
}

// --- args ----------------------------------------------------------------

const USAGE = "Usage: npm run eh-diff -- snapshot <EH employee id>... [--file <path>] [--force]\n       npm run eh-diff -- diff [--file <path>]";

function parseArgs(argv: string[]): { command: string; ids: number[]; file: string; force: boolean } {
  const [command, ...rest] = argv;
  if (command !== "snapshot" && command !== "diff") throw new Error(USAGE);
  let file = fileURLToPath(new URL(`../${DEFAULT_SNAPSHOT_FILE}`, import.meta.url));
  let force = false;
  const ids: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--file") file = rest[++i] ?? "";
    else if (a === "--force") force = true;
    else if (/^\d+$/.test(a)) ids.push(Number(a));
    else throw new Error(`Not an EH employee id: ${a}\n${USAGE}`);
  }
  if (!file) throw new Error(USAGE);
  if (command === "snapshot" && ids.length === 0) throw new Error(`Name at least one EH employee id.\n${USAGE}`);
  if (command === "diff" && ids.length > 0) throw new Error(`diff compares everyone in the snapshot; it takes no ids.\n${USAGE}`);
  return { command, ids: [...new Set(ids)], file, force };
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  const { command, ids, file, force } = parseArgs(process.argv.slice(2));
  loadDevVars();
  const businessId = need("EH_BUSINESS_ID");
  const eh = new EhPayrollClient({ apiKey: need("EH_API_KEY"), businessId });
  const get = (id: number) => eh.getEmployee(String(id));

  if (command === "snapshot") {
    if (existsSync(file) && !force) {
      throw new Error(`${file} already holds a snapshot. Run diff against it first, or pass --force to replace it.`);
    }
    const snapshot = await takeSnapshot(ids, get, businessId, new Date());
    // Full values (TFN, bank details): readable by this user only.
    writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    console.log(`Saved ${ids.length} EH employees to ${file}. It holds their full details: delete it once you're done.`);
    return;
  }

  if (!existsSync(file)) throw new Error(`No snapshot at ${file}. Take one first: npm run eh-diff -- snapshot <EH id>...`);
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  if (snapshot.businessId !== businessId) {
    throw new Error(`The snapshot is from EH business ${snapshot.businessId}, but EH_BUSINESS_ID is ${businessId}.`);
  }
  const diffs = await diffSnapshot(snapshot, get);
  console.log(renderDiff(diffs, snapshot));
  if (diffs.some(beyondPayrollId)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
