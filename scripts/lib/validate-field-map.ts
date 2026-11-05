/**
 * The wizard's field-map check (issue #56): validates a client's
 * field-map.json against the schema and lists only its problems, so the
 * human can loop "tune -> check -> tune" without the full test suite's output.
 */
import { fieldMapIssues } from "../../src/mapping/schema.js";

export type FieldMapCheck = { ok: true } | { ok: false; problems: string[] };

export function checkFieldMapText(text: string): FieldMapCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: [`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const problems = fieldMapIssues(json);
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** The `client` of clients/_example/field-map.json, the placeholder a fresh clone builds with. */
export const PLACEHOLDER_CLIENT = "example";

/**
 * Whether this map can go to the live Worker: present, valid, and the client's
 * own. The placeholder is a valid map, so the schema alone would let a deploy
 * ship its made-up field ids: the Worker would run and quietly sync nobody right.
 */
export function checkDeployableFieldMap(text: string | undefined): FieldMapCheck {
  const getIt = "Restore it from your backup, or rebuild it with `npm run discover` (RUNBOOK step 4).";
  if (text === undefined) return { ok: false, problems: ["The field map was not found.", getIt] };
  const check = checkFieldMapText(text);
  if (!check.ok) return check;
  if ((JSON.parse(text) as { client?: unknown }).client === PLACEHOLDER_CLIENT) {
    return { ok: false, problems: ["This is the placeholder a fresh clone builds with, not this client's field map.", getIt] };
  }
  return { ok: true };
}

export function renderFieldMapCheck(path: string, check: FieldMapCheck): string {
  if (check.ok) return `✓ ${path} is valid.`;
  const n = check.problems.length;
  return [`✗ ${path} has ${n} problem${n === 1 ? "" : "s"}:`, ...check.problems.map((p) => `    ${p}`)].join("\n");
}
