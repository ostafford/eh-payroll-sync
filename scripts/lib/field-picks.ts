/**
 * `clients/<client>/field-picks.json`: which Connecteam custom field the human
 * chose for each field the sync needs, by FieldSpec name and field ID (#112).
 * field-check, create-fields and discover read it before matching by name.
 *
 *   { "Claim tax-free threshold?": { "id": 43566219 } }
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldPicks } from "./field-resolve.js";
import { FIELD_SPEC } from "./field-spec.js";

export const fieldPicksPath = (client: string): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "clients", client, "field-picks.json");

/** No file yet = no picks. A malformed file stops the run rather than being half-read. */
export function loadFieldPicks(path: string): FieldPicks {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected an object of { "<field>": { "id": <number> } }`);
  for (const [name, pick] of Object.entries(raw)) {
    if (!FIELD_SPEC.some((s) => s.name === name)) throw new Error(`${path}: "${name}" is not a field the sync needs`);
    const id = (pick as any)?.id;
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${path}: "${name}" needs { "id": <Connecteam field id> }`);
  }
  return raw as FieldPicks;
}
