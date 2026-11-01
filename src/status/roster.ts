/**
 * Pure derivation of the sync-status roster (issue #44). Turns one joined row
 * (an `employee_map` record plus that person's latest `sync_log` row) into one
 * of four states an admin can act on:
 *
 *   - ready               EH reports the record Complete (our last decision was `ok`,
 *                          or the daily recheck pass, #43, found it resolved).
 *   - waiting_on_employee  the employee has an open Correction cycle.
 *   - waiting_on_admin     synced with safe defaults but EH still needs manual admin
 *                          setup (pay-run defaults, non-resident tax scale, SMSF, ...).
 *   - broken               a job for this person dead-lettered, or their sync landed
 *                          on an EH employee id already linked to a different
 *                          Connecteam user (an identity collision - see
 *                          SyncGateway.findByEhEmployeeId).
 *
 * `broken` is read off the LATEST sync_log row, not `employee_map.last_outcome` -
 * neither a dead-letter nor a collision is ever written to `employee_map` (see
 * handleDeadLetter and the collision check in sync/consumer.ts), so a person
 * whose very first-ever sync attempt hit either has no `employee_map` row at
 * all. `ROSTER_QUERY_SQL` starts from the UNION of both tables' ids so that
 * person still shows up here as `broken`.
 *
 * No employee VALUE ever reaches this module - only ids, the outcome enum, and
 * the redaction-safe strings already written by auditDetail() (sync/decide.ts).
 */
import type { SyncOutcomeLabel } from "../sync/gateway.js";

/** `left_out`: left out of the sync by choice (`rules.exclude`) - nothing to act on. */
export type RosterState = "ready" | "waiting_on_employee" | "waiting_on_admin" | "broken" | "left_out";

/** One joined row, as returned by {@link ROSTER_QUERY_SQL}. */
export interface RosterRow {
  ctUserId: number;
  /** From `employee_map`; null if this person has no `employee_map` row. */
  ehEmployeeId: string | null;
  failureCycleCount: number | null;
  /** `employee_map.last_outcome`; null if this person has no `employee_map` row. */
  lastOutcome: SyncOutcomeLabel | null;
  /** The outcome of this person's most recent `sync_log` row, if any. */
  latestOutcome: SyncOutcomeLabel | null;
  latestDetail: string | null;
}

export interface RosterEntry {
  ctUserId: number;
  ehEmployeeId: string | null;
  state: RosterState;
  /**
   * Field names (waiting_on_employee), admin reason phrases (waiting_on_admin),
   * or the last error (broken). Empty when ready.
   */
  reasons: string[];
  /** Correction-cycle count; only meaningful for waiting_on_employee. */
  cycleCount?: number;
}

/**
 * One SELECT, reused verbatim by both `GET /health` (env.DB.prepare - no
 * drizzle, see health.ts) and `SyncStore.listRosterRows` (raw d1.prepare) so
 * the two surfaces can never drift on what counts as which state. The id set
 * is the UNION of `employee_map` and `sync_log` - see the module doc above for
 * why `sync_log`-only rows matter.
 */
export const ROSTER_QUERY_SQL = `
WITH ids AS (
  SELECT ct_user_id FROM employee_map
  UNION
  SELECT ct_user_id FROM sync_log
),
latest AS (
  SELECT ct_user_id, outcome, detail FROM sync_log
  WHERE id IN (SELECT MAX(id) FROM sync_log GROUP BY ct_user_id)
)
SELECT
  ids.ct_user_id AS ctUserId,
  employee_map.eh_employee_id AS ehEmployeeId,
  employee_map.failure_cycle_count AS failureCycleCount,
  employee_map.last_outcome AS lastOutcome,
  latest.outcome AS latestOutcome,
  latest.detail AS latestDetail
FROM ids
LEFT JOIN employee_map ON employee_map.ct_user_id = ids.ct_user_id
LEFT JOIN latest ON latest.ct_user_id = ids.ct_user_id
ORDER BY ids.ct_user_id
`;

const CORRECTION_PREFIX = "correction: ";
const EXCLUDED_PREFIX = "excluded: ";
const FOLLOW_UP_PREFIX = "follow_up: ";
const NO_DETAIL = "Employment Hero flagged this record - see the audit log.";
/**
 * A dead-letter's reason (#127). Its sync_log detail is only "retries
 * exhausted", which tells an admin nothing; the System alert posted at the same
 * moment carries the detail. A collision keeps its own detail: its cause and
 * fix differ.
 */
