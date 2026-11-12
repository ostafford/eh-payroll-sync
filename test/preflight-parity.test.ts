/**
 * The preflight's predictions must match the sync (#187). The preflight
 * (scripts/lib/preflight.ts) re-implements the first-approval decisions in
 * src/sync/consumer.ts, and nothing else ties the copy to the sync: in PR #185
 * every review round found a branch it didn't follow yet.
 *
 * Each scenario below sets up one starting state (the Connecteam people, the
 * EH employees, and the `employee_map` and `pending_link` rows) and runs it
 * both ways: through `runSyncJob` with an approval job, and through
 * `classifyAll`. Both answers are put in the same plain terms and compared, so
 * a decision changed on one side only fails here.
 */
import { describe, it, expect } from "vitest";
import { parseFieldMap, type FieldMap } from "../src/mapping/schema.js";
import { applyFieldMap, type ConnecteamUser } from "../src/mapping/apply.js";
import { runSyncJob, LINKED_DETAIL, type SyncDeps, type SyncJobOutcome } from "../src/sync/consumer.js";
import { takeBaseline } from "../src/sync/baseline.js";
import type { EmployeeLink, SyncOutcomeLabel } from "../src/sync/gateway.js";
import {
  classifyAll,
  type LinkBlock,
  type PreflightEhEmployee,
  type PreflightOutcome,
  type PreflightPerson,
  type PreflightRecords,
  type PreflightRow,
} from "../scripts/lib/preflight.js";
import { cloneUser, deps, fakeCt, fakeGateway, fieldMap } from "./support/sync-fakes.js";

const ME = 17760356;
/** Someone else in the sync's records. */
const OTHER = 999;
const FIELD = 50000001;
const COPIED = "E0042";
const STATUS_FIELD = 42920839; // Employee Status in the example map
const BIRTHDAY_FIELD = 25145118;
const JOB_TITLE_FIELD = 25145108;

const exclude = { ...fieldMap.rules, exclude: [{ customFieldId: STATUS_FIELD, values: ["PBV"] }] };
const MAPS: Record<"userId" | "field", FieldMap> = {
  userId: parseFieldMap({ ...fieldMap, rules: exclude }),
  field: parseFieldMap({ ...fieldMap, rules: exclude, identity: { ...fieldMap.identity, externalIdFrom: { customFieldId: FIELD } } }),
};

/** What an approval does, in plain terms. */
type Result =
  | "linked"
  | "held"
  | "created"
  | "updated"
  | `link blocked (${LinkBlock})`
  | "collision alert"
  | "correction"
  | "left out";

interface PackPerson {
  ctUserId?: number;
  /** The copied Payroll ID field's value ("" is blank). Only on the profile under the `field` map. */
  copiedId?: string;
  /** Their birthday doesn't map, so their details aren't complete. */
  incomplete?: boolean;
  excluded?: boolean;
}

/** An `employee_map` row. `linked`: a Linked employee, Baselined before a later edit. */
type MapRow = { ctUserId: number; ehEmployeeId: string | null; lastOutcome: SyncOutcomeLabel | null; externalId: string | null; linked?: true };

interface Scenario {
  name: string;
  map: keyof typeof MAPS;
  /** The onboarding pack, approved in this order. */
  pack: PackPerson[];
  eh: PreflightEhEmployee[];
  employeeMap?: MapRow[];
  /** The Link list: an EH id, or null for "New hire, not this person". */
  pendingLinks?: Array<{ ctUserId: number; ehEmployeeId: string | null }>;
  /** Before the first deploy: the preflight reads no database, and the sync starts from an empty one. */
  noDatabase?: true;
  /** One per pack person. */
  expected: Result[];
  /**
   * Where the preflight can't predict the sync exactly: what it says instead,
   * and why. Kept in the table so the gap stays pinned, not forgotten.
   */
  approximation?: { preflight: Result[]; why: string };
}

/** An EH employee who is the synthetic user: every Pre-create key agrees. */
const samePerson = (id: number, over: Partial<PreflightEhEmployee> = {}): PreflightEhEmployee => ({
  id,
  externalId: null,
  firstName: "Samuel",
  surname: "Rivera",
  dateOfBirth: "1992-04-07T00:00:00",
  emailAddress: "sam.rivera@example.com",
  taxFileNumber: "123456782",
  status: "Active",
  ...over,
});
/** An EH employee no Pre-create key agrees with. */
const stranger = (id: number, over: Partial<PreflightEhEmployee> = {}): PreflightEhEmployee => ({
  id,
  externalId: null,
  firstName: "Priya",
  surname: "Shah",
  dateOfBirth: "1988-01-02T00:00:00",
  emailAddress: "priya@example.com",
  taxFileNumber: "876543217",
  status: "Active",
  ...over,
});
const synced = (over: Partial<MapRow> = {}): MapRow => ({ ctUserId: ME, ehEmployeeId: "40213", lastOutcome: "ok", externalId: String(ME), ...over });

