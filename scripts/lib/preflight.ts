/**
 * The read-only check before go-live (#168): predicts what each onboarding-pack
 * assignee's approval will do, given the employees already in EH and, when it
 * can be read, the sync's own database. Pure - the caller fetches all three.
 * Covers every assignee, not only approved ones, since Pre-existing employees
 * aren't approved yet.
 *
 * It mirrors the sync's first-approval path (src/sync/consumer.ts), in order:
 *
 *   - Someone left out by the field map's `rules.exclude` is never synced.
 *   - A Linked employee, or someone who has synced before, is updated (ADR-0009).
 *   - A pending link from the Link list with an EH id links them.
 *   - The Payroll ID stored at their first sync or link wins over anything
 *     copied in since (ADR-0011).
 *   - The Payroll ID is the one copied into the client's Connecteam field when
 *     `identity.externalIdFrom` names one and it's filled, else the Connecteam
 *     `userId`. A copied one that finds one EH employee links them with no EH
 *     write, but only when one of the Pre-create check's keys also agrees
 *     (email, TFN, name + DOB); otherwise they're held.
 *   - Found nobody: a "New hire, not this person" row on the Link list is
 *     created. Anyone else goes through the Pre-create check (ADR-0010): any EH
 *     employee one of those keys agrees with holds them, else they're created.
 *     Both only once their details map cleanly: until then the sync asks them
 *     to finish their details first.
 *
 * Output is ids, outcomes and key names only, never a value: no name, email,
 * TFN, bank detail or Payroll ID reaches the terminal.
 */
import type { EhEmployeePayload } from "../../src/eh/types.js";
import { hasSyncedBefore } from "../../src/sync/consumer.js";
import type { SyncOutcomeLabel } from "../../src/sync/gateway.js";
import { compareKeys, isTerminated, type MatchKey } from "../../src/sync/precheck.js";

export interface PreflightPerson {
  ctUserId: number;
  /** The Payroll ID their first sync will use: the copied value, else their `userId`. */
  payrollId: string;
  /** `payrollId` came from the client's Payroll ID field. */
  payrollIdFromField: boolean;
  /** Their details map with no issue, so the sync would write them now. */
  detailsComplete: boolean;
  /** The field map's `rules.exclude` leaves them out of the sync. */
  excluded: boolean;
  /** The mapped EH payload, as the sync would send it; read for the Pre-create check's keys. */
  payload: EhEmployeePayload;
}

/** An EH employee record as `GET /employee/unstructured` returns it. */
export type PreflightEhEmployee = { id: number; externalId?: unknown; status?: unknown } & Record<string, unknown>;

/** The sync's own database (D1), when it can be read: a live deployment. */
export interface PreflightRecords {
  employeeMap: ReadonlyArray<{
    ctUserId: number;
    ehEmployeeId: string | null;
    lastOutcome: SyncOutcomeLabel | null;
    /** Set once they're a Linked employee. */
    linkedAt: number | null;
    /** The Payroll ID stored at their first sync or link. */
    externalId: string | null;
  }>;
  /** The Link list: an EH id, or null for "New hire, not this person". */
  pendingLinks: ReadonlyArray<{ ctUserId: number; ehEmployeeId: string | null }>;
}

export interface PreflightOptions {
  /** The client's Payroll ID field is set (`identity.externalIdFrom` isn't `"userId"`), so a blank one is flagged. */
  payrollIdField: boolean;
  /** null before the first deploy, when there's no database to read. */
  records: PreflightRecords | null;
}

export type PreflightOutcome =
  | "excluded"
  | "id-used-twice"
  | "found-no-agreement"
  | "no-id"
  | "not-found"
  | "on-link-list"
  | "found"
  | "already-synced";

/** An EH employee, with the Pre-create check's keys that agree and differ with it. */
export interface PreflightMatch {
  ehEmployeeId: number;
  terminated: boolean;
  agree: MatchKey[];
  differs: MatchKey[];
}

