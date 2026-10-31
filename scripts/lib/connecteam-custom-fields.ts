/**
 * Connecteam custom-field DEFINITIONS (id, name, type) for the whole account,
 * independent of whether any employee has answered them yet.
 */
import { readFileSync } from "node:fs";

export interface CustomFieldDefinition {
  customFieldId: number;
  name: string;
  type: string;
}

export type CtGet = (path: string) => Promise<any>;

/**
 * `GET /users/v1/custom-fields` is paginated (default page size 10, no
 * single-field-by-id endpoint exists) - page through it until a short page.
 */
export async function listRawCustomFields(ctGet: CtGet): Promise<any[]> {
  const PAGE = 50;
  let offset = 0;
  const all: any[] = [];
  for (;;) {
    const page = (await ctGet(`/users/v1/custom-fields?limit=${PAGE}&offset=${offset}`))?.data?.customFields ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function listCustomFieldDefinitions(ctGet: CtGet): Promise<CustomFieldDefinition[]> {
  return (await listRawCustomFields(ctGet)).map((f) => ({
    customFieldId: f.id,
    name: String(f.name ?? ""),
    type: String(f.type ?? ""),
  }));
}

/**
 * The same rows from a saved file instead of the API, for rehearsing the field
 * picker without an account (#112), e.g. test/fixtures/first-client-fields.json.
 * Takes a bare array, `{ customFields }` or the API's own `{ data: { customFields } }`.
 */
export function readFieldsFile(path: string): any[] {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(doc) ? doc : (doc?.customFields ?? doc?.data?.customFields);
  if (!Array.isArray(rows)) throw new Error(`${path}: expected an array of custom fields, { customFields } or { data: { customFields } }`);
  return rows;
}