export const DEAD_LETTER_REASON =
  "sync failed repeatedly (not the employee's data): see the System alert, and once it's fixed, edit their profile in Connecteam to retry";

export function deriveRosterEntry(row: RosterRow): RosterEntry {
  const base = { ctUserId: row.ctUserId, ehEmployeeId: row.ehEmployeeId };

  if (row.latestOutcome === "dead_letter") {
    return { ...base, state: "broken", reasons: [DEAD_LETTER_REASON] };
  }
  if (row.latestOutcome === "collision") {
    return { ...base, state: "broken", reasons: [row.latestDetail?.trim() || "see the Identity-collision alert"] };
  }

  switch (row.lastOutcome) {
    case "excluded":
      return { ...base, state: "left_out", reasons: splitDetail(row.latestDetail, EXCLUDED_PREFIX, "\n") };
    case "correction":
      return {
        ...base,
        state: "waiting_on_employee",
        reasons: splitDetail(row.latestDetail, CORRECTION_PREFIX, ","),
        cycleCount: row.failureCycleCount ?? 0,
      };
    case "follow_up":
      return {
        ...base,
        state: "waiting_on_admin",
        reasons: splitDetail(row.latestDetail, FOLLOW_UP_PREFIX, "|"),
      };
    // "ok" | "resolved" -> genuinely ready. "retry" is never persisted to
    // employee_map (runSyncJob returns before saveEmployeeLink) and null means
    // no employee_map row and no dead-letter either, which cannot happen given
    // the UNION - both are kept only so this switch is exhaustive over the type.
    default:
      return { ...base, state: "ready", reasons: [] };
  }
}

function splitDetail(detail: string | null, prefix: string, sep: string): string[] {
  const body = detail?.startsWith(prefix) ? detail.slice(prefix.length) : detail;
  const parts = (body ?? "").split(sep).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [NO_DETAIL];
}

export interface RosterCounts {
  ready: number;
  waitingEmployee: number;
  waitingAdmin: number;
  broken: number;
  leftOut: number;
}

export function summarizeRoster(entries: readonly RosterEntry[]): RosterCounts {
  const counts: RosterCounts = { ready: 0, waitingEmployee: 0, waitingAdmin: 0, broken: 0, leftOut: 0 };
  for (const e of entries) {
    if (e.state === "ready") counts.ready++;
    else if (e.state === "waiting_on_employee") counts.waitingEmployee++;
    else if (e.state === "waiting_on_admin") counts.waitingAdmin++;
    else if (e.state === "left_out") counts.leftOut++;
    else counts.broken++;
  }
  return counts;
}

/**
 * A left-out reason (`customField <id> (<name>)`) as admins read it: the field's
 * name, plus the answers the field map leaves out when known ("Employee Status: PBV").
 */
export function leftOutLabel(reason: string, exclude: ReadonlyArray<{ customFieldId: number; values: readonly string[] }> = []): string {
  const m = /^customField (\d+) \((.*)\)$/.exec(reason.trim());
  if (!m) return reason;
  const values = exclude.find((r) => r.customFieldId === Number(m[1]))?.values ?? [];
  return values.length ? `${m[2]}: ${values.join(", ")}` : m[2]!;
}

/** Parse the raw rows a D1 `.all()` call returns for {@link ROSTER_QUERY_SQL}. */
export function parseRosterRows(results: readonly unknown[]): RosterRow[] {
  return (results as Array<Record<string, unknown>>).map((r) => ({
    ctUserId: Number(r.ctUserId),
    ehEmployeeId: (r.ehEmployeeId as string | null | undefined) ?? null,
    failureCycleCount:
      r.failureCycleCount === null || r.failureCycleCount === undefined ? null : Number(r.failureCycleCount),
    lastOutcome: (r.lastOutcome as SyncOutcomeLabel | null | undefined) ?? null,
    latestOutcome: (r.latestOutcome as SyncOutcomeLabel | null | undefined) ?? null,
    latestDetail: (r.latestDetail as string | null | undefined) ?? null,
  }));
}
