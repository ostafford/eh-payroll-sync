/**
 * `npm run deploy:config [-- --check-live] [-- --allow-database-change]`
 *
 * Writes `wrangler.deploy.json` - the config every deploy and remote D1 command
 * uses - from the `wrangler.jsonc` template plus this deployment's values in
 * `.dev.vars` (see scripts/lib/deploy-config.ts for why). `npm run deploy`,
 * `scripts/update.sh` and the setup wizard all run it first.
 *
 * Refuses (exit 1), changing nothing, when:
 *  - `.dev.vars` is missing the database id or a required var;
 *  - with --check-live: that database isn't on the Cloudflare account wrangler
 *    is logged in to (wrong account, or a stale id), the live Worker can't be
 *    read, or the deploy would point the live Worker at a different database.
 *    --allow-database-change permits the last one, for a deliberate move.
 * Settings the deploy would change on the live Worker are listed, not blocked:
 * changing one (a new alerts channel, say) is a normal reason to deploy.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  DEPLOY_CONFIG_PATH,
  DATABASE_ID_KEY,
  compareWithLive,
  parseDevVars,
  renderDeployConfig,
  type LiveBinding,
} from "./lib/deploy-config.js";

const checkLive = process.argv.includes("--check-live");
const allowDatabaseChange = process.argv.includes("--allow-database-change");

function stop(...lines: string[]): never {
  // A config that failed a check must not be left lying around to deploy by hand.
  rmSync(DEPLOY_CONFIG_PATH, { force: true });
  for (const l of lines) console.error(l);
  console.error("Nothing was deployed or changed.");
  process.exit(1);
}

function readText(path: string, missing: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    stop(missing);
  }
}

/** Runs wrangler; returns its output, or throws with stdout + stderr in the message. */
function wrangler(args: string[]): string {
  try {
    return execFileSync("npx", ["--yes", "wrangler", ...args, "--config", DEPLOY_CONFIG_PATH], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
}

function json<T>(text: string): T {
  const start = text.search(/[[{]/);
  return JSON.parse(text.slice(start)) as T;
}

const template = readText("wrangler.jsonc", "✗ wrangler.jsonc not found - run this from the eh-payroll-sync repo root.");
const devVars = parseDevVars(
  readText(".dev.vars", "✗ .dev.vars not found. The setup wizard creates it; or copy .dev.vars.example and fill it in."),
);

const rendered = renderDeployConfig(template, devVars);
if (!rendered.ok) {
  stop(
    "✗ .dev.vars is missing values this deployment needs:",
    ...rendered.missing.map((k) => `    ${k}`),
    `  Add each as KEY=value. ${DATABASE_ID_KEY} is the id \`npx wrangler d1 list\` shows for eh-payroll-sync.`,
  );
}
writeFileSync(DEPLOY_CONFIG_PATH, `${JSON.stringify(rendered.config, null, 2)}\n`);
console.log(`✓ ${DEPLOY_CONFIG_PATH} written (database ${rendered.databaseId}).`);

if (checkLive) {
  // 1. The database must exist on this account - catches the wrong account and a stale id.
  let databases: Array<{ uuid: string; name: string }>;
  try {
    databases = json(wrangler(["d1", "list", "--json"]));
  } catch (e) {
    stop("✗ Couldn't list this Cloudflare account's databases. Is wrangler logged in? (npx wrangler whoami)", String(e).trim());
  }
  if (!databases.some((d) => d.uuid === rendered.databaseId)) {
    stop(
      `✗ Database ${rendered.databaseId} (${DATABASE_ID_KEY} in .dev.vars) isn't on the Cloudflare account wrangler is logged in to.`,
      "  Either wrangler is logged in to the wrong account (npx wrangler whoami), or the id is out of date (npx wrangler d1 list).",
    );
  }

  // 2. Compare with the live Worker, if there is one yet.
  let versionId: string | undefined;
  try {
    const status = json<{ versions: Array<{ version_id: string; percentage: number }> }>(
      wrangler(["deployments", "status", "--json"]),
    );
    versionId = [...status.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
  } catch (e) {
    if (!/does not exist|\b10007\b/i.test(String(e))) {
      stop("✗ Couldn't read the live Worker's current deployment.", String(e).trim());
    }
    console.log("✓ No live Worker yet - this is its first deploy.");
  }

  if (versionId) {
    let bindings: LiveBinding[];
    try {
      const version = json<{ resources?: { bindings?: LiveBinding[] } }>(wrangler(["versions", "view", versionId, "--json"]));
      bindings = version.resources?.bindings ?? [];
    } catch (e) {
      stop("✗ Couldn't read the live Worker's settings.", String(e).trim());
    }
    const diff = compareWithLive(rendered, bindings);
    if (diff.databaseChange && !allowDatabaseChange) {
      stop(
        "✗ This deploy would point the live Worker at a different database:",
        `    live:  ${diff.databaseChange.live}`,
        `    .dev.vars: ${diff.databaseChange.next}`,
        "  If .dev.vars is out of date, set D1_DATABASE_ID to the live id. To move databases on purpose,",
        "  re-run with --allow-database-change.",
      );
    }
    console.log(`✓ Matches the live Worker's database${diff.databaseChange ? " (change allowed)" : ""}.`);
    if (diff.varChanges.length === 0) {
      console.log("✓ No settings change on the live Worker.");
    } else {
      console.log("! This deploy changes these settings on the live Worker:");
      for (const c of diff.varChanges) console.log(`    ${c.name}: "${c.live}" → "${c.next}"`);
    }
  }
}