const SCENARIOS: Scenario[] = [
  // --- Payroll ID is the Connecteam userId -------------------------------
  { name: "not in EH, nobody agrees", map: "userId", pack: [{}], eh: [stranger(40377)], expected: ["created"] },
  { name: "not in EH, but the Pre-create check hits", map: "userId", pack: [{}], eh: [samePerson(40213)], expected: ["held"] },
  { name: "not in EH, details incomplete", map: "userId", pack: [{ incomplete: true }], eh: [samePerson(40213)], expected: ["correction"] },
  {
    name: "an empty database with the Connecteam ID already in EH",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213, { externalId: String(ME) })],
    noDatabase: true,
    expected: ["updated"],
  },
  {
    name: "the Connecteam ID already in EH, details incomplete",
    map: "userId",
    pack: [{ incomplete: true }],
    eh: [samePerson(40213, { externalId: String(ME) })],
    expected: ["correction"],
  },
  {
    name: "the Connecteam ID in EH on someone else's record in the sync",
    map: "userId",
    pack: [{}],
    eh: [stranger(40377, { externalId: String(ME) })],
    employeeMap: [{ ctUserId: OTHER, ehEmployeeId: "40377", lastOutcome: "ok", externalId: "P-OTHER" }],
    expected: ["collision alert"],
  },
  { name: "left out by the exclude rule", map: "userId", pack: [{ excluded: true }], eh: [samePerson(40213)], expected: ["left out"] },

  // --- synced before -----------------------------------------------------
  {
    name: "synced before",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213, { externalId: String(ME) })],
    employeeMap: [synced()],
    expected: ["updated"],
  },
  {
    name: "synced before, details incomplete",
    map: "userId",
    pack: [{ incomplete: true }],
    eh: [samePerson(40213, { externalId: String(ME) })],
    employeeMap: [synced()],
    expected: ["correction"],
  },
  {
    name: "synced before, last outcome a correction (#186)",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [samePerson(40213, { externalId: COPIED })],
    employeeMap: [synced({ lastOutcome: "correction", externalId: COPIED })],
    expected: ["updated"],
  },
  {
    name: "a stored Payroll ID with the field now blank",
    map: "field",
    pack: [{ copiedId: "" }],
    eh: [samePerson(40213, { externalId: COPIED })],
    employeeMap: [synced({ externalId: COPIED })],
    expected: ["updated"],
  },
  {
    name: "a Linked employee",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213, { externalId: String(ME) })],
    employeeMap: [synced({ linked: true })],
    expected: ["updated"],
  },
  {
    name: "a Linked employee whose last outcome is a correction",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213, { externalId: String(ME) })],
    employeeMap: [synced({ linked: true, lastOutcome: "correction" })],
    expected: ["updated"],
  },
  {
    name: "a Linked employee, details incomplete",
    map: "userId",
    pack: [{ incomplete: true }],
    eh: [samePerson(40213, { externalId: String(ME) })],
    employeeMap: [synced({ linked: true })],
    expected: ["correction"],
    approximation: {
      preflight: ["updated"],
      why: "the changed-units sync checks only the units that changed, which the preflight doesn't compute (no Baseline key)",
    },
  },

  // --- the Link list -----------------------------------------------------
  {
    name: "on the Link list",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213)],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40213" }],
    expected: ["linked"],
  },
  {
    name: "on the Link list, details incomplete (the link doesn't wait for them)",
    map: "userId",
    pack: [{ incomplete: true }],
    eh: [samePerson(40213)],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40213" }],
    expected: ["linked"],
  },
  {
    name: "on the Link list, to a record already someone else's in the sync",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213)],
    employeeMap: [{ ctUserId: OTHER, ehEmployeeId: "40213", lastOutcome: "ok", externalId: "P-OTHER" }],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40213" }],
    expected: ["link blocked (linked-in-sync)"],
  },
  {
    name: "on the Link list, with their Payroll ID on a different EH record",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213), stranger(40377, { externalId: String(ME) })],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40213" }],
    expected: ["link blocked (payroll-id-elsewhere)"],
  },
  {
    name: "on the Link list, to an EH employee who no longer exists",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213)],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40999" }],
    expected: ["link blocked (not-found)"],
  },
  {
    name: "on the Link list, to an EH employee with a different Payroll ID",
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213, { externalId: "E9999" })],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40213" }],
    expected: ["link blocked (different-payroll-id)"],
  },
  {
    name: 'on the Link list as "New hire, not this person", though the Pre-create check would hit',
    map: "userId",
    pack: [{}],
    eh: [samePerson(40213)],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: null }],
    expected: ["created"],
  },
  {
    name: "on the Link list, the target holding their Payroll ID in another case",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [samePerson(40213, { externalId: "e0042" })],
    pendingLinks: [{ ctUserId: ME, ehEmployeeId: "40213" }],
    expected: ["linked"],
  },

  // --- a Payroll ID copied into Connecteam (ADR-0011) --------------------
  { name: "a copied Payroll ID that finds them", map: "field", pack: [{ copiedId: COPIED }], eh: [samePerson(40213, { externalId: COPIED })], expected: ["linked"] },
  {
    name: "a copied Payroll ID that finds them, details incomplete (the link doesn't wait for them)",
    map: "field",
    pack: [{ copiedId: COPIED, incomplete: true }],
    eh: [samePerson(40213, { externalId: COPIED })],
    expected: ["linked"],
  },
  {
    name: "a copied Payroll ID that finds them, in another case and with a trailing space",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [samePerson(40213, { externalId: "e0042 " })],
    expected: ["linked"],
  },
  {
    name: "a copied Payroll ID that finds someone nothing agrees with",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [stranger(40213, { externalId: COPIED })],
    expected: ["held"],
  },
  {
    name: "a copied Payroll ID on someone else's record, nothing agrees",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [stranger(40377, { externalId: COPIED })],
    employeeMap: [{ ctUserId: OTHER, ehEmployeeId: "40377", lastOutcome: "ok", externalId: COPIED }],
    expected: ["held"],
  },
  {
    name: "a copied Payroll ID on someone else's record, keys agree",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [samePerson(40213, { externalId: COPIED })],
    employeeMap: [{ ctUserId: OTHER, ehEmployeeId: "40213", lastOutcome: "ok", externalId: COPIED }],
    expected: ["link blocked (linked-in-sync)"],
  },
  { name: "a copied Payroll ID that finds nobody", map: "field", pack: [{ copiedId: COPIED }], eh: [stranger(40377)], expected: ["created"] },
  {
    name: "a copied Payroll ID that finds nobody, but the Pre-create check hits",
    map: "field",
    pack: [{ copiedId: COPIED }],
    eh: [samePerson(40213)],
    expected: ["held"],
  },
  { name: "a blank Payroll ID field, not in EH", map: "field", pack: [{ copiedId: "" }], eh: [stranger(40377)], expected: ["created"] },
  {
    name: "a blank Payroll ID field, but the Pre-create check hits",
    map: "field",
    pack: [{ copiedId: "" }],
    eh: [samePerson(40213, { externalId: "P-40213" })],
    expected: ["held"],
  },
  {
    name: "one Payroll ID copied for two pack people",
    map: "field",
    pack: [{ copiedId: COPIED }, { ctUserId: 17760357, copiedId: COPIED }],
    eh: [],
    expected: ["created", "link blocked (linked-in-sync)"],
    approximation: {
      preflight: ["collision alert", "collision alert"],
      why: "the sync handles them one approval at a time: the first creates the record the second then finds",
    },
  },
];

