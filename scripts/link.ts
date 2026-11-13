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
 * Reads names, emails, Payroll IDs and status only: never a TFN or date of
 * birth. It first rebuilds wrangler.deploy.json and checks it against the
 * live Worker, if there is one yet (`npm run deploy:config -- --check-live
 * --allow-missing-secrets`: it needs the database, not the Worker's secrets),
 * so it never reads or writes a database other than the live one.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY, EH_BUSINESS_ID,
 * CT_ONBOARDING_PACK_ID, FIELD_MAP_CLIENT (optional).
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ConnecteamClient } from "../src/connecteam/client.js";
import { loadFieldMap } from "../src/mapping/loader.js";
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
const PENDING_SQL = "SELECT ct_user_id AS ctUserId, eh_employee_id AS ehEmployeeId FROM pending_link";
/** Each person's latest existing_match row: the Pre-create check's candidates (not their latest row of any kind). */
const HELD_SQL =
  "SELECT ct_user_id AS ctUserId, detail FROM sync_log WHERE id IN " +
  "(SELECT MAX(id) FROM sync_log WHERE outcome = 'existing_match' GROUP BY ct_user_id)";

// --- APIs ------------------------------------------------------------------

const EH_PAGE = 100;

async function listEhEmployees(businessId: string, apiKey: string): Promise<Record<string, unknown>[]> {
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const out: Record<string, unknown>[] = [];
  for (let skip = 0; ; skip += EH_PAGE) {
    const url = `https://api.yourpayroll.com.au/api/v2/business/${businessId}/employee/unstructured?$top=${EH_PAGE}&$skip=${skip}`;
    const r = await fetch(url, { headers: { authorization: auth, accept: "application/json" } });
    if (!r.ok) throw new Error(`Employment Hero employee list -> ${r.status} ${await r.text()}`);
    const page = (await r.json()) as Record<string, unknown>[];
    // Only what the link list reads, so nothing else (a TFN, a birth date) is kept.
    out.push(...page.map(({ id, firstName, surname, emailAddress, externalId, status }) => ({ id, firstName, surname, emailAddress, externalId, status })));
    if (page.length < EH_PAGE) return out;
  }
}

async function loadLive(): Promise<LinkStageData> {
  const ct = new ConnecteamClient({ apiKey: need("CT_API_KEY"), customPublisherId: 0 });
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
    pendingLinks: d1(PENDING_SQL) as LinkPendingRow[],
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
  });
  if (outcome === "cancelled" || outcome === "unconfirmed") process.exit(NOTHING_SAVED);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
