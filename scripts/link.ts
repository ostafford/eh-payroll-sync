/**
 * `npm run link`
 *
 * The wizard's link stage (#154): one full-screen list of every active
 * Connecteam user not yet synced, matched against Employment Hero, where the
 * admin confirms who is which Pre-existing employee. On confirm it writes the
 * changed `pending_link` rows through the built config (`wrangler d1 execute`).
 * No file is written: names and emails stay on screen.
 *
 * Needs a terminal (it reads single keys). Not in one, it prints the list and
 * writes nothing. Colour only on a terminal, and never with NO_COLOR set.
 *
 * `-- --data-file <path>` rehearses against saved data (the stage's input,
 * e.g. test/fixtures/link-stage-data.json): no API key, no network, and
 * nothing written.
 *
 * `-- --before-deploy` is the wizard's first-setup run (ADR-0012): an empty
 * Link list goes through only once the admin confirms nobody is already in EH.
 *
 * Exits 3 when nothing was saved (cancelled, not confirmed, or no terminal),
 * so the wizard stops before the deploy.
 *
 * On confirm it also takes each pair's Baseline (#230): the details that
 * differ between Connecteam and EH are listed by name, and the admin picks
 * Use Connecteam's for any that should be sent at the link (the rest keep
 * EH's). Packs and EH records, TFN and date of birth included, are compared
 * in memory only: nothing is printed or written but names and fingerprints.
 *
 * It first rebuilds wrangler.deploy.json and checks it against the
 * live Worker, if there is one yet (`npm run deploy:config -- --check-live
 * --allow-missing-secrets`: it needs the database, not the Worker's secrets),
 * so it never reads or writes a database other than the live one.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY, EH_BUSINESS_ID,
 * CT_ONBOARDING_PACK_ID, BASELINE_KEY, FIELD_MAP_CLIENT (optional). A
 * rehearsal without BASELINE_KEY takes no Baselines.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ConnecteamClient } from "../src/connecteam/client.js";
import { EhPayrollClient } from "../src/eh/client.js";
import { loadFieldMap } from "../src/mapping/loader.js";
import { baselineKeyId } from "../src/sync/baseline.js";
import type { DifferingDetail } from "./lib/link-details.js";
import type { LinkStageData, LinkStageMapRow } from "./lib/link-input.js";
import { linkListInput } from "./lib/link-input.js";
import { buildLinkList, type LinkPendingRow } from "./lib/link-list.js";
import { createLinkScreen, linkScreenPeople } from "./lib/link-screen.js";
import { driveLinkScreen } from "./lib/link-terminal.js";
import { runLinkStage } from "./lib/link-stage.js";
import { checkDeployConfig, d1 } from "./lib/remote-d1.js";

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

// --- D1, through the built config ------------------------------------------

const MAP_SQL = "SELECT ct_user_id AS ctUserId, eh_employee_id AS ehEmployeeId, last_outcome AS lastOutcome, external_id AS externalId FROM employee_map";
/** A stored Baseline's key id only: a pair counts as having one only under this BASELINE_KEY (#230). */
const PENDING_SQL =
  "SELECT ct_user_id AS ctUserId, eh_employee_id AS ehEmployeeId, json_extract(baseline, '$.keyId') AS baselineKeyId FROM pending_link";
/** Each person's latest existing_match row: the Pre-create check's candidates (not their latest row of any kind). */
const HELD_SQL =
  "SELECT ct_user_id AS ctUserId, detail FROM sync_log WHERE id IN " +
  "(SELECT MAX(id) FROM sync_log WHERE outcome = 'existing_match' GROUP BY ct_user_id)";

/** The `pending_link` rows; one whose Baseline was made under another BASELINE_KEY counts as having none, so this run takes it again. */
async function pendingLinks(): Promise<LinkPendingRow[]> {
  const keyId = process.env.BASELINE_KEY ? await baselineKeyId(process.env.BASELINE_KEY) : null;
  return (d1(PENDING_SQL) as Array<{ ctUserId: number; ehEmployeeId: string | null; baselineKeyId: string | null }>).map(
    ({ baselineKeyId: stored, ...p }) => ({ ...p, hasBaseline: stored !== null && stored === keyId }),
  );
}

// --- APIs ------------------------------------------------------------------

async function listEhEmployees(businessId: string, apiKey: string): Promise<Record<string, unknown>[]> {
  const list = await new EhPayrollClient({ businessId, apiKey }).listEmployees();
  // Status only: a response body can echo an employee's details back.
  if (list.outcome !== "ok") throw new Error(`Employment Hero employee list -> ${list.status === null ? "no response" : `HTTP ${list.status}`}`);
  // Whole records, in memory only: the Baseline step compares them with each
  // pack (#230). Nothing from them is printed or written but field names.
  return list.data;
}

