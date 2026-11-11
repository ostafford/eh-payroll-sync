/**
 * The sync's own records for the preflight (#168): who has synced or is
 * linked, the Payroll ID stored for them, and the Link list. Read from the
 * live D1 database through the checked config (scripts/lib/remote-d1.ts).
 *
 * Before the first deploy `.dev.vars` names no database, so there's nothing
 * to read. Once it names one, a failed read throws: the Link list would
 * otherwise be left out of the prediction without a word.
 */
import { databaseIdOf } from "./deploy-config.js";
import type { PreflightRecords } from "./preflight.js";

export interface RecordsIo {
  /** Throws when the built config doesn't check out against the account. */
  check(): void;
  query(sql: string): unknown[];
}

const MAP_SQL =
  "SELECT ct_user_id AS ctUserId, eh_employee_id AS ehEmployeeId, last_outcome AS lastOutcome, linked_at AS linkedAt, external_id AS externalId FROM employee_map";
const PENDING_SQL = "SELECT ct_user_id AS ctUserId, eh_employee_id AS ehEmployeeId FROM pending_link";

/** The records, or null when `.dev.vars` names no database yet. */
export function readSyncRecords(devVars: Record<string, string>, io: RecordsIo): PreflightRecords | null {
  if (!databaseIdOf(devVars)) return null;
  io.check();
  const id = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const employeeMap = io.query(MAP_SQL) as Array<PreflightRecords["employeeMap"][number]>;
  const pendingLinks = io.query(PENDING_SQL) as Array<PreflightRecords["pendingLinks"][number]>;
  return {
    employeeMap: employeeMap.map((m) => ({ ...m, ehEmployeeId: id(m.ehEmployeeId), externalId: id(m.externalId) })),
    pendingLinks: pendingLinks.map((l) => ({ ...l, ehEmployeeId: id(l.ehEmployeeId) })),
  };
}