// --- the starting state ----------------------------------------------------

function userFor(p: PackPerson, map: keyof typeof MAPS): ConnecteamUser {
  const user = cloneUser();
  user.userId = p.ctUserId ?? ME;
  if (map === "field") user.customFields.push({ customFieldId: FIELD, type: "str", name: "EH Payroll ID", value: p.copiedId ?? "" });
  if (p.incomplete) user.customFields.find((f) => f.customFieldId === BIRTHDAY_FIELD)!.value = "not-a-date";
  if (p.excluded) user.customFields.find((f) => f.customFieldId === STATUS_FIELD)!.value = [{ id: 9, value: "PBV" }];
  return user;
}

/** A Linked employee's Baseline: their pack as it was at the link, with an older job title. */
async function baselineAtLink(ctUserId: number, map: FieldMap) {
  const user = cloneUser();
  user.userId = ctUserId;
  user.customFields.find((f) => f.customFieldId === JOB_TITLE_FIELD)!.value = "Junior Support Officer";
  return takeBaseline(applyFieldMap(user, map).payload, map, "test-baseline-key", []);
}

async function storeFor(s: Scenario) {
  const store = fakeGateway();
  for (const m of s.employeeMap ?? []) {
    const row: EmployeeLink = {
      ctUserId: m.ctUserId,
      ehEmployeeId: m.ehEmployeeId,
      lastSyncedTs: 1,
      failureCycleCount: m.lastOutcome === "correction" ? 1 : 0,
      lastPayloadHash: null,
      lastOutcome: m.lastOutcome,
      externalId: m.externalId,
      ...(m.linked ? { linkedAt: 500, baseline: await baselineAtLink(m.ctUserId, MAPS[s.map]) } : {}),
    };
    store.rows.set(m.ctUserId, row);
  }
  for (const l of s.pendingLinks ?? []) store.pending.set(l.ctUserId, { ...l, confirmedAt: 1 });
  return store;
}