export interface PreflightRow {
  ctUserId: number;
  outcome: PreflightOutcome;
  /** EH employees their Payroll ID or the sync's records point at. */
  eh: PreflightMatch[];
  /** For `not-found` / `no-id`: who the Pre-create check would find, so they'd be held. */
  hits: PreflightMatch[];
  /** On the Link list as "New hire, not this person": the Pre-create check is skipped. */
  newHire: boolean;
  detailsComplete: boolean;
}

/** Lower-cased and trimmed, with runs of spaces collapsed: for comparing names and emails. */
export function norm(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A Payroll ID as EH's `/externalid/{id}` lookup compares it: case and a
 * trailing space are ignored, but a leading space or zero counts (tested on
 * the demo account, 2026-11-11). The sync asks with a trimmed value.
 */
function payrollIdKey(id: string): string {
  return id.replace(/\s+$/, "").toLowerCase();
}

function externalIdOf(e: PreflightEhEmployee): string {
  return typeof e.externalId === "string" ? payrollIdKey(e.externalId) : "";
}

function matchOf(payload: EhEmployeePayload, e: PreflightEhEmployee): PreflightMatch {
  return { ehEmployeeId: e.id, terminated: isTerminated(e), ...compareKeys(payload, e) };
}

/** An EH employee known only by id (from the sync's records): no keys compared. */
function byId(id: string | null, eh: readonly PreflightEhEmployee[]): PreflightMatch[] {
  if (id === null) return [];
  const e = eh.find((x) => String(x.id) === id);
  return [{ ehEmployeeId: Number(id), terminated: e ? isTerminated(e) : false, agree: [], differs: [] }];
}

export function classifyAll(
  people: readonly PreflightPerson[],
  eh: readonly PreflightEhEmployee[],
  opts: PreflightOptions,
): PreflightRow[] {
  const mapRows = new Map(opts.records?.employeeMap.map((m) => [m.ctUserId, m]));
  const pending = new Map(opts.records?.pendingLinks.map((l) => [l.ctUserId, l.ehEmployeeId]));
  const rowOf = (p: PreflightPerson, over: Partial<PreflightRow>): PreflightRow => ({
    ctUserId: p.ctUserId,
    outcome: "not-found",
    eh: [],
    hits: [],
    newHire: false,
    detailsComplete: p.detailsComplete,
    ...over,
  });

  /** What's decided before their Payroll ID is compared, or null to go on. */
  const decidedFirst = (p: PreflightPerson): PreflightRow | null => {
    if (p.excluded) return rowOf(p, { outcome: "excluded" });
    // Linked, or synced before. Without the database, their `userId` in EH
    // says the same, since only the sync writes it there.
    const synced = mapRows.get(p.ctUserId);
    if (synced && (synced.linkedAt !== null || hasSyncedBefore(synced))) {
      return rowOf(p, { outcome: "already-synced", eh: byId(synced.ehEmployeeId, eh) });
    }
    const holdsUserId = eh.filter((e) => externalIdOf(e) === String(p.ctUserId));
    if (holdsUserId.length > 0) return rowOf(p, { outcome: "already-synced", eh: holdsUserId.map((e) => matchOf(p.payload, e)) });
    const linkTo = pending.get(p.ctUserId);
    if (linkTo) return rowOf(p, { outcome: "on-link-list", eh: byId(linkTo, eh) });
    return null;
  };

  const first = people.map(decidedFirst);
  // The Payroll ID the sync compares: the one stored at their first sync, else the mapped one.
  const payrollIds = people.map((p) => payrollIdKey(mapRows.get(p.ctUserId)?.externalId ?? p.payrollId));
  // Only people who reach the comparison can collide on a Payroll ID.
  const idCount = new Map<string, number>();
  payrollIds.forEach((id, i) => first[i] === null && idCount.set(id, (idCount.get(id) ?? 0) + 1));

  return people.map((p, i): PreflightRow => {
    const decided = first[i];
    if (decided) return decided;

    const payrollId = payrollIds[i]!;
    const holders = eh.filter((e) => externalIdOf(e) === payrollId).map((e) => matchOf(p.payload, e));
    if ((idCount.get(payrollId) ?? 0) > 1 || holders.length > 1) return rowOf(p, { outcome: "id-used-twice", eh: holders });

    // A `userId` Payroll ID in EH is handled above, so this one was copied in.
    const [holder] = holders;
    if (holder) return rowOf(p, { outcome: holder.agree.length > 0 ? "found" : "found-no-agreement", eh: [holder] });

    const newHire = pending.get(p.ctUserId) === null;
    const hits = newHire ? [] : eh.map((e) => matchOf(p.payload, e)).filter((m) => m.agree.length > 0);
    return rowOf(p, { outcome: opts.payrollIdField && !p.payrollIdFromField ? "no-id" : "not-found", hits, newHire });
  });
}

interface Group {
  mark: string;
  title: string;
  action: string;
  /** Needs a look before their approval. */
  attention: boolean;
}

/** One group per outcome, plus a held variant where the Pre-create check would hit; in print order. */
const GROUPS = {
  "id-used-twice": {
    mark: "⛔",
    title: "Payroll ID used twice",
    action: "Two Connecteam people share one Payroll ID, or EH holds it on more than one record. Fix the Payroll ID field in Connecteam (or the duplicate in EH).",
    attention: true,
  },
  "found-no-agreement": {
    mark: "⚠️ ",
    title: "Found, but nothing else agrees: will be held",
    action: "Their Payroll ID finds an EH employee whose email, TFN and name + date of birth all differ or are missing. Check the Payroll ID in Connecteam for a typo.",
    attention: true,
  },
  "no-id-held": {
    mark: "⚠️ ",
    title: "No Payroll ID, and already in EH: will be held",
    action: "Their Payroll ID field is blank, and someone in EH has the same details. Fill in the field in Connecteam with their EH Payroll ID.",
    attention: true,
  },
  "not-found-held": {
    mark: "⚠️ ",
    title: "Not found, but already in EH: will be held",
    action: "Their Payroll ID finds nobody in EH, but someone there has the same details. Check the Payroll ID in Connecteam for a typo.",
    attention: true,
  },
  "no-id": {
    mark: "ℹ️ ",
    title: "No Payroll ID: will be created",
    action: "Their Payroll ID field is blank, so they get their Connecteam ID. Fine for a new hire; if they're already in EH, fill in the field.",
    attention: false,
  },
  "not-found": {
    mark: "✅",
    title: "Not found: will be created",
    action: "Nobody in EH matches, or the Link list says they're a new hire. Approval creates them.",
    attention: false,
  },
  "on-link-list": {
    mark: "✅",
    title: "On the Link list: will be linked",
    action: "Approval links them to the EH employee confirmed in the link stage, writing only the Payroll ID.",
    attention: false,
  },
  found: {
    mark: "✅",
    title: "Found: will be linked",
    action: "Their Payroll ID finds one EH employee and another detail agrees. Approval links them, with no EH write.",
    attention: false,
  },
  "already-synced": {
    mark: "✅",
    title: "Already synced or linked",
    action: "The sync already has their EH record. Approval updates it.",
    attention: false,
  },
  excluded: {
    mark: "ℹ️ ",
    title: "Left out of the sync",
    action: "The field map's exclude rule leaves them out (for example, not paid through payroll). Approval writes nothing to EH.",
    attention: false,
  },
} satisfies Record<string, Group>;

type GroupId = keyof typeof GROUPS;

function groupOf(row: PreflightRow): GroupId {
  if (row.hits.length > 0 && (row.outcome === "no-id" || row.outcome === "not-found")) return `${row.outcome}-held`;
  return row.outcome;
}

/** Whether a row needs looking at before go-live: they'll be held, or their Payroll ID is shared. */
export function needsAttention(row: PreflightRow): boolean {
  return GROUPS[groupOf(row)].attention;
}

/** Created (or held) only once their details are complete: the sync asks them to finish first. */
function waitsForDetails(row: PreflightRow): boolean {
  return !row.detailsComplete && (row.outcome === "not-found" || row.outcome === "no-id");
}

const KEY_LABEL: Record<MatchKey, string> = { email: "email", tfn: "TFN", nameDob: "name + date of birth" };

const keyList = (keys: readonly MatchKey[]): string => keys.map((k) => KEY_LABEL[k]).join(", ");

/** `EH 40213 terminated (agrees: email; differs: TFN)`; for a Pre-create hit, `EH 40213 (email)`. */
function ehText(m: PreflightMatch, keys: "compared" | "hit" | "none"): string {
  const id = `EH ${m.ehEmployeeId}${m.terminated ? " terminated" : ""}`;
  if (keys === "none") return id;
  if (keys === "hit") return `${id} (${keyList(m.agree)})`;
  const agree = m.agree.length > 0 ? `agrees: ${keyList(m.agree)}` : "nothing agrees";
  const differs = m.differs.length > 0 ? `; differs: ${keyList(m.differs)}` : "";
  return `${id} (${agree}${differs})`;
}

function rowText(r: PreflightRow): string {
  const compared = r.outcome === "found" || r.outcome === "found-no-agreement";
  const targets = r.hits.length > 0 ? r.hits.map((h) => ehText(h, "hit")) : r.eh.map((m) => ehText(m, compared ? "compared" : "none"));
  const notes = [...(r.newHire ? ["Link list: new hire"] : []), ...(waitsForDetails(r) ? ["details incomplete"] : [])];
  return [
    `Connecteam ${r.ctUserId}`,
    ...(targets.length > 0 ? [`-> ${targets.join(", ")}`] : []),
    ...(notes.length > 0 ? [`[${notes.join("; ")}]`] : []),
  ].join(" ");
}

export interface RenderOptions {
  /** Pack assignees the users API doesn't return (archived or deleted), so not checked. */
  missing?: number;
  /** The sync's database was read (PreflightOptions.records wasn't null). */
  recordsRead: boolean;
}

export function renderPreflight(rows: readonly PreflightRow[], ehCount: number, opts: RenderOptions): string {
  const missing = opts.missing ?? 0;
  const out: string[] = [];
  out.push(`Checked ${rows.length} Connecteam ${rows.length === 1 ? "person" : "people"} in the onboarding pack against ${ehCount} EH employees.`);
  if (missing > 0) {
    out.push(`${missing} more in the pack ${missing === 1 ? "has" : "have"} no active Connecteam profile (archived or deleted), so ${missing === 1 ? "isn't" : "aren't"} checked.`);
  }
  if (!opts.recordsRead) {
    out.push("There's no database yet (before the first deploy), so this assumes nobody has synced or is on the Link list.");
  }
  out.push("");

  for (const [id, g] of Object.entries(GROUPS) as Array<[GroupId, Group]>) {
    const group = rows.filter((r) => groupOf(r) === id);
    if (group.length === 0) continue;
    out.push(`${g.mark} ${g.title} (${group.length})`);
    out.push(`   ${g.action}`);
    for (const r of group) out.push(`   - ${rowText(r)}`);
    out.push("");
  }

  if (rows.some(waitsForDetails)) {
    out.push("[details incomplete]: their pack's answers don't map to EH yet. The sync asks them to finish first, then creates (or holds) them as above.");
    out.push("");
  }

  const attention = rows.filter(needsAttention).length;
  out.push(
    attention === 0
      ? "✓ Nothing to look at."
      : `⚠ ${attention} ${attention === 1 ? "person needs" : "people need"} a look before their approval. Fix them in Connecteam, then check again.`,
  );
  return out.join("\n");
}
