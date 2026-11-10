/**
 * The link list's data (#153): which Connecteam user matches which EH
 * employee, for the wizard's link stage (#132, #137). Pure - the caller
 * fetches both sides and the D1 rows. Matches on email and name only: TFN and
 * date of birth are never read, so they never reach the integrator's terminal.
 */
import { isTerminated } from "../../src/sync/precheck.js";

export interface LinkCtUser {
  ctUserId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  /** The Payroll ID the sync would use for them: the userId, or the copied field (ADR-0011). */
  payrollId: string;
}

export interface LinkEhEmployee {
  id: number;
  firstName: string;
  surname: string;
  email: string | null;
  externalId: string | null;
  status?: string;
}

export interface LinkListInput {
  /** Every active Connecteam user, synced ones too: their Payroll IDs mark EH records as linked elsewhere. */
  ctUsers: readonly LinkCtUser[];
  ehEmployees: readonly LinkEhEmployee[];
  assignments: readonly { userId: number; status: "in_progress" | "completed"; isWaitingApproval: boolean }[];
  employeeMap: readonly { ctUserId: number; ehEmployeeId: string | null; lastOutcome: string | null }[];
  pendingLinks: readonly { ctUserId: number; ehEmployeeId: string | null }[];
  /** A Held employee's candidate EH ids, from their `existing_match` detail. */
  heldCandidates: ReadonlyMap<number, readonly string[]>;
}

export type LinkRowKind = "matched" | "choice" | "newHire" | "alreadySynced" | "taken" | "held" | "onLinkList";

/** Why a candidate needs the admin's choice instead of being proposed. */
export type ChoiceReason = "nameDiffers" | "sameEmailSeveral" | "nameOnly" | "hasPayrollId" | "terminated" | "linkedElsewhere" | "goneFromEh" | "payrollIdShared";

export interface LinkCandidate {
  ehEmployeeId: string;
  reasons: ChoiceReason[];
  /** The Payroll ID EH already holds, shown so the admin knows what a link would overwrite. */
  payrollId?: string;
  /** The Connecteam user whose Payroll ID this EH employee already carries. */
  linkedTo?: number;
}

/** Where the person's onboarding pack is, for the Pack column (#134). */
export type PackStatus = "notAssigned" | "inProgress" | "readyForReview" | "approvedNotSynced";

const PACK_ORDER: readonly PackStatus[] = ["notAssigned", "inProgress", "readyForReview", "approvedNotSynced"];

/** CONTEXT.md "Onboarding pack": waiting for approval is still `in_progress`; `completed` is approved. */
function packOf(a: LinkListInput["assignments"][number]): PackStatus {
  if (a.status === "completed") return "approvedNotSynced";
  return a.isWaitingApproval ? "readyForReview" : "inProgress";
}

export interface LinkRow {
  ctUserId: number;
  kind: LinkRowKind;
  /** The EH employee id proposed (matched) or already on the Link list (onLinkList; null there is "New hire, not this person"). */
  suggestion: string | null;
  /** The EH employees the admin chooses between, for a choice row. */
  candidates: LinkCandidate[];
  /** A Held employee also offers "New hire, not this person". */
  newHireChoice?: true;
  pack: PackStatus;
}

export interface LinkList {
  rows: LinkRow[];
  /** EH employees no Connecteam user matched: shown as a count only. */
  ignoredEhCount: number;
}

