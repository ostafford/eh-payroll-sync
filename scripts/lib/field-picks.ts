/**
 * `clients/<client>/field-picks.json`: which Connecteam custom field the human
 * chose for each field the sync needs, by FieldSpec name and field ID (#112).
 * field-check, create-fields and discover read it before matching by name.
 *
 *   { "Claim tax-free threshold?": { "id": 43566219, "options": { "Yes, claim tax free threshold": "yes", "TBC": null } },
 *     "Title": { "skip": true }, "BSB": { "create": true } }
 *
 * `create` is a choice still waiting on create-fields, which replaces it with
 * the new field's ID.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldPicks } from "./field-resolve.js";
import { FIELD_SPEC, requiredForSync } from "./field-spec.js";

export const fieldPicksPath = (client: string): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "clients", client, "field-picks.json");

/** No file yet = no picks. A malformed file stops the run rather than being half-read. */
export function loadFieldPicks(path: string): FieldPicks {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected an object of { "<field>": { "id": <number> } }`);
  for (const [name, pick] of Object.entries(raw)) {
    const spec = FIELD_SPEC.find((s) => s.name === name);
    if (!spec) throw new Error(`${path}: "${name}" is not a field the sync needs`);
    if ((pick as any)?.create === true) continue;
    if ((pick as any)?.skip === true) {
      if (requiredForSync(spec)) throw new Error(`${path}: "${name}" is required, so it can't be skipped`);
      continue;
    }
    const id = (pick as any)?.id;
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${path}: "${name}" needs { "id": <Connecteam field id> }, { "skip": true } or { "create": true }`);
    const options = (pick as any).options;
    if (options === undefined) continue;
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`${path}: "${name}".options must be an object`);
    for (const [option, to] of Object.entries(options)) {
      if (to !== null && typeof to !== "string") throw new Error(`${path}: "${name}" option "${option}" must map to a value or null (not synced)`);
    }
  }
  return raw as FieldPicks;
}

export function saveFieldPicks(path: string, picks: FieldPicks): void {
  writeFileSync(path, `${JSON.stringify(picks, null, 2)}\n`);
}
