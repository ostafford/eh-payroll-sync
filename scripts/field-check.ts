/**
 * `npm run field-check`
 *
 * The wizard's "Connecteam field check" stage (#63, #112): one table of every
 * field the sync needs, the client's Connecteam field for it and a status,
 * grouped by area. In a terminal it then lets you fix each problem, or change
 * any row by number (pick another field, create one, skip it, map dropdown
 * options), and saves the choices to clients/self/field-picks.json.
 *
 * Not in a terminal, or with `-- --check-only`, it prints the table with why +
 * how to fix each problem, and asks nothing.
 *
 * Exit code: 0 = fine (warnings allowed), 2 = a required field is missing, the
 * wrong type or still to be created (the wizard stops), 1 = the check failed.
 * Colour only on a terminal, and never with NO_COLOR set.
 *
 * `-- --fields-file <path>` rehearses against saved field definitions instead
 * (e.g. test/fixtures/first-client-fields.json): no API key, nothing sent, and
 * the choices go to a scratch file, not clients/self.
 *
 * Reads field DEFINITIONS only, never an employee's answer, and changes nothing
 * in Connecteam ("create" is done by create-fields, the wizard's next step).
 *
 * Env (from .dev.vars or the shell): CT_API_KEY.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkFields, renderFieldCheck } from "./lib/field-check.js";
import { reviewFields } from "./lib/field-picker.js";
import { loadFieldPicks, saveFieldPicks } from "./lib/field-picks.js";
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

// --- prompts -------------------------------------------------------------

async function interactive(raw: any[], path: string, color: boolean): Promise<ReturnType<typeof checkFields>> {
  // Read lines through the async iterator: it buffers, so answers typed (or
  // piped) ahead of a prompt aren't lost the way `rl.question` loses them.
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const before = loadFieldPicks(path);
  const picks = await reviewFields(raw, before, {
    ask: async (prompt) => {
      process.stdout.write(prompt);
      const next = await lines.next();
      if (next.done) throw new Error("input ended before every question was answered");
      return next.value;
    },
    print: (...out) => out.forEach((l) => console.log(l)),
    color,
  });
  rl.close();

  const changed = Object.keys(picks).filter((k) => JSON.stringify(picks[k]) !== JSON.stringify(before[k])).length;
  if (changed) saveFieldPicks(path, picks);
  console.log(changed ? `\nSaved ${changed} choice(s) to ${path}.` : "\nNothing new to save.");
  return checkFields(raw, picks);
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  const source = fieldSource(process.argv);
  loadDevVars();
  if (source.fieldsFile) console.log(rehearsalBanner(source));
  else if (!process.env.CT_API_KEY) throw new Error("CT_API_KEY must be set (in .dev.vars or the shell)");

  const raw = await source.load(ctGet);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const ask = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.argv.includes("--check-only");
  const rows = ask
    ? await interactive(raw, source.picksPath, color)
    : checkFields(raw, loadFieldPicks(source.picksPath));
  if (!ask) console.log(renderFieldCheck(rows, { color }));
  if (rows.some((r) => r.blocking)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