function norm(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function sameName(u: LinkCtUser, e: LinkEhEmployee): boolean {
  return norm(u.firstName) === norm(e.firstName) && norm(u.lastName) === norm(e.surname);
}

export function buildLinkList(input: LinkListInput): LinkList {
  const ctPerEmail = new Map<string, number>();
  const ctByPayrollId = new Map<string, number[]>();
  for (const u of input.ctUsers) {
    const k = norm(u.email);
    if (k) ctPerEmail.set(k, (ctPerEmail.get(k) ?? 0) + 1);
    const id = u.payrollId.trim();
    ctByPayrollId.set(id, [...(ctByPayrollId.get(id) ?? []), u.ctUserId]);
  }

  const ehByPayrollId = new Map<string, LinkEhEmployee>();
  for (const e of input.ehEmployees) {
    const id = e.externalId?.trim();
    if (id) ehByPayrollId.set(id, e);
  }

  // An EH employee already in employee_map belongs to that user, even one no longer active.
  const ctByEhId = new Map(input.employeeMap.flatMap((m) => (m.ehEmployeeId ? [[m.ehEmployeeId, m.ctUserId] as const] : [])));

  const candidate = (e: LinkEhEmployee, reasons: ChoiceReason[]): LinkCandidate => {
    if (isTerminated(e)) reasons = [...reasons, "terminated"];
    const payrollId = e.externalId?.trim();
    const owners = payrollId ? (ctByPayrollId.get(payrollId) ?? []) : [];
    const linkedTo = ctByEhId.get(String(e.id)) ?? (owners.length === 1 ? owners[0] : undefined);
    if (!payrollId && linkedTo === undefined) return { ehEmployeeId: String(e.id), reasons };
    // Several Connecteam users hold this ID: fix it in Connecteam first (ADR-0011).
    if (linkedTo === undefined && owners.length > 1) {
      return { ehEmployeeId: String(e.id), reasons: [...reasons, "payrollIdShared"], payrollId: payrollId! };
    }
    if (linkedTo !== undefined) return { ehEmployeeId: String(e.id), reasons: [...reasons, "linkedElsewhere"], linkedTo };
    return { ehEmployeeId: String(e.id), reasons: [...reasons, "hasPayrollId"], payrollId: payrollId! };
  };

  const synced = new Set(input.employeeMap.filter((m) => m.ehEmployeeId).map((m) => m.ctUserId));

  const ehById = new Map(input.ehEmployees.map((e) => [String(e.id), e]));
  const held = new Set(input.employeeMap.filter((m) => m.lastOutcome === "existing_match").map((m) => m.ctUserId));

  const onLinkList = new Map(input.pendingLinks.map((p) => [p.ctUserId, p.ehEmployeeId]));

  const pack = new Map<number, PackStatus>();
  for (const a of input.assignments) {
    const p = packOf(a);
    const was = pack.get(a.userId) ?? "notAssigned";
    if (PACK_ORDER.indexOf(p) > PACK_ORDER.indexOf(was)) pack.set(a.userId, p);
  }

  /** An EH employee named by an earlier run or the Pre-create check, re-checked now. */
  const recheck = (id: string): LinkCandidate => {
    const e = ehById.get(id);
    return e ? candidate(e, []) : { ehEmployeeId: id, reasons: ["goneFromEh"] };
  };

  const classify = (u: LinkCtUser): Omit<LinkRow, "pack"> => {
    if (onLinkList.has(u.ctUserId)) {
      const id = onLinkList.get(u.ctUserId) ?? null;
      return { ctUserId: u.ctUserId, kind: "onLinkList", suggestion: id, candidates: id ? [recheck(id)] : [] };
    }
    if (held.has(u.ctUserId)) {
      const candidates = (input.heldCandidates.get(u.ctUserId) ?? []).map(recheck);
      return { ctUserId: u.ctUserId, kind: "held", suggestion: null, candidates, newHireChoice: true };
    }

    const own = ehByPayrollId.get(u.payrollId.trim());
    const idShared = (ctByPayrollId.get(u.payrollId.trim())?.length ?? 0) > 1;
    if (own && !idShared) return { ctUserId: u.ctUserId, kind: "alreadySynced", suggestion: String(own.id), candidates: [] };

    const email = norm(u.email);
    const sameEmail = email ? input.ehEmployees.filter((e) => norm(e.email) === email) : [];
    const several = sameEmail.length > 1 || (ctPerEmail.get(email) ?? 0) > 1;
    const byEmail = sameEmail.map((e) => {
      const reasons: ChoiceReason[] = [];
      if (!sameName(u, e)) reasons.push("nameDiffers");
      if (several) reasons.push("sameEmailSeveral");
      return candidate(e, reasons);
    });
    const byNameOnly = input.ehEmployees
      .filter((e) => !sameEmail.includes(e) && sameName(u, e))
      .map((e) => candidate(e, ["nameOnly"]))
      // A name alone isn't a hit (#134): someone else's record is no reason to stop a new hire.
      .filter((c) => !c.reasons.includes("linkedElsewhere"));
    const bySharedId = own && idShared && !sameEmail.includes(own) && !sameName(u, own) ? [candidate(own, [])] : [];
    const candidates = [...byEmail, ...byNameOnly, ...bySharedId];

    if (candidates.length === 0) return { ctUserId: u.ctUserId, kind: "newHire", suggestion: null, candidates };
    if (candidates.every((c) => c.reasons.includes("linkedElsewhere"))) {
      return { ctUserId: u.ctUserId, kind: "taken", suggestion: null, candidates };
    }
    const [only] = candidates;
    if (candidates.length === 1 && only!.reasons.length === 0) {
      return { ctUserId: u.ctUserId, kind: "matched", suggestion: only!.ehEmployeeId, candidates: [] };
    }
    return { ctUserId: u.ctUserId, kind: "choice", suggestion: null, candidates };
  };

  const rows = input.ctUsers
    .filter((u) => !synced.has(u.ctUserId))
    .map((u): LinkRow => ({ ...classify(u), pack: pack.get(u.ctUserId) ?? "notAssigned" }));
  const active = new Set(input.ctUsers.map((u) => u.ctUserId));
  const touched = new Set(input.employeeMap.flatMap((m) => (m.ehEmployeeId && active.has(m.ctUserId) ? [m.ehEmployeeId] : [])));
  for (const r of rows) {
    if (r.suggestion) touched.add(r.suggestion);
    for (const c of r.candidates) touched.add(c.ehEmployeeId);
  }
  return { rows, ignoredEhCount: input.ehEmployees.filter((e) => !touched.has(String(e.id))).length };
}
