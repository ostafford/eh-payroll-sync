/**
 * The link list's data (#153): which Connecteam user matches which EH
 * employee, for the wizard's link stage (#132, #137). Pure - the caller
 * fetches both sides and the D1 rows. Matches on email and name only: TFN and
 * date of birth are never read, so they never reach the integrator's terminal.
 */
import type { OnboardingAssignment } from "../../src/connecteam/types.js";
import { isTerminated } from "../../src/sync/precheck.js";
import { norm } from "./preflight.js";

export interface LinkCtUser {
  ctUserId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  /** The Payroll ID the sync would use for them: the userId, or the copied field (ADR-0011). */
  payrollId: string;
}

export interface LinkEhEmployee {
  /** As D1 stores it: a string. */
  id: string;
  firstName: string;
  surname: string;
  email: string | null;
  externalId: string | null;
  status?: string;
}

export type LinkAssignment = Pick<OnboardingAssignment, "userId" | "status" | "isWaitingApproval">;

/** The `employee_map` columns the link list needs. */
export interface LinkMapRow {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastOutcome: string | null;
}

/** A `pending_link` row: a NULL `ehEmployeeId` is "New hire, not this person". */
export interface LinkPendingRow {
  ctUserId: number;
  ehEmployeeId: string | null;
}

export interface LinkListInput {
  /** Every active Connecteam user, synced ones too: their Payroll IDs mark EH records as linked elsewhere. */
  ctUsers: readonly LinkCtUser[];
  ehEmployees: readonly LinkEhEmployee[];
  assignments: readonly LinkAssignment[];
  employeeMap: readonly LinkMapRow[];
  pendingLinks: readonly LinkPendingRow[];
  /** A Held employee's candidate EH ids, from their `existing_match` detail. */
  heldCandidates: ReadonlyMap<number, readonly string[]>;
}

export type LinkRowKind = "matched" | "choice" | "newHire" | "alreadySynced" | "taken" | "held" | "onLinkList";

/** Why a candidate needs the admin's choice instead of being proposed. */
export type ChoiceReason =
  | "nameDiffers"
  | "sameEmailSeveral"
  | "nameOnly"
  | "hasPayrollId"
  | "terminated"
  | "linkedElsewhere"
  | "goneFromEh"
  | "payrollIdShared";

export interface LinkCandidate {
  ehEmployeeId: string;
  reasons: ChoiceReason[];
  /** The Payroll ID EH already holds, shown so the admin knows what a link would overwrite. */
  payrollId?: string;
  /** The Connecteam user this EH employee already belongs to. */
  linkedTo?: number;
}

/** Where the person's onboarding pack is, for the Pack column (#134). */
export type PackStatus = "notAssigned" | "inProgress" | "readyForReview" | "approvedNotSynced";