/** A Payroll ID as EH's `/externalid/{id}` lookup compares it: case and a trailing space ignored. */
const payrollIdKey = (v: unknown) => (typeof v === "string" ? v.replace(/\s+$/, "").toLowerCase() : "");

/**
 * A small stateful EH holding the scenario's employees. A Pre-create filter
 * returns those whose every `field eq 'value'` term matches, ignoring case.
 */
function fakeEhRecords(employees: readonly PreflightEhEmployee[]) {
  const db = employees.map((e) => ({ ...e }) as Record<string, unknown> & { id: number });
  const writes: Array<"create" | "update" | "setExternalId"> = [];
  const ok = <T>(data: T) => ({ outcome: "ok" as const, data });
  const byPayrollId = (externalId: string) => db.find((e) => payrollIdKey(e.externalId) !== "" && payrollIdKey(e.externalId) === payrollIdKey(externalId)) ?? null;
  const written = (id: number, created: boolean) => ok({ id, status: "Active", detailedStatus: null, operationType: created ? "Create" : "Update", created });
  return {
    writes,
    async getByExternalId(externalId: string) {
      return ok(byPayrollId(externalId));
    },
    async getEmployee(id: string) {
      return ok(db.find((e) => String(e.id) === id) ?? null);
    },
    async findEmployees(filter: string) {
      const terms = filter.split(" and ").map((t) => {
        const [, field, value] = /^(\w+) eq (?:datetime)?'((?:[^']|'')*)'$/.exec(t)!;
        return [field!, value!.replace(/''/g, "'").toLowerCase()] as const;
      });
      return ok(db.filter((e) => terms.every(([field, value]) => String(e[field] ?? "").trim().toLowerCase() === value)));
    },
    async setExternalId(id: string, externalId: string) {
      writes.push("setExternalId");
      db.find((e) => String(e.id) === id)!.externalId = externalId;
      return ok(null);
    },
    async upsertByExternalId(externalId: string, payload: Record<string, unknown>) {
      const found = byPayrollId(externalId);
      if (found) {
        writes.push("update");
        Object.assign(found, payload, { externalId: found.externalId });
        return written(found.id, false);
      }
      writes.push("create");
      const id = 555 + db.length;
      db.push({ ...payload, id, externalId, status: "Active" });
      return written(id, true);
    },
  };
}

// --- the two runs ------------------------------------------------------------

const BLOCK_WORDING: Record<LinkBlock, string> = {
  "linked-in-sync": "is already linked to Connecteam user",
  "payroll-id-elsewhere": "isn't theirs: the Payroll ID is on",
  "not-found": "no longer exists",
  "different-payroll-id": "has a different Payroll ID",
};

/** The sync's answer, from the job outcome, the EH writes and the notices posted. */
function syncResult(out: SyncJobOutcome, writes: readonly string[], notices: readonly string[]): string {
  const posted = (text: string) => notices.some((n) => n.includes(text));
  switch (out.status) {
    case "excluded":
      return writes.length === 0 ? "left out" : `left out, but EH written: ${writes.join(", ")}`;
    case "held":
      return writes.length === 0 && posted("⚠️ Held:") ? "held" : `held: ${writes.join(", ")} / ${notices.length} notices`;
    case "collision": {
      if (posted("landed on Employment Hero employee")) return "collision alert";
      const block = (Object.keys(BLOCK_WORDING) as LinkBlock[]).find((b) => out.reason.includes(BLOCK_WORDING[b]));
      return block && writes.length === 0 && posted("Can't link") ? `link blocked (${block})` : `collision: ${out.reason}`;
    }
    case "correction":
      return writes.length === 0 ? "correction" : `correction after ${writes.join(", ")}`;
    case "synced":
    case "follow_up":
      if (out.reason === LINKED_DETAIL) return posted("🔗") && !writes.some((w) => w !== "setExternalId") ? "linked" : `linked: ${writes.join(", ")}`;
      if (writes.length === 1 && writes[0] !== "setExternalId") return writes[0] === "create" ? "created" : "updated";
      return `${out.status}: ${writes.join(", ")}`;
    default:
      return `${out.status}: ${out.reason}`;
  }
}

