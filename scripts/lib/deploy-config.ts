/**
 * Builds the config a deploy actually uses: the tracked `wrangler.jsonc`
 * template plus this deployment's own values from the git-ignored `.dev.vars`.
 *
 * Why: the per-deployment values (database id, business / pack / publisher /
 * channel ids) used to be written into the tracked `wrangler.jsonc`, where any
 * branch switch, discard or pull quietly put the template's blanks back - and
 * a plain `wrangler deploy` then pushed those blanks and a dead database id to
 * the live Worker. Keeping them in a file git ignores, and building the deploy
 * config fresh from the current template each time, removes both problems.
 *
 * Pure: no file or network access, so it is tested directly.
 */

/** The output file. Git-ignored; regenerated on every deploy. */
export const DEPLOY_CONFIG_PATH = "wrangler.deploy.json";

/** The `.dev.vars` key holding this deployment's D1 database id. */
export const DATABASE_ID_KEY = "D1_DATABASE_ID";

/** The template's stand-in for the database id: not a real id, so a raw deploy fails before it changes anything. */
export const DATABASE_ID_PLACEHOLDER = "set-D1_DATABASE_ID-in-.dev.vars";

/** Vars a Worker can't run without: a blank one deploys fine and then silently does nothing. */
export const REQUIRED_VARS = [
  "EH_BUSINESS_ID",
  "CT_ONBOARDING_PACK_ID",
  "CT_CUSTOM_PUBLISHER_ID",
  "ADMIN_CONNECTEAM_CHANNEL_ID",
] as const;

/** Removes `//` and block comments and trailing commas, leaving string contents alone. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** `KEY=VALUE` lines; `#` comments and blank lines skipped, surrounding quotes removed. */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

interface WranglerConfig {
  vars?: Record<string, string>;
  d1_databases?: Array<{ binding: string; database_id: string }>;
  [key: string]: unknown;
}

export type RenderResult =
  | { ok: true; config: WranglerConfig; databaseId: string; vars: Record<string, string> }
  | { ok: false; missing: string[] };

/** The database id `.dev.vars` names, or undefined while it's blank or still the placeholder. */
export function databaseIdOf(devVars: Record<string, string>): string | undefined {
  const id = devVars[DATABASE_ID_KEY]?.trim() ?? "";
  return id && id !== DATABASE_ID_PLACEHOLDER ? id : undefined;
}

/**
 * The template with this deployment's values filled in. Every template var
 * with a value in `.dev.vars` takes it; the rest keep the template's value.
 * Fails, naming each one, when the database id or a required var is blank.
 */
export function renderDeployConfig(templateText: string, devVars: Record<string, string>): RenderResult {
  const config = JSON.parse(stripJsonc(templateText)) as WranglerConfig;
  const vars = { ...(config.vars ?? {}) };
  for (const key of Object.keys(vars)) {
    const value = devVars[key]?.trim();
    if (value) vars[key] = value;
  }
  const databaseId = databaseIdOf(devVars);
  const db = config.d1_databases?.find((d) => d.binding === "DB");

  const missing: string[] = [];
  if (!databaseId) missing.push(DATABASE_ID_KEY);
  if (!db) missing.push("a DB entry in wrangler.jsonc d1_databases");
  for (const key of REQUIRED_VARS) if (!vars[key]?.trim()) missing.push(key);
  // `!databaseId` is already in `missing`; repeated so TypeScript knows it's set below.
  if (missing.length > 0 || !databaseId) return { ok: false, missing };

  db!.database_id = databaseId;
  return { ok: true, config: { ...config, vars }, databaseId, vars };
}

/**
 * Secrets a live Worker can't run without. Only their names are checked (never
 * values): `wrangler secret put` adds one to the live Worker, so a deploy that
 * finds one missing would go live without it. `BASELINE_KEY` is the one an
 * existing deployment is missing after an update that adds linking (ADR-0009).
 */
export const REQUIRED_SECRETS = ["CT_API_KEY", "EH_API_KEY", "CT_WEBHOOK_SECRET", "BASELINE_KEY"] as const;

/** The required secrets the live Worker doesn't have, in {@link REQUIRED_SECRETS} order. */
export function missingSecrets(live: readonly LiveBinding[]): string[] {
  const present = new Set(live.filter((b) => b.type === "secret_text").map((b) => b.name));
  return REQUIRED_SECRETS.filter((name) => !present.has(name));
}

/**
 * What `--put-baseline-key` (update.sh, #172) does about `BASELINE_KEY`.
 * Only a live Worker without one gets one: replacing a key it has would
 * re-baseline every Linked employee (ADR-0009). The one in `.dev.vars` is
 * reused when it's there; otherwise a new one is made, to keep in `.dev.vars`
 * before it's put, so a failed put is retried with the same key.
 */
export type BaselineKeyPlan = { action: "none" } | { action: "put"; key: string; keepInDevVars: boolean };

export function planBaselineKey(
  missing: readonly string[],
  devVars: Record<string, string>,
  newKey: () => string,
): BaselineKeyPlan {
  if (!missing.includes("BASELINE_KEY")) return { action: "none" };
  const kept = devVars.BASELINE_KEY?.trim();
  return kept ? { action: "put", key: kept, keepInDevVars: false } : { action: "put", key: newKey(), keepInDevVars: true };
}

/** One binding as `wrangler versions view --json` lists it. */
export interface LiveBinding {
  name: string;
  type: string;
  text?: string;
  database_id?: string;
}

export interface LiveComparison {
  /** Set when the deploy would point the Worker at a different database. */
  databaseChange: { live: string; next: string } | null;
  /** Plain-text vars whose value the deploy would change. */
  varChanges: Array<{ name: string; live: string; next: string }>;
}

/** What a deploy of `rendered` would change on the live Worker (secrets are never compared). */
export function compareWithLive(
  rendered: { databaseId: string; vars: Record<string, string> },
  live: readonly LiveBinding[],
): LiveComparison {
  const liveDb = live.find((b) => b.type === "d1" && b.name === "DB")?.database_id;
  const liveVars = new Map(live.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text ?? ""]));
  const varChanges = Object.entries(rendered.vars)
    .filter(([name, next]) => (liveVars.get(name) ?? "") !== next)
    .map(([name, next]) => ({ name, live: liveVars.get(name) ?? "", next }));
  return {
    databaseChange: liveDb && liveDb !== rendered.databaseId ? { live: liveDb, next: rendered.databaseId } : null,
    varChanges,
  };
}
