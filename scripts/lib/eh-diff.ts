/**
 * The EH before/after diff (#157): proves EH changed nothing but the Payroll ID
 * for chosen employees. `snapshot` saves each one's full record; `diff` reads
 * them again and names the fields that changed, never their values. Used in
 * the linking rehearsal and to check a canary on a real client.
 *
 * Read-only: it only ever calls `getEmployee`. A snapshot holds full values
 * (TFN, bank details), so it lives in a git-ignored file and nothing here
 * prints from it.
 */
import type { EhResult } from "../../src/eh/client.js";
import type { EhEmployee } from "../../src/eh/types.js";

/** The one field a link may change (ADR-0009). */
export const PAYROLL_ID_FIELD = "externalId";

/** The default snapshot file, git-ignored (`eh-snapshot*.json`). */
export const DEFAULT_SNAPSHOT_FILE = "eh-snapshot.json";

export interface Snapshot {
  takenAt: string;
  businessId: string;
  /** Keyed by EH employee id. */
  employees: Record<string, EhEmployee>;
}

export type Change = "set" | "changed" | "cleared";

export interface FieldChange {
  field: string;
  change: Change;
}

export type EmployeeDiff = { id: number; gone: false; changes: FieldChange[] } | { id: number; gone: true };

export type GetEmployee = (id: number) => Promise<EhResult<EhEmployee | null>>;

/** Read one employee, or throw naming the status only: a response body can echo an employee's details back. */
async function read(get: GetEmployee, id: number): Promise<EhEmployee | null> {
  const r = await get(id);
  if (r.outcome === "ok") return r.data;
  const status = "status" in r && r.status !== null ? `HTTP ${r.status}` : "no response";
  throw new Error(`Employment Hero employee ${id} -> ${status}`);
}

export async function takeSnapshot(ids: number[], get: GetEmployee, businessId: string, now: Date): Promise<Snapshot> {
  const employees: Record<string, EhEmployee> = {};
  for (const id of ids) {
    const e = await read(get, id);
    if (e === null) throw new Error(`Employment Hero has no employee ${id} in business ${businessId}`);
    employees[String(id)] = e;
  }
  return { takenAt: now.toISOString(), businessId, employees };
}

export async function diffSnapshot(snapshot: Snapshot, get: GetEmployee): Promise<EmployeeDiff[]> {
  const out: EmployeeDiff[] = [];
  for (const [key, before] of Object.entries(snapshot.employees)) {
    const id = Number(key);
    const after = await read(get, id);
    out.push(after === null ? { id, gone: true } : { id, gone: false, changes: diffRecords(before, after) });
  }
  return out;
}

/** Dot paths to every leaf. Arrays are leaves: compared whole, since their order is EH's. */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value);
  }
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** The fields that differ, by name, sorted. Null, missing, "" and [] all count as empty. */
export function diffRecords(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const b = new Map<string, unknown>();
  const a = new Map<string, unknown>();
  flatten(before, "", b);
  flatten(after, "", a);
  const changes: FieldChange[] = [];
  for (const field of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const was = b.get(field);
    const now = a.get(field);
    if (isEmpty(was) && isEmpty(now)) continue;
    if (isEmpty(was)) changes.push({ field, change: "set" });
    else if (isEmpty(now)) changes.push({ field, change: "cleared" });
    else if (JSON.stringify(was) !== JSON.stringify(now)) changes.push({ field, change: "changed" });
  }
  return changes;
}

/** Whether this employee changed in any way a link mustn't. */
export function beyondPayrollId(d: EmployeeDiff): boolean {
  return d.gone || d.changes.some((c) => c.field !== PAYROLL_ID_FIELD);
}

/** One line per employee (EH id, field names and set/changed/cleared), then the verdict. */
export function renderDiff(diffs: EmployeeDiff[], snapshot: Pick<Snapshot, "takenAt">): string {
  const lines = [`Compared with the snapshot taken ${snapshot.takenAt}:`, ""];
  for (const d of diffs) {
    const what = d.gone
      ? "no longer in Employment Hero"
      : d.changes.length === 0
        ? "no changes"
        : d.changes.map((c) => `${c.field} ${c.change}`).join(", ");
    lines.push(`  ${beyondPayrollId(d) ? "[!]" : "[ok]"} EH employee ${d.id}: ${what}`);
  }
  const over = diffs.filter(beyondPayrollId).length;
  lines.push(
    "",
    over === 0
      ? `Nothing beyond the Payroll ID (${PAYROLL_ID_FIELD}) changed for any of the ${diffs.length} employees.`
      : `${over} of ${diffs.length} employees changed beyond the Payroll ID. If a link did this, stop the sync (RUNBOOK "Emergency stop").`,
  );
  return lines.join("\n");
}