async function runSync(s: Scenario): Promise<string[]> {
  const store = await storeFor(s);
  const eh = fakeEhRecords(s.eh);
  const results: string[] = [];
  for (const p of s.pack) {
    const user = userFor(p, s.map);
    const ct = fakeCt(user);
    const before = eh.writes.length;
    const out = await runSyncJob(
      { reason: "approval", ctUserId: user.userId, eventTimestamp: 1000 },
      deps({ store, ct, eh: eh as unknown as SyncDeps["eh"], fieldMap: MAPS[s.map] }),
    );
    results.push(syncResult(out, eh.writes.slice(before), ct.channels.map((c) => c.text)));
  }
  return results;
}

/** The same people as the preflight sees them (scripts/preflight.ts's listPackPeople). */
function preflightPeople(s: Scenario): PreflightPerson[] {
  const map = MAPS[s.map];
  return s.pack.map((p) => {
    const user = userFor(p, s.map);
    const mapped = applyFieldMap(user, map, {});
    return {
      ctUserId: user.userId,
      payrollId: mapped.externalId,
      payrollIdFromField: mapped.externalIdFromField,
      detailsComplete: mapped.issues.length === 0,
      excluded: p.excluded === true,
      payload: mapped.payload,
    };
  });
}

/** The sync's database as scripts/lib/preflight-records.ts reads it. */
async function preflightRecords(s: Scenario): Promise<PreflightRecords | null> {
  if (s.noDatabase) return null;
  const store = await storeFor(s);
  return {
    employeeMap: [...store.rows.values()].map((r) => ({
      ctUserId: r.ctUserId,
      ehEmployeeId: r.ehEmployeeId,
      lastOutcome: r.lastOutcome ?? null,
      linkedAt: r.linkedAt ?? null,
      externalId: r.externalId ?? null,
    })),
    pendingLinks: [...store.pending.values()].map((l) => ({ ctUserId: l.ctUserId, ehEmployeeId: l.ehEmployeeId })),
  };
}

async function classify(s: Scenario): Promise<PreflightRow[]> {
  return classifyAll(preflightPeople(s), structuredClone(s.eh), {
    payrollIdField: MAPS[s.map].identity.externalIdFrom !== "userId",
    records: await preflightRecords(s),
  });
}

/** The preflight's answer, in the same terms. */
function preflightResult(r: PreflightRow): Result {
  const waitOr = (r2: Result): Result => (r.waitsForDetails ? "correction" : r2);
  switch (r.outcome) {
    case "excluded":
      return "left out";
    case "already-synced":
    case "in-eh-not-synced":
      return waitOr("updated");
    case "on-link-list":
    case "found":
      return "linked";
    case "link-blocked":
      return `link blocked (${r.blockedBy!})`;
    case "found-no-agreement":
      return "held";
    case "id-used-twice":
      return "collision alert";
    case "not-found":
    case "no-id":
      return waitOr(r.hits.length > 0 ? "held" : "created");
  }
}

describe("the preflight predicts what the sync does (#187)", () => {
  it.each(SCENARIOS)("$name", async (s) => {
    const sync = await runSync(s);
    const preflight = (await classify(s)).map(preflightResult);

    expect(sync).toEqual(s.expected);
    if (s.approximation) expect(preflight).toEqual(s.approximation.preflight);
    else expect(preflight).toEqual(sync);
  });

  it("covers every preflight outcome and every link-step refusal", async () => {
    const OUTCOMES = {
      excluded: true,
      "id-used-twice": true,
      "found-no-agreement": true,
      "no-id": true,
      "not-found": true,
      "on-link-list": true,
      "link-blocked": true,
      found: true,
      "in-eh-not-synced": true,
      "already-synced": true,
    } satisfies Record<PreflightOutcome, true>;
    const rows = (await Promise.all(SCENARIOS.map(classify))).flat();

    expect(new Set(rows.map((r) => r.outcome))).toEqual(new Set(Object.keys(OUTCOMES)));
    expect(new Set(rows.flatMap((r) => r.blockedBy ?? []))).toEqual(new Set(Object.keys(BLOCK_WORDING)));
  });
});
