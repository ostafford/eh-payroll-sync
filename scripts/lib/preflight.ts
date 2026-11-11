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
 *     Before the first deploy there's no database, and an empty one is what
 *     the sync would start from too.
 *   - A pending link from the Link list with an EH id links them.
 *   - The Payroll ID stored at their first sync or link wins over anything
 *     copied in since (ADR-0011).
 *   - The Payroll ID is the one copied into the client's Connecteam field when
 *     `identity.externalIdFrom` names one and it's filled, else the Connecteam
 *     `userId`.
 *   - A link (from the Link list, or by a copied Payroll ID that agrees) goes
 *     through the link step, which refuses some (e.g. an EH record already
 *     someone else's) with a System alert: "Link will be blocked".
 *   - A copied one that finds one EH employee links them with no EH write, but
 *     only when one of the Pre-create check's keys also agrees (email, TFN,
 *     name + DOB); otherwise they're held.
 *   - Any other Payroll ID that finds one EH employee updates it, with no
 *     agreement check; if that record is someone else's, the write goes in and
 *     then the collision alert posts ("used twice"). A stored one means the sync wrote that record (already
 *     synced); without one, approval overwrites a record the sync has no
 *     record of, e.g. a previous deployment's after a reset.
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
  | "link-blocked"
  | "found"
  | "in-eh-not-synced"
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
  /** For `link-blocked`: which of the link step's refusals it hits. */
  blockedBy?: LinkBlock;
  /** Their details don't map yet, and the sync checks them before this write: it asks them to finish first. */
  waitsForDetails: boolean;
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

/**
 * The link step's refusals (consumer.ts `linkOnApproval`), in its order: the
 * EH record is already someone else's in employee_map; the Payroll ID is on a
 * different EH record; the EH employee doesn't exist; it carries another
 * Payroll ID. Each holds the link and posts a System alert.
 */
export type LinkBlock = "linked-in-sync" | "payroll-id-elsewhere" | "not-found" | "different-payroll-id";

/** One person on their way through {@link classifyAll}. */
interface PersonContext {
  p: PreflightPerson;
  base: PreflightRow;
  /** Decided before their Payroll ID is compared, or null to compare it. */
  decided: PreflightRow | null;
  /** The Payroll ID the sync compares, as EH compares it. */
  payrollId: string;
  /** The Payroll ID stored at their first sync or link. */
  stored: string | null;
  /** Their details don't map yet. A row's `waitsForDetails` is this where the sync checks details before writing. */
  detailsIncomplete: boolean;
  newHire: boolean;
}

