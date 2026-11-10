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
 * Reads names, emails, Payroll IDs and status only: never a TFN or date of
 * birth. Run it after the deploy, with wrangler.deploy.json built
 * (`npm run deploy:config`).
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY, EH_BUSINESS_ID,
 * CT_ONBOARDING_PACK_ID, FIELD_MAP_CLIENT (optional).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { ConnecteamClient } from "../src/connecteam/client.js";
import { loadFieldMap } from "../src/mapping/loader.js";
import { DEPLOY_CONFIG_PATH } from "./lib/deploy-config.js";
import type { LinkStageData, LinkStageMapRow } from "./lib/link-input.js";
import { linkListInput } from "./lib/link-input.js";
import { buildLinkList, type LinkPendingRow } from "./lib/link-list.js";
import { createLinkScreen, type LinkScreen } from "./lib/link-screen.js";
import { runLinkStage } from "./lib/link-stage.js";

const DATABASE = "eh-payroll-sync";

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

function d1(sql: string): unknown[] {
  let out: string;
  try {
    out = execFileSync(
      "npx",
      ["--yes", "wrangler", "d1", "execute", DATABASE, "--remote", "--json", "--command", sql, "--config", DEPLOY_CONFIG_PATH],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`wrangler d1 execute failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
  const results = JSON.parse(out.slice(out.search(/[[{]/))) as Array<{ results?: unknown[] }>;
  return results.flatMap((r) => r.results ?? []);
}

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

// --- the terminal ----------------------------------------------------------

/** Runs the screen full-screen, in the alternate screen, until the admin saves or cancels. */
function drive(screen: LinkScreen): Promise<"save" | "cancel"> {
  const color = !process.env.NO_COLOR;
  const draw = () =>
    process.stdout.write(
      "\u001b[H\u001b[2J" + screen.render({ columns: process.stdout.columns || 100, rows: process.stdout.rows || 30, color }).join("\n"),
    );
  process.stdout.write("\u001b[?1049h\u001b[?25l"); // alternate screen, hide cursor
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
      const done = screen.press(str, key);
      if (!done) return draw();
      process.stdin.off("keypress", onKey);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\u001b[?25h\u001b[?1049l");
      resolve(done);
    };
    process.stdin.on("keypress", onKey);
    process.stdout.on("resize", draw);
    draw();
  });
}

// --- main --------------------------------------------------------------

function dataFile(argv: string[]): string | undefined {
  const i = argv.indexOf("--data-file");
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<void> {
  loadDevVars();
  const file = dataFile(process.argv);
  const load = async (): Promise<LinkStageData> => (file ? (JSON.parse(readFileSync(file, "utf8")) as LinkStageData) : loadLive());

  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    const input = linkListInput(await load());
    const screen = createLinkScreen(buildLinkList(input), {
      ct: new Map(input.ctUsers.map((u) => [u.ctUserId, u])),
      eh: new Map(input.ehEmployees.map((e) => [e.id, e])),
    });
    console.log(screen.table({ columns: 160, color: false }).join("\n"));
    console.error("\nThe link stage needs a terminal (it reads single keys): nothing was saved.");
    return;
  }

  await runLinkStage({
    load,
    drive,
    execute: async (sql) => {
      if (file) console.log(`Rehearsal: nothing written. The stage would run:\n${sql}`);
      else d1(sql);
    },
    print: (line) => console.log(line),
    now: () => Date.now(),
  });
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
