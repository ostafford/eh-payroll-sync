/**
 * The link stage's input to {@link buildLinkList} (#154), from what the stage
 * fetched: Connecteam's users and onboarding assignments, EH's employee list
 * and the D1 rows. Pure - the script does the fetching. Reads names, emails,
 * Payroll IDs and status only: never a TFN or date of birth.
 */
import type { ConnecteamUser, OnboardingAssignment } from "../../src/connecteam/types.js";
import { payrollIdOf } from "../../src/mapping/apply.js";
import type { PayrollIdSource } from "../../src/mapping/schema.js";
import { heldCandidateIds } from "../../src/sync/precheck.js";
import type { LinkEhEmployee, LinkListInput, LinkPendingRow } from "./link-list.js";

/** An `employee_map` row, with the Payroll ID stored at the first sync or link. */
export interface LinkStageMapRow {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastOutcome: string | null;
  externalId: string | null;
}

export interface LinkStageData {
  /** Every Connecteam user, archived ones too. */
  ctUsers: readonly ConnecteamUser[];
  /** EH's employee list as the API returns it. */
  ehEmployees: readonly Record<string, unknown>[];
  assignments: readonly OnboardingAssignment[];
  employeeMap: readonly LinkStageMapRow[];
  pendingLinks: readonly LinkPendingRow[];
  /** Each person's latest `existing_match` detail from `sync_log`. */
  heldDetails: readonly { ctUserId: number; detail: string | null }[];
  payrollIdFrom: PayrollIdSource;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const textOrNull = (v: unknown): string | null => text(v) || null;

function ehEmployee(e: Record<string, unknown>): LinkEhEmployee {
  return {
    id: String(e.id),
    firstName: text(e.firstName),
    surname: text(e.surname),
    email: textOrNull(e.emailAddress),
    externalId: textOrNull(e.externalId),
    ...(typeof e.status === "string" ? { status: e.status } : {}),
  };
}

export function linkListInput(data: LinkStageData): LinkListInput {
  // Fixed at the first sync or link, so a later edit to the field can't re-key them (ADR-0011).
  const stored = new Map(data.employeeMap.flatMap((m) => (m.externalId ? [[m.ctUserId, m.externalId] as const] : [])));
  return {
    ctUsers: data.ctUsers.filter((u) => !u.isArchived).map((u) => ({
      ctUserId: u.userId,
      firstName: text(u.firstName),
      lastName: text(u.lastName),
      email: textOrNull(u.email),
      payrollId: stored.get(u.userId) ?? payrollIdOf(u, data.payrollIdFrom) ?? String(u.userId),
    })),
    ehEmployees: data.ehEmployees.map(ehEmployee),
    assignments: data.assignments,
    employeeMap: data.employeeMap.map(({ ctUserId, ehEmployeeId, lastOutcome }) => ({ ctUserId, ehEmployeeId, lastOutcome })),
    pendingLinks: data.pendingLinks,
    heldCandidates: new Map(
      data.heldDetails.flatMap(({ ctUserId, detail }) => {
        const ids = heldCandidateIds(detail);
        return ids.length ? [[ctUserId, ids] as const] : [];
      }),
    ),
  };
}