export function classifyAll(
  people: readonly PreflightPerson[],
  eh: readonly PreflightEhEmployee[],
  opts: PreflightOptions,
): PreflightRow[] {
  const mapRows = new Map(opts.records?.employeeMap.map((m) => [m.ctUserId, m]));
  const pending = new Map(opts.records?.pendingLinks.map((l) => [l.ctUserId, l.ehEmployeeId]));

  // EH records employee_map already gives to someone (findByEhEmployeeId).
  // The sync checks this, not the Link list: unlike the link stage's
  // ownership in scripts/lib/link-list.ts, which counts the Link list too.
  const ownerOf = new Map<string, number>();
  for (const m of opts.records?.employeeMap ?? []) if (m.ehEmployeeId !== null) ownerOf.set(m.ehEmployeeId, m.ctUserId);
  const othersRecord = (ehEmployeeId: string, ctUserId: number): boolean => {
    const owner = ownerOf.get(ehEmployeeId);
    return owner !== undefined && owner !== ctUserId;
  };

  /** What the link step would refuse, linking `ctUserId` to `target` under `payrollId`, or null. */
  const linkBlock = (ctUserId: number, target: string, payrollId: string): LinkBlock | null => {
    if (othersRecord(target, ctUserId)) return "linked-in-sync";
    const holders = eh.filter((e) => externalIdOf(e) === payrollIdKey(payrollId));
    if (holders.some((e) => String(e.id) !== target)) return "payroll-id-elsewhere";
    if (holders.length > 0) return null; // the target already carries it
    const record = eh.find((e) => String(e.id) === target);
    if (!record) return "not-found";
    const theirs = typeof record.externalId === "string" ? record.externalId.trim() : "";
    return theirs && theirs !== payrollId ? "different-payroll-id" : null;
  };

  const contexts = people.map((p): PersonContext => {
    const base: PreflightRow = { ctUserId: p.ctUserId, outcome: "not-found", eh: [], hits: [], newHire: false, waitsForDetails: false };
    // The sync checks their details before an update or a create, but not
    // before a link or a hold by a copied Payroll ID (consumer.ts).
    const detailsIncomplete = !p.detailsComplete;
    const synced = mapRows.get(p.ctUserId);
    const linkTo = pending.get(p.ctUserId);
    // The Payroll ID the sync compares (consumer.ts's matchKey): the one stored
    // at their first sync or link, else the mapped one.
    const stored = synced?.externalId ?? null;
    const payrollId = payrollIdKey(stored ?? p.payrollId);

    // Decided before the Payroll ID is compared, in the sync's order.
    let decided: PreflightRow | null = null;
    if (p.excluded) decided = { ...base, outcome: "excluded" };
    else if (synced && (synced.linkedAt !== null || hasSyncedBefore(synced))) {
      // A Linked employee gets the changed-units sync instead (ADR-0009).
      decided = { ...base, outcome: "already-synced", eh: byId(synced.ehEmployeeId, eh), waitsForDetails: detailsIncomplete && synced.linkedAt === null };
    } else if (linkTo) {
      const blockedBy = linkBlock(p.ctUserId, linkTo, (stored ?? p.payrollId).trim());
      decided = blockedBy
        ? { ...base, outcome: "link-blocked", eh: byId(linkTo, eh), blockedBy }
        : { ...base, outcome: "on-link-list", eh: byId(linkTo, eh) };
    }
    // With no database (before the first deploy) nothing is decided here: an
    // empty database is what the sync would start from too.
    // `pending.get` is undefined off the Link list, and null for a "New hire, not this person" row.
    return { p, base, decided, payrollId, stored, detailsIncomplete, newHire: linkTo === null };
  });

  // Only people who reach the comparison can collide on a Payroll ID.
  const idCount = new Map<string, number>();
  for (const c of contexts) if (!c.decided) idCount.set(c.payrollId, (idCount.get(c.payrollId) ?? 0) + 1);

  return contexts.map(({ p, base, decided, payrollId, stored, detailsIncomplete, newHire }): PreflightRow => {
    if (decided) return decided;

    const holders = eh.filter((e) => externalIdOf(e) === payrollId).map((e) => matchOf(p.payload, e));
    if ((idCount.get(payrollId) ?? 0) > 1 || holders.length > 1) return { ...base, outcome: "id-used-twice", eh: holders };

    const [holder] = holders;
    if (holder) {
      const taken = othersRecord(String(holder.ehEmployeeId), p.ctUserId);
      // Only a Payroll ID from the client's field is checked for agreement
      // (consumer.ts gates on it); for any other key the sync updates that
      // record. A stored key means the sync wrote it (it's stored only once
      // EH accepts a write or link), so the record is theirs. Without one, the
      // sync has no record of them: e.g. a previous deployment's, after a reset.
      if (!p.payrollIdFromField) {
        // Someone else's: the update is written, then the collision alert posts.
        if (taken) return { ...base, outcome: "id-used-twice", eh: [holder] };
        return { ...base, outcome: stored !== null ? "already-synced" : "in-eh-not-synced", eh: [holder], waitsForDetails: detailsIncomplete };
      }
      // Nothing agrees: held, with no ownership check. Keys agree: the link
      // step runs, and refuses someone else's record (the target was found by
      // this Payroll ID, so that's the only refusal it can hit).
      if (holder.agree.length === 0) return { ...base, outcome: "found-no-agreement", eh: [holder] };
      if (taken) return { ...base, outcome: "link-blocked", eh: [holder], blockedBy: "linked-in-sync" };
      return { ...base, outcome: "found", eh: [holder] };
    }

    const hits = newHire ? [] : eh.map((e) => matchOf(p.payload, e)).filter((m) => m.agree.length > 0);
    const noId = opts.payrollIdField && !p.payrollIdFromField && stored === null;
    return { ...base, outcome: noId ? "no-id" : "not-found", hits, newHire, waitsForDetails: detailsIncomplete };
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
    action: "Two Connecteam people share one Payroll ID, EH holds it on more than one record, or the EH record it finds is already someone else's in the sync (approval would write over that person's record, then alert). Fix the Payroll ID field in Connecteam (or the duplicate in EH).",
    attention: true,
  },
  "link-blocked": {
    mark: "⛔",
    title: "Link will be blocked",
    action: "Approval tries to link them, but the link step refuses (reason in brackets) and posts a System alert. Fix the Link list or the Payroll ID first.",
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
  "in-eh-not-synced": {
    mark: "⚠️ ",
    title: "In EH under this Payroll ID, but never synced: approval overwrites that record",
    action: "EH already holds their Payroll ID, but the sync has no record of them (for example, after a reset). Approval writes their Connecteam details over that EH record. Check it's the same person.",
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

const KEY_LABEL: Record<MatchKey, string> = { email: "email", tfn: "TFN", nameDob: "name + date of birth" };

const BLOCK_LABEL: Record<LinkBlock, string> = {
  "linked-in-sync": "that EH record is already someone else's in the sync",
  "payroll-id-elsewhere": "their Payroll ID is on a different EH record",
  "not-found": "that EH employee no longer exists",
  "different-payroll-id": "that EH employee has a different Payroll ID",
};

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
  const notes = [
    ...(r.blockedBy ? [BLOCK_LABEL[r.blockedBy]] : []),
    ...(r.newHire ? ["Link list: new hire"] : []),
    ...(r.waitsForDetails ? ["details incomplete"] : []),
  ];
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

  if (rows.some((r) => r.waitsForDetails)) {
    out.push("[details incomplete]: their pack's answers don't map to EH yet. The sync asks them to finish first, then goes ahead as above.");
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