async function loadLive(): Promise<LinkStageData> {
  const ct = new ConnecteamClient({ apiKey: need("CT_API_KEY") });
  process.stderr.write("Reading Connecteam users, Employment Hero employees and the sync's records...\n");
  const users = await ct.listUsers();
  if (users.outcome !== "ok") throw new Error(`Connecteam users -> ${users.status} ${users.detail}`);
  const assignments = await ct.listAssignments(Number(need("CT_ONBOARDING_PACK_ID")));
  if (assignments.outcome !== "ok") throw new Error(`Connecteam onboarding assignments -> ${assignments.status} ${assignments.detail}`);
  return {
    ctUsers: users.data,
    ehEmployees: await listEhEmployees(need("EH_BUSINESS_ID"), need("EH_API_KEY")),
    assignments: assignments.data,
    employeeMap: (d1(MAP_SQL) as LinkStageMapRow[]).map((m) => ({ ...m, ehEmployeeId: m.ehEmployeeId === null ? null : String(m.ehEmployeeId) })),
    pendingLinks: await pendingLinks(),
    heldDetails: d1(HELD_SQL) as LinkStageData["heldDetails"],
    payrollIdFrom: loadFieldMap(process.env.FIELD_MAP_CLIENT).identity.externalIdFrom,
  };
}

// --- main --------------------------------------------------------------

function dataFile(argv: string[]): string | undefined {
  const i = argv.indexOf("--data-file");
  return i === -1 ? undefined : argv[i + 1];
}

/** Exit code for "nothing saved": the wizard stops before the deploy. */
const NOTHING_SAVED = 3;

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`\n${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * The plain Details list (#230; the Edit pop-up replaces it): one person's
 * differing details by name, each keeping EH's unless picked. Returns the
 * units to take from Connecteam.
 */
async function chooseDetails(person: string, details: readonly DifferingDetail[]): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${person}: these details differ between Connecteam and Employment Hero.`);
    details.forEach((d, i) => {
      const fields = d.fields.length === 1 && d.fields[0] === d.label ? "" : ` (${d.fields.join(", ")} differ${d.fields.length === 1 ? "s" : ""}: the whole ${d.label.toLowerCase()} is sent)`;
      console.log(`  ${i + 1}. ${d.label}${fields}`);
    });
    for (;;) {
      const answer = (await rl.question("Each keeps EH's unless picked. Use Connecteam's for which? (numbers, e.g. 1 3; Enter for none) ")).trim();
      const picks = answer === "" ? [] : answer.split(/[\s,]+/).map(Number);
      if (picks.every((n) => Number.isInteger(n) && n >= 1 && n <= details.length)) return [...new Set(picks)].map((n) => details[n - 1]!.unit);
      console.log(`  Type numbers from 1 to ${details.length}, or press Enter to keep EH's for all.`);
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  loadDevVars();
  const file = dataFile(process.argv);
  if (!file) checkDeployConfig(["--allow-missing-secrets"]);
  const load = async (): Promise<LinkStageData> => (file ? (JSON.parse(readFileSync(file, "utf8")) as LinkStageData) : loadLive());

  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    const input = linkListInput(await load());
    const screen = createLinkScreen(buildLinkList(input), linkScreenPeople(input));
    console.log(screen.table({ columns: 160, color: false }).join("\n"));
    console.error("\nThe link stage needs a terminal (it reads single keys): nothing was saved.");
    process.exit(NOTHING_SAVED);
  }

  const outcome = await runLinkStage({
    load,
    drive: (screen) => driveLinkScreen(screen, { stdin: process.stdin, stdout: process.stdout, color: !process.env.NO_COLOR }),
    execute: async (sql) => void d1(sql),
    print: (line) => console.log(line),
    now: () => Date.now(),
    rehearsal: file !== undefined,
    ...(process.argv.includes("--before-deploy") ? { beforeDeploy: { confirm } } : {}),
    // Live, a missing key stops here; a rehearsal without one takes no Baselines.
    ...(file && !process.env.BASELINE_KEY
      ? {}
      : { baseline: { secret: need("BASELINE_KEY"), fieldMap: loadFieldMap(process.env.FIELD_MAP_CLIENT) }, chooseDetails }),
  });
  if (outcome === "cancelled" || outcome === "unconfirmed") process.exit(NOTHING_SAVED);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
