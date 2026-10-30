/**
 * `npm run create-fields [-- --dry-run]`
 *
 * Creates the Connecteam custom fields the sync needs that the account is
 * missing (issue #55), each with the right type, dropdown options and
 * permissions from ./lib/field-spec.ts. Also the wizard's "Connecteam custom
 * fields" stage.
 *
 * A field already present under the client's own name is left alone, so
 * re-running never creates a duplicate. It writes custom-field STRUCTURE only,
 * never an employee's answer.
 *
 * Attaching a field to the onboarding pack can't be done via the API, so it
 * finishes with the exact list of fields to attach in the Connecteam UI.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listCustomFieldDefinitions } from "./lib/connecteam-custom-fields.js";
import { planMissingFields } from "./lib/create-fields.js";
import { fieldPicksPath, loadFieldPicks, saveFieldPicks } from "./lib/field-picks.js";

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

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// --- HTTP ------------------------------------------------------------------

async function ctGet(path: string): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    headers: { "X-API-KEY": process.env.CT_API_KEY!, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Connecteam GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function ctPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    method: "POST",
    headers: {
      "X-API-KEY": process.env.CT_API_KEY!,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Connecteam POST ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  if (!process.env.CT_API_KEY) throw new Error("CT_API_KEY must be set (in .dev.vars or the shell)");
  const dryRun = flag("dry-run");

  const [fields, categories] = await Promise.all([
    listCustomFieldDefinitions(ctGet),
    ctGet("/users/v1/custom-field-categories").then((b) => (b?.data?.categories ?? []) as Array<{ id: number; name: string }>),
  ]);
  const picksPath = fieldPicksPath("self");
  const picks = loadFieldPicks(picksPath);
  const { found, missing, undecided, skipped } = planMissingFields(fields, categories, picks);

  console.log(
    `Connecteam already has ${found.length} of the ${found.length + missing.length + undecided.length} custom fields the sync needs` +
      (skipped.length ? ` (${skipped.length} skipped: ${skipped.map((s) => s.name).join(", ")}).` : "."),
  );
  for (const { spec, reason } of undecided) {
    const why = reason === "ambiguous" ? "more than one of your fields could be it" : "the field picked for it was deleted";
    console.log(`  ? ${spec.name.padEnd(38)} not created: ${why} (see the field check)`);
  }
  if (missing.length === 0) {
    console.log("Nothing to create.");
    return;
  }

  console.log(`${dryRun ? "Would create" : "Creating"} ${missing.length}:`);
  for (const { spec, body, categoryNote } of missing) {
    const options = body.dropdownOptions ? `: ${body.dropdownOptions.map((o) => o.value).join(" / ")}` : "";
    const who = spec.ct.isEditableForUsers ? "employee fills in" : "admin fills in";
    console.log(`  - ${spec.name.padEnd(38)} ${spec.ct.type}${options}  (${spec.group}; ${who})${categoryNote ? `  [${categoryNote}]` : ""}`);
  }
  if (dryRun) {
    console.log("--dry-run: nothing created.");
    return;
  }

  // One at a time, so a failure names the field and the rest are reported.
  const created: string[] = [];
  for (const { spec, body } of missing) {
    try {
      const res = await ctPost("/users/v1/custom-fields", { customFields: [body] });
      const id = res?.data?.customFields?.[0]?.id;
      console.log(`  + created "${spec.name}" (id ${id ?? "?"})`);
      created.push(spec.name);
      // Picked as "create": point the pick at the new field, so it's found by ID from now on.
      if (spec.name in picks && Number.isInteger(id)) {
        picks[spec.name] = { id };
        saveFieldPicks(picksPath, picks);
      }
    } catch (err) {
      console.error(`  ! could not create "${spec.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (created.length) {
    console.log(`\nAttach these ${created.length} new field(s) to your onboarding pack in Connecteam`);
    console.log("(this can't be done through the API):");
    for (const name of created) console.log(`  [ ] ${name}`);
  }
  if (created.length < missing.length) {
    throw new Error(`${missing.length - created.length} field(s) could not be created - see above. Re-running is safe.`);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
