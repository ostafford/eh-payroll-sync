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

export type LinkRowKind = "matched" | "choice" | "newHire" | "alreadySynced" | "taken" | "held" | "saved";

/** Why a candidate needs the admin's choice instead of being proposed. */
export type ChoiceReason = "nameDiffers" | "sameEmailSeveral" | "nameOnly" | "hasPayrollId" | "terminated" | "linkedElsewhere";

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

function packOf(a: LinkListInput["assignments"][number]): PackStatus {
  if (a.status === "in_progress") return "inProgress";
  return a.isWaitingApproval ? "readyForReview" : "approvedNotSynced";
}

export interface LinkRow {
  ctUserId: number;
  kind: LinkRowKind;
  /** The EH employee id proposed (matched) or already saved (saved; null there is "New hire, not this person"). */
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
  const ctByPayrollId = new Map<string, number>();
  for (const u of input.ctUsers) {
    const k = norm(u.email);
    if (k) ctPerEmail.set(k, (ctPerEmail.get(k) ?? 0) + 1);
    ctByPayrollId.set(u.payrollId.trim(), u.ctUserId);
  }

  const ehByPayrollId = new Map<string, LinkEhEmployee>();
  for (const e of input.ehEmployees) {
    const id = e.externalId?.trim();
    if (id) ehByPayrollId.set(id, e);
  }

  const candidate = (e: LinkEhEmployee, reasons: ChoiceReason[]): LinkCandidate => {
    if (isTerminated(e)) reasons = [...reasons, "terminated"];
    const payrollId = e.externalId?.trim();
    if (!payrollId) return { ehEmployeeId: String(e.id), reasons };
    const linkedTo = ctByPayrollId.get(payrollId);
    if (linkedTo !== undefined) return { ehEmployeeId: String(e.id), reasons: [...reasons, "linkedElsewhere"], linkedTo };
    return { ehEmployeeId: String(e.id), reasons: [...reasons, "hasPayrollId"], payrollId };
  };

  const synced = new Set(input.employeeMap.filter((m) => m.ehEmployeeId).map((m) => m.ctUserId));

  const ehById = new Map(input.ehEmployees.map((e) => [String(e.id), e]));
  const held = new Set(input.employeeMap.filter((m) => m.lastOutcome === "existing_match").map((m) => m.ctUserId));

  const saved = new Map(input.pendingLinks.map((p) => [p.ctUserId, p.ehEmployeeId]));

  const pack = new Map<number, PackStatus>();
  for (const a of input.assignments) {
    const p = packOf(a);
    const was = pack.get(a.userId) ?? "notAssigned";
    if (PACK_ORDER.indexOf(p) > PACK_ORDER.indexOf(was)) pack.set(a.userId, p);
  }

  const classify = (u: LinkCtUser): Omit<LinkRow, "pack"> => {
    if (saved.has(u.ctUserId)) {
      return { ctUserId: u.ctUserId, kind: "saved", suggestion: saved.get(u.ctUserId) ?? null, candidates: [] };
    }
    if (held.has(u.ctUserId)) {
      const ids = input.heldCandidates.get(u.ctUserId) ?? [];
      const candidates = ids.flatMap((id) => {
        const e = ehById.get(id);
        return e ? [candidate(e, [])] : [];
      });
      return { ctUserId: u.ctUserId, kind: "held", suggestion: null, candidates, newHireChoice: true };
    }

    const own = ehByPayrollId.get(u.payrollId.trim());
    if (own) return { ctUserId: u.ctUserId, kind: "alreadySynced", suggestion: String(own.id), candidates: [] };

    const email = norm(u.email);
    const sameEmail = email ? input.ehEmployees.filter((e) => norm(e.email) === email) : [];
    const several = sameEmail.length > 1 || (ctPerEmail.get(email) ?? 0) > 1;
    const candidates =
      sameEmail.length > 0
        ? sameEmail.map((e) => {
            const reasons: ChoiceReason[] = [];
            if (!sameName(u, e)) reasons.push("nameDiffers");
            if (several) reasons.push("sameEmailSeveral");
            return candidate(e, reasons);
          })
        : input.ehEmployees.filter((e) => sameName(u, e)).map((e) => candidate(e, ["nameOnly"]));

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
  const touched = new Set(input.employeeMap.flatMap((m) => m.ehEmployeeId ?? []));
  for (const r of rows) {
    if (r.suggestion) touched.add(r.suggestion);
    for (const c of r.candidates) touched.add(c.ehEmployeeId);
  }
  return { rows, ignoredEhCount: input.ehEmployees.filter((e) => !touched.has(String(e.id))).length };
}
