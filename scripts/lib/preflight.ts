/**
 * The read-only check before go-live (#168): predicts what each onboarding-pack
 * assignee's approval will do, given the employees already in EH. Pure - the
 * caller fetches both sides. Covers every assignee, not only approved ones,
 * since Pre-existing employees aren't approved yet.
 *
 * It mirrors the sync's first-approval path (src/sync/consumer.ts):
 *
 *   - The match key is the Payroll ID copied into the client's Connecteam
 *     field when `identity.externalIdFrom` names one and it's filled, else the
 *     Connecteam `userId` (ADR-0011).
 *   - A copied key that finds one EH employee links them with no EH write, but
 *     only when one of the Pre-create check's keys also agrees (email, TFN,
 *     name + DOB); otherwise they're held.
 *   - A key that finds nobody goes through the Pre-create check (ADR-0010): any
 *     EH employee one of those keys agrees with holds them, else they're created.
 *
 * Output is ids, outcomes and key names only, never a value: no name, email,
 * TFN, bank detail or Payroll ID reaches the terminal.
 */
import type { EhEmployeePayload } from "../../src/eh/types.js";
import { compareKeys, type MatchKey } from "../../src/sync/precheck.js";

export interface PreflightPerson {
  ctUserId: number;
  /** The Payroll ID their first sync will use: the copied value, else their `userId`. */
  key: string;
  /** `key` came from the client's Payroll ID field. */
  keyFromField: boolean;
  /** The mapped EH payload, as the sync would send it; read for the Pre-create check's keys. */
  payload: EhEmployeePayload;
}

/** An EH employee record as `GET /employee/unstructured` returns it. */
export type PreflightEhEmployee = { id: number; externalId?: unknown } & Record<string, unknown>;

export type PreflightOutcome =
  | "id-used-twice"
  | "found-no-agreement"
  | "no-id"
  | "not-found"
  | "found"
  | "already-synced";

/** An EH employee one of the Pre-create check's keys agrees with. */
export interface PreflightHit {
  ehEmployeeId: number;
  agree: MatchKey[];
}

export interface PreflightRow {
  ctUserId: number;
  outcome: PreflightOutcome;
  /** EH employees holding their key. */
  ehIds: number[];
  /** For `found` / `found-no-agreement`: the keys that agree and differ with that record. */
  agree: MatchKey[];
  differs: MatchKey[];
  /** For `not-found` / `no-id`: who the Pre-create check would find, so they'd be held. */
  hits: PreflightHit[];
}

