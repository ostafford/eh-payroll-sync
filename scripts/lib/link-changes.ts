/**
 * What the link stage writes on confirm (#154): the `pending_link` rows to add
 * or change, and the ones to take off the Link list. Pure - the caller runs the
 * SQL through the built config.
 */
import type { Baseline } from "../../src/sync/gateway.js";
import type { LinkPendingRow } from "./link-list.js";

/** A row to add or change, with the Baseline taken at confirmation (#230) once the stage takes one. */
export interface LinkUpsert {
  ctUserId: number;
  ehEmployeeId: string | null;
  /** Null for "New hire, not this person". Absent when the stage takes no Baseline: the column isn't written. */
  baseline?: Baseline | null;
}

/**
 * The admin's decision for one row shown on the screen: on the Link list (a
 * null `ehEmployeeId` is "New hire, not this person"), or off it.
 */
export type LinkDecision =
  | { ctUserId: number; onList: true; ehEmployeeId: string | null }
  | { ctUserId: number; onList: false };

export interface LinkChanges {
  upsert: LinkUpsert[];
  /** Connecteam user ids whose `pending_link` row goes. */
  remove: number[];
}

export function linkChanges(existing: readonly LinkPendingRow[], decisions: readonly LinkDecision[]): LinkChanges {
  const now = new Map(existing.map((p) => [p.ctUserId, p.ehEmployeeId]));
  const upsert: LinkUpsert[] = [];
  const remove: number[] = [];
  for (const d of decisions) {
    if (!d.onList) {
      if (now.has(d.ctUserId)) remove.push(d.ctUserId);
      continue;
    }
    // `has` first: a stored null ("New hire, not this person") is still a row.
    if (now.has(d.ctUserId) && now.get(d.ctUserId) === d.ehEmployeeId) continue;
    upsert.push({ ctUserId: d.ctUserId, ehEmployeeId: d.ehEmployeeId });
  }
  return { upsert, remove };
}

const sqlText = (s: string | null): string => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

/** The SQL for `wrangler d1 execute`, or null when there's nothing to write. */
export function pendingLinkSql(changes: LinkChanges, confirmedAt: number): string | null {
  const statements: string[] = [];
  if (changes.upsert.length) {
    const withBaseline = changes.upsert.some((r) => r.baseline !== undefined);
    const values = changes.upsert
      .map((r) => {
        const baseline = withBaseline ? `, ${sqlText(r.baseline ? JSON.stringify(r.baseline) : null)}` : "";
        return `(${r.ctUserId}, ${sqlText(r.ehEmployeeId)}, ${confirmedAt}${baseline})`;
      })
      .join(", ");
    statements.push(
      withBaseline
        ? `INSERT INTO pending_link (ct_user_id, eh_employee_id, confirmed_at, baseline) VALUES ${values} ` +
            "ON CONFLICT(ct_user_id) DO UPDATE SET eh_employee_id = excluded.eh_employee_id, confirmed_at = excluded.confirmed_at, baseline = excluded.baseline;"
        : `INSERT INTO pending_link (ct_user_id, eh_employee_id, confirmed_at) VALUES ${values} ` +
            "ON CONFLICT(ct_user_id) DO UPDATE SET eh_employee_id = excluded.eh_employee_id, confirmed_at = excluded.confirmed_at;",
    );
  }
  if (changes.remove.length) statements.push(`DELETE FROM pending_link WHERE ct_user_id IN (${changes.remove.join(", ")});`);
  return statements.length ? statements.join("\n") : null;
}
