/**
 * `npm run pick-fields`
 *
 * The wizard's field picker (issue #112): shows which of the client's
 * Connecteam custom fields was matched to each field the sync needs, lets the
 * human confirm, pick another, create one or skip, and saves the choices to
 * clients/self/field-picks.json. Fields already picked aren't asked again.
 *
 * Reads field DEFINITIONS only, never an employee's answer, and changes
 * nothing in Connecteam ("create" is done by create-fields, next stage).
 *
 * `-- --fields-file <path>` rehearses against saved field definitions instead
 * (e.g. test/fixtures/first-client-fields.json): no API key, nothing sent, and
 * the choices go to a scratch file, not clients/self.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { loadFieldPicks, saveFieldPicks } from "./lib/field-picks.js";
import { fieldSource, rehearsalBanner } from "./lib/field-source.js";
import { runFieldPicker } from "./lib/field-picker.js";

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

// --- prompts -------------------------------------------------------------

// Read lines through the async iterator: it buffers, so answers typed (or
// piped) ahead of a prompt aren't lost the way `rl.question` loses them.
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const next = await lines.next();
  if (next.done) throw new Error("input ended before every question was answered");
  return next.value;
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  const source = fieldSource(process.argv);
  loadDevVars();
  if (source.fieldsFile) console.log(rehearsalBanner(source));
  else if (!process.env.CT_API_KEY) throw new Error("CT_API_KEY must be set (in .dev.vars or the shell)");

  const path = source.picksPath;
  const before = loadFieldPicks(path);
  const picks = await runFieldPicker(await source.load(ctGet), before, {
    ask,
    print: (...out) => out.forEach((l) => console.log(l)),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  });
  rl.close();

  const changed = Object.keys(picks).filter((k) => JSON.stringify(picks[k]) !== JSON.stringify(before[k])).length;
  if (changed) saveFieldPicks(path, picks);
  console.log(changed ? `\nSaved ${changed} choice(s) to ${path}.` : "\nNothing new to save: every field is already decided.");
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