/** Lower-cased and trimmed, with runs of spaces collapsed: for comparing names and emails. */
export function norm(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function externalIdOf(e: PreflightEhEmployee): string {
  return typeof e.externalId === "string" ? e.externalId.trim() : "";
}

/** Every EH employee the Pre-create check would find for this payload. */
function preCreateHits(payload: EhEmployeePayload, eh: readonly PreflightEhEmployee[]): PreflightHit[] {
  return eh.flatMap((e) => {
    const { agree } = compareKeys(payload, e);
    return agree.length > 0 ? [{ ehEmployeeId: e.id, agree }] : [];
  });
}

/**
 * @param fromField the client's Payroll ID field is set (`identity.externalIdFrom`
 *   isn't `"userId"`), so a person whose field is blank is flagged.
 */
export function classifyAll(
  people: readonly PreflightPerson[],
  eh: readonly PreflightEhEmployee[],
  fromField: boolean,
): PreflightRow[] {
  const keyCount = new Map<string, number>();
  for (const p of people) keyCount.set(p.key, (keyCount.get(p.key) ?? 0) + 1);

  return people.map((p): PreflightRow => {
    const row: PreflightRow = { ctUserId: p.ctUserId, outcome: "not-found", ehIds: [], agree: [], differs: [], hits: [] };

    // Their `userId` in EH means the sync wrote it: they've synced before, and
    // the key stored then wins over anything copied in since (ADR-0011).
    const synced = eh.filter((e) => externalIdOf(e) === String(p.ctUserId));
    if (synced.length > 0) return { ...row, outcome: "already-synced", ehIds: synced.map((e) => e.id) };

    const holders = eh.filter((e) => externalIdOf(e) === p.key);
    row.ehIds = holders.map((e) => e.id);
    if ((keyCount.get(p.key) ?? 0) > 1 || holders.length > 1) return { ...row, outcome: "id-used-twice" };

    const [holder] = holders;
    if (holder) {
      const keys = compareKeys(p.payload, holder);
      return { ...row, outcome: keys.agree.length > 0 ? "found" : "found-no-agreement", ...keys };
    }

    const hits = preCreateHits(p.payload, eh);
    return { ...row, outcome: fromField && !p.keyFromField ? "no-id" : "not-found", hits };
  });
}

/** Whether a row needs looking at before go-live: they'll be held, or their ID is shared. */
export function needsAttention(row: PreflightRow): boolean {
  return row.outcome === "id-used-twice" || row.outcome === "found-no-agreement" || row.hits.length > 0;
}

const KEY_LABEL: Record<MatchKey, string> = { email: "email", tfn: "TFN", nameDob: "name + date of birth" };

const keyList = (keys: readonly MatchKey[]): string => keys.map((k) => KEY_LABEL[k]).join(", ");

interface Group {
  mark: string;
  title: string;
  action: string;
  rows: PreflightRow[];
}

function groups(rows: readonly PreflightRow[]): Group[] {
  const of = (o: PreflightOutcome, held?: boolean) =>
    rows.filter((r) => r.outcome === o && (held === undefined || r.hits.length > 0 === held));
  return [
    {
      mark: "⛔",
      title: "Payroll ID used twice",
      action: "Two Connecteam people share one Payroll ID, or EH holds it on more than one record. Fix the Payroll ID field in Connecteam (or the duplicate in EH).",
      rows: of("id-used-twice"),
    },
    {
      mark: "⚠️ ",
      title: "Found, but nothing else agrees: will be held",
      action: "Their Payroll ID finds an EH employee whose email, TFN and name + date of birth all differ or are missing. Check the Payroll ID in Connecteam for a typo.",
      rows: of("found-no-agreement"),
    },
    {
      mark: "⚠️ ",
      title: "No Payroll ID, and already in EH: will be held",
      action: "Their Payroll ID field is blank, and someone in EH has the same details. Fill in the field in Connecteam with their EH Payroll ID.",
      rows: of("no-id", true),
    },
    {
      mark: "⚠️ ",
      title: "Not found, but already in EH: will be held",
      action: "Their Payroll ID finds nobody in EH, but someone there has the same details. Check the Payroll ID in Connecteam for a typo.",
      rows: of("not-found", true),
    },
    {
      mark: "ℹ️ ",
      title: "No Payroll ID: will be created",
      action: "Their Payroll ID field is blank, so they get their Connecteam ID. Fine for a new hire; if they're already in EH, fill in the field.",
      rows: of("no-id", false),
    },
    {
      mark: "✅",
      title: "Not found: will be created",
      action: "Nobody in EH matches. Approval creates them.",
      rows: of("not-found", false),
    },
    {
      mark: "✅",
      title: "Found: will be linked",
      action: "Their Payroll ID finds one EH employee and another detail agrees. Approval links them, with no EH write.",
      rows: of("found"),
    },
    {
      mark: "✅",
      title: "Already synced",
      action: "EH already holds their Connecteam ID. Approval updates that record.",
      rows: of("already-synced"),
    },
  ];
}

function line(r: PreflightRow): string {
  const ct = `Connecteam ${r.ctUserId}`;
  switch (r.outcome) {
    case "id-used-twice":
      return r.ehIds.length > 0 ? `${ct} -> EH ${r.ehIds.join(", ")}` : ct;
    case "found":
    case "found-no-agreement": {
      const agree = r.agree.length > 0 ? `agrees: ${keyList(r.agree)}` : "nothing agrees";
      const differs = r.differs.length > 0 ? `; differs: ${keyList(r.differs)}` : "";
      return `${ct} -> EH ${r.ehIds.join(", ")} (${agree}${differs})`;
    }
    case "already-synced":
      return `${ct} -> EH ${r.ehIds.join(", ")}`;
    case "no-id":
    case "not-found":
      return r.hits.length === 0 ? ct : `${ct} -> ${r.hits.map((h) => `EH ${h.ehEmployeeId} (${keyList(h.agree)})`).join(", ")}`;
  }
}

/** @param missing pack assignees the users API doesn't return (archived or deleted), so not checked. */
export function renderPreflight(rows: readonly PreflightRow[], ehCount: number, missing = 0): string {
  const out: string[] = [];
  out.push(`Checked ${rows.length} Connecteam ${rows.length === 1 ? "person" : "people"} in the onboarding pack against ${ehCount} EH employees.`);
  if (missing > 0) out.push(`${missing} more in the pack ${missing === 1 ? "has" : "have"} no active Connecteam profile (archived or deleted), so ${missing === 1 ? "isn't" : "aren't"} checked.`);
  out.push("");
  for (const g of groups(rows)) {
    if (g.rows.length === 0) continue;
    out.push(`${g.mark} ${g.title} (${g.rows.length})`);
    out.push(`   ${g.action}`);
    for (const r of g.rows) out.push(`   - ${line(r)}`);
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
