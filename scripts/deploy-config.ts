/**
 * `npm run deploy:config [-- --check-live] [-- --allow-database-change] [-- --allow-missing-secrets] [-- --put-baseline-key]`
 *
 * Writes `wrangler.deploy.json` - the config every deploy and remote D1 command
 * uses - from the `wrangler.jsonc` template plus this deployment's values in
 * `.dev.vars` (see scripts/lib/deploy-config.ts for why). `npm run deploy`,
 * `scripts/update.sh` and the setup wizard all run it first.
 *
 * Refuses (exit 1), changing nothing, when:
 *  - `.dev.vars` is missing the database id or a required var;
 *  - `clients/self/field-map.json` is missing, invalid, or still the placeholder
 *    `npm install` copies in (it is git-ignored, so it is never pulled);
 *  - with --check-live: that database isn't on the Cloudflare account wrangler
 *    is logged in to (wrong account, or a stale id), the live Worker can't be
 *    read, or the deploy would point the live Worker at a different database.
 *    --allow-database-change permits the last one, for a deliberate move;
 *  - with --check-live: the live Worker is missing a secret it needs
 *    (REQUIRED_SECRETS, names only). The built config is kept, so the secret
 *    can be put with it. --allow-missing-secrets skips this, for the setup
 *    wizard, which puts every secret itself just before it deploys.
 * With --put-baseline-key (update.sh): a live Worker missing only BASELINE_KEY
 * gets one, the one in `.dev.vars` or a new one kept there, instead of
 * refusing: a deployment from before linking has none (#172). One the Worker
 * already has is never replaced.
 * Settings the deploy would change on the live Worker are listed, not blocked:
 * changing one (a new alerts channel, say) is a normal reason to deploy.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  DEPLOY_CONFIG_PATH,
  DATABASE_ID_KEY,
  compareWithLive,
  missingSecrets,
  parseDevVars,
  planBaselineKey,
  renderDeployConfig,
  type LiveBinding,
} from "./lib/deploy-config.js";
import { checkDeployableFieldMap } from "./lib/validate-field-map.js";

const checkLive = process.argv.includes("--check-live");
const allowDatabaseChange = process.argv.includes("--allow-database-change");
const allowMissingSecrets = process.argv.includes("--allow-missing-secrets");
const putBaselineKey = process.argv.includes("--put-baseline-key");

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

/** Runs wrangler, with `input` on its stdin; returns its output, or throws with stdout + stderr in the message. */
function wrangler(args: string[], input?: string): string {
  try {
    return execFileSync("npx", ["--yes", "wrangler", ...args, "--config", DEPLOY_CONFIG_PATH], {
      encoding: "utf8",
      ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input, stdio: ["pipe", "pipe", "pipe"] }),
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
const FIELD_MAP_PATH = `clients/${rendered.vars.FIELD_MAP_CLIENT?.trim() || "self"}/field-map.json`;
let fieldMapText: string | undefined;
try {
  fieldMapText = readFileSync(FIELD_MAP_PATH, "utf8");
} catch {
  fieldMapText = undefined;
}
const fieldMap = checkDeployableFieldMap(fieldMapText);
if (!fieldMap.ok) stop(`✗ ${FIELD_MAP_PATH} can't be deployed:`, ...fieldMap.problems.map((p) => `    ${p}`));

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
    let missing = allowMissingSecrets ? [] : missingSecrets(bindings);
    if (putBaselineKey) {
      const plan = planBaselineKey(missing, devVars, () => randomBytes(32).toString("hex"));
      if (plan.action === "put") {
        if (plan.keepInDevVars) {
          const text = readFileSync(".dev.vars", "utf8");
          appendFileSync(".dev.vars", `${text.endsWith("\n") || text === "" ? "" : "\n"}BASELINE_KEY=${plan.key}\n`);
          console.log("✓ Made a BASELINE_KEY for linking and kept it in .dev.vars. Back up .dev.vars: a lost key re-baselines every Linked employee.");
        }
        try {
          wrangler(["secret", "put", "BASELINE_KEY"], plan.key);
        } catch (e) {
          console.error("✗ Couldn't put BASELINE_KEY on the live Worker.", String(e).trim());
          console.error("  Run this again: it reuses the key in .dev.vars. Nothing was deployed.");
          process.exit(1);
        }
        console.log(`✓ Put BASELINE_KEY on the live Worker (${plan.keepInDevVars ? "the new one" : "the one in .dev.vars"}).`);
        missing = missing.filter((k) => k !== "BASELINE_KEY");
      }
    }
    if (missing.length > 0) {
      // Kept, unlike stop(): the config is right, and putting the secret needs it.
      for (const l of [
        "✗ The live Worker is missing secrets it needs:",
        ...missing.map((k) => `    ${k}`),
        ...missing.map((k) => `  Put ${k}: ${putSecretHint(k, Boolean(devVars[k]?.trim()))}`),
        "  Then run this again. Nothing was deployed or changed.",
      ])
        console.error(l);
      process.exit(1);
    }
    if (!allowMissingSecrets) console.log("✓ The live Worker has every secret it needs.");
    if (diff.varChanges.length === 0) {
      console.log("✓ No settings change on the live Worker.");
    } else {
      console.log("! This deploy changes these settings on the live Worker:");
      for (const c of diff.varChanges) console.log(`    ${c.name}: "${c.live}" → "${c.next}"`);
    }
  }
}

/**
 * How to put one missing secret. BASELINE_KEY is the sync's own random key:
 * reuse the one in .dev.vars if it's there, otherwise make one and keep it there.
 */
function putSecretHint(name: string, inDevVars: boolean): string {
  const put = `npx wrangler secret put ${name} --config ${DEPLOY_CONFIG_PATH}`;
  if (name !== "BASELINE_KEY") return `printf %s "<value>" | ${put}`;
  if (inDevVars) return `grep '^BASELINE_KEY=' .dev.vars | tail -n1 | cut -d= -f2- | tr -d '\\n' | ${put}`;
  return (
    `key=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))') && ` +
    `echo "BASELINE_KEY=$key" >> .dev.vars && printf %s "$key" | ${put}` +
    ` (back up .dev.vars: a lost key re-baselines every Linked employee)`
  );
}