export interface LinkRow {
  ctUserId: number;
  kind: LinkRowKind;
  /** The EH employee id proposed (matched) or already on the Link list (onLinkList; null there is "New hire, not this person"). */
  suggestion: string | null;
  /** The EH employees the admin chooses between, or the one a Link-list row points at, re-checked. */
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

const PACK_ORDER: readonly PackStatus[] = ["notAssigned", "inProgress", "readyForReview", "approvedNotSynced"];

/** CONTEXT.md "Onboarding pack": waiting for approval is still `in_progress`; `completed` is approved. */
function packOf(a: LinkAssignment): PackStatus {
  if (a.status === "completed") return "approvedNotSynced";
  return a.isWaitingApproval ? "readyForReview" : "inProgress";
}

/** A full name to compare on, or null when either part is blank: a blank name never agrees. */
function nameKey(first: string, last: string): string | null {
  const f = norm(first);
  const l = norm(last);
  return f && l ? `${f}\u0000${l}` : null;
}

function sameName(u: LinkCtUser, e: LinkEhEmployee): boolean {
  const key = nameKey(u.firstName, u.lastName);
  return key !== null && key === nameKey(e.firstName, e.surname);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

/** Lookups built once from the input, so each row is classified without rescanning it. */
interface Index {
  input: LinkListInput;
  ehById: Map<string, LinkEhEmployee>;
  ehByPayrollId: Map<string, LinkEhEmployee>;
  ehByEmail: Map<string, LinkEhEmployee[]>;
  ehByName: Map<string, LinkEhEmployee[]>;
  ctByPayrollId: Map<string, number[]>;
  ctPerEmail: Map<string, number>;
  /** An EH employee already in employee_map belongs to that user, even one no longer active. */
  ctByEhId: Map<string, number>;
  held: Set<number>;
  onLinkList: Map<number, string | null>;
}

function indexInput(input: LinkListInput): Index {
  const ctByPayrollId = new Map<string, number[]>();
  const ctPerEmail = new Map<string, number>();
  for (const u of input.ctUsers) {
    push(ctByPayrollId, u.payrollId.trim(), u.ctUserId);
    const email = norm(u.email);
    if (email) ctPerEmail.set(email, (ctPerEmail.get(email) ?? 0) + 1);
  }
  const ehByPayrollId = new Map<string, LinkEhEmployee>();
  const ehByEmail = new Map<string, LinkEhEmployee[]>();
  const ehByName = new Map<string, LinkEhEmployee[]>();
  for (const e of input.ehEmployees) {
    const id = e.externalId?.trim();
    if (id) ehByPayrollId.set(id, e);
    const email = norm(e.email);
    if (email) push(ehByEmail, email, e);
    const name = nameKey(e.firstName, e.surname);
    if (name) push(ehByName, name, e);
  }
  return {
    input,
    ehById: new Map(input.ehEmployees.map((e) => [e.id, e])),
    ehByPayrollId,
    ehByEmail,
    ehByName,
    ctByPayrollId,
    ctPerEmail,
    ctByEhId: new Map(input.employeeMap.flatMap((m) => (m.ehEmployeeId ? [[m.ehEmployeeId, m.ctUserId] as const] : []))),
    held: new Set(input.employeeMap.filter((m) => m.lastOutcome === "existing_match").map((m) => m.ctUserId)),
    onLinkList: new Map(input.pendingLinks.map((p) => [p.ctUserId, p.ehEmployeeId])),
  };
}

/** One EH employee as a candidate, with what EH says about them added to the match reasons. */
function candidateFor(ix: Index, e: LinkEhEmployee, matchReasons: readonly ChoiceReason[]): LinkCandidate {
  const reasons = isTerminated(e) ? [...matchReasons, "terminated" as const] : [...matchReasons];
  const ehEmployeeId = e.id;
  const payrollId = e.externalId?.trim();
  const owners = payrollId ? (ix.ctByPayrollId.get(payrollId) ?? []) : [];
  const linkedTo = ix.ctByEhId.get(e.id) ?? (owners.length === 1 ? owners[0] : undefined);
  if (linkedTo !== undefined) return { ehEmployeeId, reasons: [...reasons, "linkedElsewhere"], linkedTo };
  if (!payrollId) return { ehEmployeeId, reasons };
  // Several Connecteam users hold this ID: fix it in Connecteam first (ADR-0011).
  if (owners.length > 1) return { ehEmployeeId, reasons: [...reasons, "payrollIdShared"], payrollId };
  return { ehEmployeeId, reasons: [...reasons, "hasPayrollId"], payrollId };
}

/** An EH employee named by an earlier run or the Pre-create check, re-checked now. */
function recheck(ix: Index, id: string): LinkCandidate {
  const e = ix.ehById.get(id);
  return e ? candidateFor(ix, e, []) : { ehEmployeeId: id, reasons: ["goneFromEh"] };
}

/** Everyone in EH who could be this person: by email, by name alone, or by a Payroll ID they share. */
function matchCandidates(ix: Index, u: LinkCtUser, sharedIdRecord: LinkEhEmployee | undefined): LinkCandidate[] {
  const email = norm(u.email);
  const sameEmail = email ? (ix.ehByEmail.get(email) ?? []) : [];
  const several = sameEmail.length > 1 || (ix.ctPerEmail.get(email) ?? 0) > 1;
  const byEmail = sameEmail.map((e) =>
    candidateFor(ix, e, [...(sameName(u, e) ? [] : ["nameDiffers" as const]), ...(several ? ["sameEmailSeveral" as const] : [])]),
  );
  const name = nameKey(u.firstName, u.lastName);
  const byNameOnly = (name ? (ix.ehByName.get(name) ?? []) : [])
    .filter((e) => !sameEmail.includes(e))
    .map((e) => candidateFor(ix, e, ["nameOnly"]))
    // A name alone isn't a hit (#134): someone else's record is no reason to stop a new hire.
    .filter((c) => !c.reasons.includes("linkedElsewhere"));
  const seen = new Set([...byEmail, ...byNameOnly].map((c) => c.ehEmployeeId));
  const bySharedId = sharedIdRecord && !seen.has(sharedIdRecord.id) ? [candidateFor(ix, sharedIdRecord, [])] : [];
  return [...byEmail, ...byNameOnly, ...bySharedId];
}

/** The row for one Connecteam user not yet synced, in precedence order. */
function classify(ix: Index, u: LinkCtUser): Omit<LinkRow, "pack"> {
  const { ctUserId } = u;
  if (ix.onLinkList.has(ctUserId)) {
    const id = ix.onLinkList.get(ctUserId) ?? null;
    return { ctUserId, kind: "onLinkList", suggestion: id, candidates: id ? [recheck(ix, id)] : [] };
  }
  if (ix.held.has(ctUserId)) {
    const candidates = (ix.input.heldCandidates.get(ctUserId) ?? []).map((id) => recheck(ix, id));
    return { ctUserId, kind: "held", suggestion: null, candidates, newHireChoice: true };
  }

  const payrollId = u.payrollId.trim();
  const own = ix.ehByPayrollId.get(payrollId);
  const idShared = (ix.ctByPayrollId.get(payrollId)?.length ?? 0) > 1;
  if (own && !idShared) return { ctUserId, kind: "alreadySynced", suggestion: own.id, candidates: [] };

  const candidates = matchCandidates(ix, u, idShared ? own : undefined);
  const [first] = candidates;
  if (!first) return { ctUserId, kind: "newHire", suggestion: null, candidates };
  if (candidates.every((c) => c.reasons.includes("linkedElsewhere"))) {
    return { ctUserId, kind: "taken", suggestion: null, candidates };
  }
  if (candidates.length === 1 && first.reasons.length === 0) {
    return { ctUserId, kind: "matched", suggestion: first.ehEmployeeId, candidates: [] };
  }
  return { ctUserId, kind: "choice", suggestion: null, candidates };
}

/** The link list's rows for everyone not already synced, plus how many EH employees nobody matched. */
export function buildLinkList(input: LinkListInput): LinkList {
  const ix = indexInput(input);

  const pack = new Map<number, PackStatus>();
  for (const a of input.assignments) {
    const p = packOf(a);
    if (PACK_ORDER.indexOf(p) > PACK_ORDER.indexOf(pack.get(a.userId) ?? "notAssigned")) pack.set(a.userId, p);
  }

  const synced = new Set(input.employeeMap.filter((m) => m.ehEmployeeId).map((m) => m.ctUserId));
  const rows = input.ctUsers
    .filter((u) => !synced.has(u.ctUserId))
    .map((u): LinkRow => ({ ...classify(ix, u), pack: pack.get(u.ctUserId) ?? "notAssigned" }));

  const active = new Set(input.ctUsers.map((u) => u.ctUserId));
  const touched = new Set(input.employeeMap.flatMap((m) => (m.ehEmployeeId && active.has(m.ctUserId) ? [m.ehEmployeeId] : [])));
  for (const r of rows) {
    if (r.suggestion) touched.add(r.suggestion);
    for (const c of r.candidates) touched.add(c.ehEmployeeId);
  }
  return { rows, ignoredEhCount: input.ehEmployees.filter((e) => !touched.has(e.id)).length };
}
