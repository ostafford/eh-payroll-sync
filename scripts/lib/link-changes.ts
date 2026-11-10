/**
 * What the link stage writes on confirm (#154): the `pending_link` rows to add
 * or change, and the ones to take off the Link list. Pure - the caller runs the
 * SQL through the built config.
 */
import type { LinkPendingRow } from "./link-list.js";

/**
 * The admin's decision for one row shown on the screen: on the Link list (a
 * null `ehEmployeeId` is "New hire, not this person"), or off it.
 */
export type LinkDecision =
  | { ctUserId: number; onList: true; ehEmployeeId: string | null }
  | { ctUserId: number; onList: false };

export interface LinkChanges {
  upsert: LinkPendingRow[];
  /** Connecteam user ids whose `pending_link` row goes. */
  remove: number[];
}

export function linkChanges(existing: readonly LinkPendingRow[], decisions: readonly LinkDecision[]): LinkChanges {
  const now = new Map(existing.map((p) => [p.ctUserId, p.ehEmployeeId]));
  const upsert: LinkPendingRow[] = [];
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
    const values = changes.upsert.map((r) => `(${r.ctUserId}, ${sqlText(r.ehEmployeeId)}, ${confirmedAt})`).join(", ");
    statements.push(
      `INSERT INTO pending_link (ct_user_id, eh_employee_id, confirmed_at) VALUES ${values} ` +
        "ON CONFLICT(ct_user_id) DO UPDATE SET eh_employee_id = excluded.eh_employee_id, confirmed_at = excluded.confirmed_at;",
    );
  }
  if (changes.remove.length) statements.push(`DELETE FROM pending_link WHERE ct_user_id IN (${changes.remove.join(", ")});`);
  return statements.length ? statements.join("\n") : null;
}
