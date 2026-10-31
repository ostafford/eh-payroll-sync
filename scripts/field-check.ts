/**
 * `npm run field-check`
 *
 * Checks the client's Connecteam custom fields against every field the sync
 * needs and prints a table grouped by area, with why + how to fix each problem
 * (issue #63). Also the wizard's "Connecteam field check" stage.
 *
 * Exit code: 0 = fine (warnings allowed), 2 = a required field is missing or the
 * wrong type (the wizard stops), 1 = the check itself failed.
 * Colour only on a terminal, and never with NO_COLOR set.
 *
 * `-- --fields-file <path>` checks saved field definitions instead, with the
 * picks from a `pick-fields -- --fields-file` rehearsal (no API key needed).
 *
 * Env (from .dev.vars or the shell): CT_API_KEY.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkFields, renderFieldCheck, summarise } from "./lib/field-check.js";
import { loadFieldPicks } from "./lib/field-picks.js";
import { fieldSource, rehearsalBanner } from "./lib/field-source.js";

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

// --- HTTP ------------------------------------------------------------------

async function ctGet(path: string): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    headers: { "X-API-KEY": process.env.CT_API_KEY!, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Connecteam GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  const source = fieldSource(process.argv);
  loadDevVars();
  if (source.fieldsFile) console.log(rehearsalBanner(source));
  else if (!process.env.CT_API_KEY) throw new Error("CT_API_KEY must be set (in .dev.vars or the shell)");

  const rows = checkFields(await source.load(ctGet), loadFieldPicks(source.picksPath));
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log(renderFieldCheck(rows, { color }));
  if (summarise(rows).blocking > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
