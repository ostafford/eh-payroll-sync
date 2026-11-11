import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFieldMap } from "../src/mapping/schema.js";
import { applyFieldMap, type ConnecteamUser } from "../src/mapping/apply.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";
import {
  runSyncJob,
  dispatchBatch,
  handleDeadLetter,
  retryDelaySeconds,
  type SyncDeps,
} from "../src/sync/consumer.js";
import { CORRECTION_NOTICE_DEDUPE_MS } from "../src/sync/notices.js";
import { takeBaseline } from "../src/sync/baseline.js";
import type { SyncJob } from "../src/sync/job.js";
import type { Baseline, EmployeeLink, EmployeeLinkPatch, PendingLink, SyncLogEntry } from "../src/sync/gateway.js";
import type { CtResult, PayRate } from "../src/connecteam/types.js";

const fieldMap = parseFieldMap(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../clients/_example/field-map.json", import.meta.url)), "utf8"),
  ),
);

const cloneUser = (): ConnecteamUser => structuredClone(syntheticUser);

// --- fakes -----------------------------------------------------------------

function fakeGateway(
  seed: Partial<EmployeeLink> = {},
  approved = true,
): SyncDeps["store"] & {
  rows: Map<number, EmployeeLink>;
  log: SyncLogEntry[];
  counters: Map<string, number>;
  meta: Map<string, number>;
  pending: Map<number, PendingLink>;
} {
  const rows = new Map<number, EmployeeLink>();
  if (seed.ctUserId !== undefined) {
    rows.set(seed.ctUserId, {
      ctUserId: seed.ctUserId,
      ehEmployeeId: seed.ehEmployeeId ?? null,
      lastSyncedTs: seed.lastSyncedTs ?? null,
      failureCycleCount: seed.failureCycleCount ?? 0,
      lastPayloadHash: seed.lastPayloadHash ?? null,
      ...(seed.lastOutcome !== undefined ? { lastOutcome: seed.lastOutcome } : {}),
      ...(seed.externalId !== undefined ? { externalId: seed.externalId } : {}),
      ...(seed.linkedAt !== undefined ? { linkedAt: seed.linkedAt, baseline: seed.baseline ?? null } : {}),
    });
  }
  // As the real store does (ADR-0011): the first key saved is kept for good.
  const keepKey = (prev: EmployeeLink | undefined, next?: string | null) => {
    const externalId = prev?.externalId ?? next ?? null;
    return externalId !== null ? { externalId } : {};
  };
  const log: SyncLogEntry[] = [];
  const counters = new Map<string, number>();
  const meta = new Map<string, number>();
  const pending = new Map<number, PendingLink>();
  return {
    rows,
    log,
    counters,
    meta,
    pending,
    async getPendingLink(id: number) {
      return pending.get(id) ?? null;
    },
    async completeLink(patch: EmployeeLinkPatch, linkedAt: number, baseline: Baseline) {
      const prev = rows.get(patch.ctUserId);
      rows.set(patch.ctUserId, {
        ctUserId: patch.ctUserId,
        ehEmployeeId: patch.ehEmployeeId,
        lastSyncedTs: patch.lastSyncedTs,
        lastPayloadHash: patch.lastPayloadHash,
        failureCycleCount: prev?.failureCycleCount ?? 0,
        lastOutcome: patch.lastOutcome ?? null,
        linkedAt,
        baseline,
        ...keepKey(prev, patch.externalId),
      });
      pending.delete(patch.ctUserId);
    },
    async bumpCounter(key: string, delta: number) {
      counters.set(key, (counters.get(key) ?? 0) + delta);
    },
    async readMeta(keys: string[]) {
      return Object.fromEntries(keys.map((k) => [k, meta.get(k) ?? 0]));
    },
    async setMarker(key: string, value: number) {
      meta.set(key, value);
    },
    async hasBeenApproved() {
      return approved;
    },
    async findByEhEmployeeId(ehEmployeeId: string) {
      for (const r of rows.values()) {
        if (r.ehEmployeeId === ehEmployeeId) return r.ctUserId;
      }
      return null;
    },
    async getEmployeeLink(id) {
      return rows.get(id) ?? null;
    },
    async saveEmployeeLink(patch: EmployeeLinkPatch) {
      const prev = rows.get(patch.ctUserId);
      rows.set(patch.ctUserId, {
        ctUserId: patch.ctUserId,
        ehEmployeeId: patch.ehEmployeeId,
        lastSyncedTs: patch.lastSyncedTs,
        lastPayloadHash: patch.lastPayloadHash,
        failureCycleCount: prev?.failureCycleCount ?? 0,
        // As the real store does (issue #43).
        ...(patch.lastOutcome !== undefined ? { lastOutcome: patch.lastOutcome } : {}),
        ...keepKey(prev, patch.externalId),
        // A save never touches the link itself, as in the real store.
        ...(prev?.linkedAt !== undefined ? { linkedAt: prev.linkedAt, baseline: prev.baseline ?? null } : {}),
      });
    },
    async saveBaseline(id: number, baseline: Baseline) {
      rows.set(id, { ...rows.get(id)!, baseline });
    },
    async getFailureCount(id) {
      return rows.get(id)?.failureCycleCount ?? 0;
    },
    async setFailureCount(id, count) {
      const prev = rows.get(id);
      rows.set(id, {
        ctUserId: id,
        ehEmployeeId: prev?.ehEmployeeId ?? null,
        lastSyncedTs: prev?.lastSyncedTs ?? null,
        lastPayloadHash: prev?.lastPayloadHash ?? null,
        failureCycleCount: count,
        ...keepKey(prev),
      });
    },
    async appendSyncLog(entry) {
      log.push(entry);
    },
    async latestCorrectionDetail(id: number) {
      return log.filter((l) => l.ctUserId === id && l.outcome === "correction").at(-1)?.detail ?? null;
    },
  };
}

interface EhStub {
  write?: unknown;
  /** Fields to override on the echoed read-back record (e.g. simulate a value that did not persist). */
  readBackOverrides?: Record<string, unknown>;
  id?: number;
  status?: string;
  detailedStatus?: string | null;
  created?: boolean;
  /** Fields EH already holds before any write (e.g. a pay schedule set by hand). */
  current?: Record<string, unknown>;
  /** Forced result for every getByExternalId call (e.g. EH down). */
  get?: unknown;
  /** Pre-create check: rows returned for a `$filter` starting with this field name (none by default). */
  existing?: Partial<Record<"emailAddress" | "taxFileNumber" | "firstName", Array<Record<string, unknown>>>>;
  /** Forced result for every findEmployees call. */
  find?: unknown;
}

type CtFake = SyncDeps["ct"] & {
  dms: Array<{ userId: number; text: string }>;
  channels: Array<{ id: string; text: string }>;
  /** Recipient (user id or channel id) -> how many more sends to it fail as `retryable`. */
  failSends: Map<number | string, number>;
  /** Which DM attempts (1st, 2nd, ... across the fake's life) fail as `retryable`. */
  failDmAttempts: Set<number>;
};
type EhFake = SyncDeps["eh"] & {
  upserts: Array<{ externalId: string; payload: Record<string, unknown>; current?: unknown }>;
  gets: number;
  /** The Payroll ID of every `getByExternalId` call, in order. */
  getKeys: string[];
  /** Every `$filter` the Pre-create check sent. */
  finds: string[];
};

function fakeCt(user: ConnecteamUser | null, userOutcome: "ok" | "retryable" | "error" = "ok"): CtFake {
  const dms: Array<{ userId: number; text: string }> = [];
  const channels: Array<{ id: string; text: string }> = [];
  const failSends = new Map<number | string, number>();
  const failDmAttempts = new Set<number>();
  let dmAttempts = 0;
  // A failed send never reaches `dms`/`channels` - it didn't go out.
  const failing = (to: number | string): boolean => {
    const left = failSends.get(to) ?? 0;
    if (left > 0) failSends.set(to, left - 1);
    return left > 0;
  };
  const down = { outcome: "retryable", status: 429, detail: "rate limited" };
  return {
    dms,
    channels,
    failSends,
    failDmAttempts,
    async getUser() {
      if (userOutcome === "retryable") return { outcome: "retryable", status: 503, detail: "down" };
      if (userOutcome === "error") return { outcome: "error", status: 500, detail: "bad" };
      return { outcome: "ok", data: user };
    },
    async sendDirectMessage(userId: number, text: string) {
      if (failDmAttempts.has(++dmAttempts)) return down;
      if (failing(userId)) return down;
      dms.push({ userId, text });
      return { outcome: "ok", data: null };
    },
    async sendChannelMessage(id: string, text: string) {
      if (failing(id)) return down;
      channels.push({ id, text });
      return { outcome: "ok", data: null };
    },
  } as unknown as CtFake;
}

function fakeEh(stub: EhStub = {}): EhFake {
  // Like EH: a key left off a write keeps its earlier value.
  let last: Record<string, unknown> = { ...(stub.current ?? {}) };
  const upserts: Array<{ externalId: string; payload: Record<string, unknown>; current?: unknown }> = [];
  const finds: string[] = [];
  return {
    upserts,
    gets: 0,
    getKeys: [],
    finds,
    async findEmployees(filter: string) {
      finds.push(filter);
      if (stub.find) return stub.find;
      const field = filter.split(" ")[0] as keyof NonNullable<EhStub["existing"]>;
      return { outcome: "ok", data: stub.existing?.[field] ?? [] };
    },
    async upsertByExternalId(externalId: string, payload: Record<string, unknown>, current?: unknown) {
      upserts.push({ externalId, payload, current });
      last = { ...last, ...payload };
      if (stub.write) return stub.write;
      return {
        outcome: "ok",
        data: {
          id: stub.id ?? 987,
          status: stub.status ?? "Active",
          detailedStatus: stub.detailedStatus ?? null,
          operationType: "Update",
          created: stub.created ?? false,
        },
      };
    },
    async getByExternalId(this: EhFake, externalId: string) {
      this.gets++;
      this.getKeys.push(externalId);
      if (stub.get) return stub.get;
      return {
        outcome: "ok",
        data: {
          id: stub.id ?? 987,
          externalId,
          status: stub.status ?? "Active",
          ...last,
          ...(stub.readBackOverrides ?? {}),
        },
      };
    },
  } as unknown as EhFake;
}

function deps(over: Partial<SyncDeps> & { now?: () => number } = {}): SyncDeps {
  return {
    ct: (over.ct ?? fakeCt(cloneUser())) as unknown as SyncDeps["ct"],
    eh: (over.eh ?? fakeEh()) as unknown as SyncDeps["eh"],
    store: over.store ?? fakeGateway(),
    fieldMap: over.fieldMap ?? fieldMap,
    adminChannelId: "chan-1",
    baselineKey: "test-baseline-key",
    now: over.now ?? (() => 1_000_000),
  };
}

const job = (over: Partial<SyncJob> = {}): SyncJob => ({
  reason: "approval",
  ctUserId: 17760356,
  eventTimestamp: 1000,
  ...over,
});

// --- tests ---------------------------------------------------------------

describe("runSyncJob - first sync", () => {
  it("creates the Employment Hero record and links it in the store", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555, created: true });
    const d = deps({ store, eh });

    const out = await runSyncJob(job(), d);

    expect(out.status).toBe("synced");
    expect(out.ehEmployeeId).toBe("555");
    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.externalId).toBe("17760356");

    const row = store.rows.get(17760356)!;
    expect(row.ehEmployeeId).toBe("555");
    expect(row.lastSyncedTs).toBe(1000);
    expect(row.lastPayloadHash).toBeTruthy();
    expect(store.log.at(-1)).toMatchObject({ ctUserId: 17760356, outcome: "ok" });
  });
});

describe("runSyncJob - ordering and idempotency", () => {
  it("skips an event no newer than the last synced one", async () => {
    const store = fakeGateway({ ctUserId: 17760356, lastSyncedTs: 5000, ehEmployeeId: "9" });
    const eh = fakeEh();
    const out = await runSyncJob(job({ eventTimestamp: 5000 }), deps({ store, eh }));
    expect(out).toMatchObject({ status: "skipped" });
    expect(eh.upserts).toHaveLength(0);
  });

  it("processes a newer event for the same user, updating the same record", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });
    const d = deps({ store, eh });

    await runSyncJob(job({ eventTimestamp: 1000 }), d);
    const out = await runSyncJob(job({ eventTimestamp: 2000, reason: "profile_update" }), { ...d, ct: fakeCt(cloneUser()) as never });

    // Second run: payload unchanged -> no second write, still a no-op skip.
    expect(out).toMatchObject({ status: "skipped", reason: "identical to the last processed state" });
    expect(eh.upserts).toHaveLength(1);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(1000);
  });

  it("re-syncs when the mapped payload actually changed", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });

    await runSyncJob(job({ eventTimestamp: 1000 }), deps({ store, eh, ct: fakeCt(cloneUser()) as never }));

    const edited = cloneUser();
    edited.customFields.find((f) => f.customFieldId === 25145108)!.value = "Senior Support Officer";
    const out = await runSyncJob(
      job({ eventTimestamp: 2000 }),
      deps({ store, eh, ct: fakeCt(edited) as never }),
    );

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(2);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(2000);
  });
});

describe("runSyncJob - left out of the sync by choice (rules.exclude)", () => {
  const STATUS_FIELD = 42920839; // Employee Status in the example map
  const leaveOutPbv = parseFieldMap({ ...fieldMap, rules: { ...fieldMap.rules, exclude: [{ customFieldId: STATUS_FIELD, values: ["PBV"] }] } });
  const withStatus = (value: string) => {
    const u = cloneUser();
    u.customFields.find((f) => f.customFieldId === STATUS_FIELD)!.value = [{ id: 9, value }];
    return u;
  };

  it("never writes to EH or messages anyone, and records it once without the answer", async () => {
    const store = fakeGateway();
    const eh = fakeEh();
    const ct = fakeCt(withStatus("PBV"));

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never, fieldMap: leaveOutPbv }));

    expect(out).toMatchObject({ status: "excluded" });
    expect(eh.upserts).toHaveLength(0);
    expect(eh.gets).toBe(0);
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toEqual([]);
    expect(store.log).toEqual([{ ctUserId: 17760356, at: 1_000_000, outcome: "excluded", detail: "excluded: customField 42920839 (Employee Status)" }]);
    expect(store.log[0]!.detail).not.toContain("PBV");
    expect(store.rows.get(17760356)?.lastOutcome).toBe("excluded");

    // Another delivery while still left out: nothing new recorded.
    const again = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, eh, ct: ct as never, fieldMap: leaveOutPbv }));
    expect(again).toMatchObject({ status: "skipped" });
    expect(store.log).toHaveLength(1);
  });

  it("syncs everyone else as normal", async () => {
    const store = fakeGateway();
    const eh = fakeEh();
    const out = await runSyncJob(job(), deps({ store, eh, ct: fakeCt(withStatus("FullTime")) as never, fieldMap: leaveOutPbv }));
    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
  });

  it("syncs someone who stops being left out", async () => {
    const store = fakeGateway();
    const eh = fakeEh();
    await runSyncJob(job(), deps({ store, eh, ct: fakeCt(withStatus("PBV")) as never, fieldMap: leaveOutPbv }));
    const out = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, eh, ct: fakeCt(withStatus("FullTime")) as never, fieldMap: leaveOutPbv }));
    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
  });
});

describe("runSyncJob - pre-approval webhook gate (ADR-0002)", () => {
  it("skips a profile_update job for someone never yet approved, with no EH write and no message", async () => {
    const store = fakeGateway({}, false);
    const eh = fakeEh();
    const ct = fakeCt(cloneUser());

    const out = await runSyncJob(job({ reason: "profile_update" }), deps({ store, eh, ct: ct as never }));

    expect(out).toMatchObject({ status: "skipped", reason: "onboarding pack not yet approved" });
    expect(eh.upserts).toHaveLength(0);
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toEqual([]);
    expect(store.log).toEqual([]);
    // Never even looked up the employee link - the gate gets there first.
    expect(store.rows.size).toBe(0);
  });

  it("never gates an approval job - the sweep enqueuing it IS the approval signal", async () => {
    const store = fakeGateway({}, false);
    const eh = fakeEh({ id: 555, created: true });

    const out = await runSyncJob(job({ reason: "approval" }), deps({ store, eh }));

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
  });

  it("processes a profile_update job normally once the person has been approved", async () => {
    const store = fakeGateway({}, true);
    const eh = fakeEh({ id: 555, created: true });

    const out = await runSyncJob(job({ reason: "profile_update" }), deps({ store, eh }));

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
  });
});

describe("runSyncJob - Pre-create check (ADR-0010, #149)", () => {
  /** No EH record carries the Payroll ID yet, so the job would create one. */
  const NONE = { outcome: "ok", data: null };
  const inEh = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    externalId: null,
    firstName: "Samuel",
    surname: "Rivera",
    dateOfBirth: "1992-04-07T00:00:00",
    emailAddress: "sam.rivera@example.com",
    taxFileNumber: "876543217",
    status: "Active",
    ...over,
  });

  it("holds someone already in EH: no write, one admin notice, nothing to the employee", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)], firstName: [inEh(40213)] } });
    const ct = fakeCt(cloneUser());

    const out = await runSyncJob(job(), deps({ store, eh, ct }));

    expect(out).toMatchObject({ status: "held" });
    expect(eh.finds).toHaveLength(3);
    expect(eh.upserts).toHaveLength(0);
    expect(ct.dms).toHaveLength(0);
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toContain("⚠️ Held: Sam Rivera (17760356)");
    expect(ct.channels[0]!.text).toContain("EH 40213: email and name + date of birth match; TFN differs");
    expect(store.rows.get(17760356)).toMatchObject({ ehEmployeeId: null, lastOutcome: "existing_match" });
    expect(store.log).toEqual([
      { ctUserId: 17760356, at: 1_000_000, outcome: "existing_match", detail: "existing_match: EH 40213 (email, nameDob; tfn differs)" },
    ]);
    // A hold isn't a failed Correction cycle.
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(0);
  });

  it("names a terminated candidate in the notice", async () => {
    const eh = fakeEh({ get: NONE, existing: { taxFileNumber: [inEh(40377, { status: "Terminated" })] } });
    const ct = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ eh, ct }));
    expect(ct.channels[0]!.text).toContain("EH 40377 (Terminated in EH): TFN matches");
  });

  it("the daily recheck's re-run of an unchanged hold posts no notice for a week (#155)", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)] } });
    const ct = fakeCt(cloneUser());
    const runAt = (t: number) => runSyncJob(job({ eventTimestamp: t }), deps({ store, eh, ct, now: () => t }));

    await runAt(1_000_000);
    expect(await runAt(1_000_000 + DAY)).toMatchObject({ status: "held" });
    expect(await runAt(1_000_000 + 6 * DAY)).toMatchObject({ status: "held" });
    expect(ct.channels).toHaveLength(1);

    await runAt(1_000_000 + 8 * DAY);
    expect(ct.channels).toHaveLength(2); // a hold left a week gets one reminder
  });

  it("sends no second notice when the same job runs again", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)] } });
    const ct = fakeCt(cloneUser());

    await runSyncJob(job(), deps({ store, eh, ct }));
    // A redelivery after a crash that lost the rows: the check runs again, and its claim holds.
    store.rows.clear();
    const again = await runSyncJob(job(), deps({ store, eh, ct }));

    expect(again).toMatchObject({ status: "held" });
    expect(ct.channels).toHaveLength(1);
    expect(eh.upserts).toHaveLength(0);
  });

  it("runs the same profile again once the admin resolves the hold", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)] }, id: 555, created: true });

    expect(await runSyncJob(job(), deps({ store, eh }))).toMatchObject({ status: "held" });
    expect(store.rows.get(17760356)!.lastPayloadHash).toBeNull();
    // A redelivery of the same job is still skipped.
    expect(await runSyncJob(job(), deps({ store, eh }))).toMatchObject({ status: "skipped", reason: "stale or duplicate event" });

    // "New hire, not this person", then the recheck re-enqueues them with an unchanged profile.
    store.pending.set(17760356, { ctUserId: 17760356, ehEmployeeId: null, confirmedAt: 2 });
    const out = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, eh }));

    expect(out).toMatchObject({ status: "synced", ehEmployeeId: "555" });
    expect(eh.upserts).toHaveLength(1);
  });

  it("keeps a stored EH id when EH no longer finds that record by Payroll ID", async () => {
    const store = fakeGateway({ ctUserId: 17760356, ehEmployeeId: "777", lastSyncedTs: 1 });
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)] } });

    expect(await runSyncJob(job(), deps({ store, eh }))).toMatchObject({ status: "held" });
    expect(store.rows.get(17760356)).toMatchObject({ ehEmployeeId: "777", lastOutcome: "existing_match" });
  });

  it("retries a failed notice and writes no rows until it goes out", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)] } });
    const ct = fakeCt(cloneUser());
    ct.failSends.set("chan-1", 1);

    expect(await runSyncJob(job(), deps({ store, eh, ct }))).toMatchObject({ status: "retry" });
    expect(store.rows.size).toBe(0);
    expect(store.log).toHaveLength(0);

    expect(await runSyncJob(job(), deps({ store, eh, ct }))).toMatchObject({ status: "held" });
    expect(ct.channels).toHaveLength(1);
  });

  it("creates when the check is clear", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, id: 555, created: true });

    const out = await runSyncJob(job(), deps({ store, eh }));

    expect(out).toMatchObject({ status: "synced", ehEmployeeId: "555" });
    expect(eh.finds).toEqual([
      "emailAddress eq 'sam.rivera@example.com'",
      "taxFileNumber eq '123456782'",
      "firstName eq 'Samuel' and surname eq 'Rivera' and dateOfBirth eq datetime'1992-04-07T00:00:00'",
    ]);
    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.current).toBeNull();
  });

  it("skips the check for a pending link with no EH id (New hire, not this person)", async () => {
    const store = fakeGateway();
    store.pending.set(17760356, { ctUserId: 17760356, ehEmployeeId: null, confirmedAt: 1 });
    const eh = fakeEh({ get: NONE, existing: { emailAddress: [inEh(40213)] }, id: 555, created: true });

    const out = await runSyncJob(job(), deps({ store, eh }));

    expect(out.status).toBe("synced");
    expect(eh.finds).toHaveLength(0);
    expect(eh.upserts).toHaveLength(1);
  });

  it("doesn't run on an update: the Payroll ID already finds their record", async () => {
    const eh = fakeEh({ existing: { emailAddress: [inEh(40213)] } });
    expect((await runSyncJob(job(), deps({ eh }))).status).toBe("synced");
    expect(eh.finds).toHaveLength(0);
  });

  it("retries a rate-limited check without writing anything", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ get: NONE, find: { outcome: "retryable", status: 429, detail: "rate limited" } });

    const out = await runSyncJob(job(), deps({ store, eh }));

    expect(out).toMatchObject({ status: "retry" });
    expect(out.reason).toContain("rate limited");
    expect(eh.upserts).toHaveLength(0);
    expect(store.rows.size).toBe(0);
  });
});

describe("runSyncJob - link on first approval (#150, ADR-0009)", () => {
  const ME = 17760356;
  const TARGET = "40213";

  /**
   * A small stateful EH: one hand-entered employee (TARGET) and, optionally,
   * others. Records every call, so a test can prove the only write was the
   * Payroll ID.
   */
  function linkEh(employees: Record<string, Record<string, unknown>> = { [TARGET]: { externalId: null } }) {
    const db = new Map<string, Record<string, unknown>>(
      Object.entries(employees).map(([id, r]) => [id, { id: Number(id), status: "Active", ...r }]),
    );
    const calls: string[] = [];
    const puts: Array<{ id: string; body: Record<string, unknown> }> = [];
    const fail = { put: 0, reject: false };
    return {
      db,
      calls,
      puts,
      fail,
      async getByExternalId(externalId: string) {
        calls.push(`GET externalid/${externalId}`);
        return { outcome: "ok", data: [...db.values()].find((r) => r.externalId === externalId) ?? null };
      },
      async getEmployee(id: string) {
        calls.push(`GET ${id}`);
        return { outcome: "ok", data: db.get(id) ?? null };
      },
      async setExternalId(id: string, externalId: string) {
        calls.push(`PUT ${id}`);
        if (fail.reject) return { outcome: "validation", status: 400, issues: [] };
        if (fail.put > 0) {
          fail.put--;
          return { outcome: "retryable", status: 503, detail: "down" };
        }
        puts.push({ id, body: { externalId } });
        db.set(id, { ...db.get(id)!, externalId });
        return { outcome: "ok", data: null };
      },
      async upsertByExternalId() {
        calls.push("UPSERT");
        throw new Error("a link must not run the full upsert");
      },
      async findEmployees() {
        calls.push("FIND");
        throw new Error("a link must not run the Pre-create check");
      },
    };
  }

  function linking(seed: Partial<EmployeeLink> = {}) {
    const store = fakeGateway(seed);
    store.pending.set(ME, { ctUserId: ME, ehEmployeeId: TARGET, confirmedAt: 1 });
    return store;
  }

  // Both success messages on, so a test can show the link sends neither.
  const loud = parseFieldMap({ ...fieldMap, messages: { employeeSuccess: true, adminSuccess: true } });
  const run = (store: ReturnType<typeof linking>, eh: ReturnType<typeof linkEh>, ct: CtFake, j = job()) =>
    runSyncJob(j, deps({ store, eh: eh as unknown as SyncDeps["eh"], ct, fieldMap: loud }));

  it("stores the Payroll ID it linked with as their match key (ADR-0011)", async () => {
    const store = linking();
    await run(store, linkEh(), fakeCt(cloneUser()));
    expect(store.rows.get(ME)).toMatchObject({ linkedAt: 1_000_000, externalId: String(ME) });
  });

  it("sets only the Payroll ID, records the Linked employee and posts one Link notice", async () => {
    const store = linking();
    const eh = linkEh();
    const ct = fakeCt(cloneUser());

    const out = await run(store, eh, ct);

    expect(out).toEqual({ status: "synced", reason: "linked: Payroll ID only", ehEmployeeId: TARGET });
    // The only EH write is a PUT with just the Payroll ID.
    expect(eh.puts).toEqual([{ id: TARGET, body: { externalId: String(ME) } }]);
    expect(eh.calls.filter((c) => !c.startsWith("GET"))).toEqual([`PUT ${TARGET}`]);

    const row = store.rows.get(ME)!;
    expect(row).toMatchObject({ ehEmployeeId: TARGET, lastOutcome: "ok", lastSyncedTs: 1000, linkedAt: 1_000_000 });
    expect(row.lastPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.pending.has(ME)).toBe(false);
    expect(store.log).toEqual([{ ctUserId: ME, at: 1_000_000, outcome: "ok", detail: "linked: Payroll ID only" }]);

    // One Link notice; no employee DM, no Success message, no Admin success notice.
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toEqual([
      {
        id: "chan-1",
        text:
          "🔗 Sam Rivera (17760356) is now linked to Employment Hero employee 40213.\n\n" +
          "Only the Payroll ID was set. From now on, only what they change in Connecteam is synced.",
      },
    ]);
  });

  it("stores a Baseline of fingerprints and the key id, never a value", async () => {
    const store = linking();
    await run(store, linkEh(), fakeCt(cloneUser()));

    const baseline = store.rows.get(ME)!.baseline!;
    expect(baseline.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(baseline.units)).toEqual(
      expect.arrayContaining(["firstName", "taxFileNumber", "bankAccount1", "residentialAddress", "super", "taxDeclaration"]),
    );
    for (const fp of Object.values(baseline.units)) expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.stringify(baseline);
    for (const value of ["123456782", "Samuel", "Rivera", "sam.rivera@example.com", "00123456", "012345", "Coburg", "HOS0100AU"]) {
      expect(stored).not.toContain(value);
    }
  });

  it("writes nothing when the EH employee already carries this Payroll ID", async () => {
    const store = linking();
    const eh = linkEh({ [TARGET]: { externalId: String(ME) } });
    const ct = fakeCt(cloneUser());

    const out = await run(store, eh, ct);

    expect(out).toMatchObject({ status: "synced", ehEmployeeId: TARGET });
    expect(eh.puts).toEqual([]);
    expect(store.rows.get(ME)).toMatchObject({ ehEmployeeId: TARGET, linkedAt: 1_000_000 });
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toContain("is now linked");
    // Nobody here set it, so the notice doesn't say so.
    expect(ct.channels[0]!.text).toContain("Their Payroll ID was already in Employment Hero, so nothing was written.");
    expect(ct.channels[0]!.text).not.toContain("Only the Payroll ID was set");
  });

  it("alerts the admin straight away when EH rejects the Payroll ID, instead of retrying", async () => {
    const store = linking();
    const eh = linkEh();
    eh.fail.reject = true;
    const ct = fakeCt(cloneUser());

    expect(await run(store, eh, ct)).toEqual({
      status: "collision",
      reason: "can't link: EH employee 40213 rejected the Payroll ID",
    });
    expect(store.rows.has(ME)).toBe(false);
    expect(store.pending.has(ME)).toBe(true);
    expect(ct.channels[0]!.text).toContain("Employment Hero wouldn't accept their Payroll ID on employee 40213");
  });

  it("writes nothing and alerts the admin when the EH employee has a different Payroll ID", async () => {
    const store = linking();
    const eh = linkEh({ [TARGET]: { externalId: "99999" } });
    const ct = fakeCt(cloneUser());

    const out = await run(store, eh, ct);

    expect(out).toEqual({ status: "collision", reason: "can't link: EH employee 40213 has a different Payroll ID" });
    expect(eh.puts).toEqual([]);
    expect(store.rows.has(ME)).toBe(false);
    expect(store.pending.has(ME)).toBe(true);
    expect(store.log).toEqual([
      { ctUserId: ME, at: 1_000_000, outcome: "collision", detail: "can't link: EH employee 40213 has a different Payroll ID" },
    ]);
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toContain("Can't link Sam Rivera (17760356) to Employment Hero employee 40213");
    expect(ct.channels[0]!.text).toContain("already has a different Payroll ID, so it belongs to someone else");
    expect(ct.channels[0]!.text).not.toContain("99999");
  });

  it("writes nothing when the Payroll ID is already on a different EH employee", async () => {
    const store = linking();
    const eh = linkEh({ [TARGET]: { externalId: null }, "40500": { externalId: String(ME) } });
    const ct = fakeCt(cloneUser());

    expect(await run(store, eh, ct)).toMatchObject({ status: "collision" });
    expect(eh.puts).toEqual([]);
    expect(store.log[0]!.detail).toBe("can't link: EH employee 40213 isn't theirs: the Payroll ID is on EH employee 40500");
  });

  it("writes nothing when the EH employee is already linked to someone else in the sync", async () => {
    const store = linking();
    store.rows.set(555, { ctUserId: 555, ehEmployeeId: TARGET, lastSyncedTs: 1, failureCycleCount: 0, lastPayloadHash: null });
    const eh = linkEh();
    const ct = fakeCt(cloneUser());

    expect(await run(store, eh, ct)).toMatchObject({ status: "collision" });
    expect(eh.calls).toEqual([]);
    expect(ct.channels[0]!.text).toContain("already linked to Connecteam user 555");
  });

  it("writes nothing when EH no longer has the employee", async () => {
    const store = linking();
    const eh = linkEh({});
    expect(await run(store, eh, fakeCt(cloneUser()))).toMatchObject({
      status: "collision",
      reason: "can't link: EH employee 40213 no longer exists",
    });
    expect(eh.puts).toEqual([]);
  });

  it("posts a blocked link's alert once, however often the job re-runs", async () => {
    const store = linking();
    const eh = linkEh({ [TARGET]: { externalId: "99999" } });
    const ct = fakeCt(cloneUser());
    await run(store, eh, ct);
    await run(store, eh, ct, job({ eventTimestamp: 2000 }));
    expect(ct.channels).toHaveLength(1);
    expect(store.log).toHaveLength(2);
  });

  describe("a retried job writes once and sends one Link notice (ADR-0007)", () => {
    it("after a failed Link notice: the retry finds the Payroll ID set and doesn't write again", async () => {
      const store = linking();
      const eh = linkEh();
      const ct = fakeCt(cloneUser());
      ct.failSends.set("chan-1", 1);

      expect(await run(store, eh, ct)).toMatchObject({ status: "retry", reason: "connecteam send failed: link" });
      expect(store.rows.has(ME)).toBe(false);
      expect(store.pending.has(ME)).toBe(true);

      expect(await run(store, eh, ct)).toMatchObject({ status: "synced" });
      expect(eh.puts).toHaveLength(1);
      expect(ct.channels).toHaveLength(1);
      expect(store.log).toHaveLength(1);
      // The retry found the Payroll ID set, but knows this sync set it.
      expect(ct.channels[0]!.text).toContain("Only the Payroll ID was set.");
    });

    it("after a crash past the Link notice: the retry keeps its claim", async () => {
      const store = linking();
      const eh = linkEh();
      const ct = fakeCt(cloneUser());
      const complete = store.completeLink.bind(store);
      store.completeLink = vi.fn().mockRejectedValueOnce(new Error("D1 down")).mockImplementation(complete);

      await expect(run(store, eh, ct)).rejects.toThrow("D1 down");
      expect(await run(store, eh, ct)).toMatchObject({ status: "synced" });

      expect(eh.puts).toHaveLength(1);
      expect(ct.channels).toHaveLength(1);
      expect(store.rows.get(ME)).toMatchObject({ linkedAt: 1_000_000 });
    });

    it("after a failed write: nothing is recorded until the PUT goes through", async () => {
      const store = linking();
      const eh = linkEh();
      eh.fail.put = 1;
      const ct = fakeCt(cloneUser());

      expect(await run(store, eh, ct)).toMatchObject({ status: "retry" });
      expect(ct.channels).toHaveLength(0);
      expect(store.rows.has(ME)).toBe(false);

      expect(await run(store, eh, ct)).toMatchObject({ status: "synced" });
      expect(eh.puts).toHaveLength(1);
      expect(ct.channels).toHaveLength(1);
    });

    it("once linked, a redelivery or an identical edit does nothing", async () => {
      const store = linking();
      const eh = linkEh();
      const ct = fakeCt(cloneUser());
      await run(store, eh, ct);
      const calls = eh.calls.length;

      expect(await run(store, eh, ct)).toMatchObject({ status: "skipped", reason: "stale or duplicate event" });
      expect(await run(store, eh, ct, job({ reason: "profile_update", eventTimestamp: 2000 }))).toMatchObject({
        status: "skipped",
        reason: "identical to the last processed state",
      });
      expect(eh.calls).toHaveLength(calls);
      expect(ct.channels).toHaveLength(1);
    });
  });

  it("never sends a Linked employee a full-profile sync: a later edit sends only what changed", async () => {
    const store = linking();
    await run(store, linkEh(), fakeCt(cloneUser()));

    const edited = cloneUser();
    edited.customFields.find((f) => f.customFieldId === 25145108)!.value = "Team Lead";
    const eh = fakeEh({ id: Number(TARGET) });
    const out = await runSyncJob(
      job({ reason: "profile_update", eventTimestamp: 2000 }),
      deps({ store, eh, ct: fakeCt(edited), fieldMap: loud }),
    );

    expect(out).toMatchObject({ status: "synced" });
    expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
  });

  it("links a Held employee once the admin confirms their link", async () => {
    const store = linking({ ctUserId: ME, ehEmployeeId: null, lastSyncedTs: 500, lastOutcome: "existing_match" });
    const eh = linkEh();

    expect(await run(store, eh, fakeCt(cloneUser()))).toMatchObject({ status: "synced", ehEmployeeId: TARGET });
    expect(store.rows.get(ME)).toMatchObject({ linkedAt: 1_000_000, lastOutcome: "ok" });
  });

  it("links even when the pack has a mapping issue: nothing from the pack is sent", async () => {
    const user = cloneUser();
    user.customFields.find((f) => f.customFieldId === 42923222)!.value = "abc"; // a TFN that can't be mapped
    const store = linking();
    const eh = linkEh();
    const ct = fakeCt(user);

    expect(await run(store, eh, ct)).toMatchObject({ status: "synced" });
    expect(ct.dms).toEqual([]);
    expect(eh.puts).toHaveLength(1);

    // The unmapped TFN is in the Baseline, so fixing it later reads as a
    // change (sent), not a new unit (baselined without sending).
    const linkedWithGap = store.rows.get(ME)!.baseline!.units.taxFileNumber;
    const fixed = await takeBaseline(
      applyFieldMap(cloneUser(), loud).payload,
      loud,
      "test-baseline-key",
    );
    expect(linkedWithGap).toMatch(/^[0-9a-f]{64}$/);
    expect(fixed.units.taxFileNumber).not.toBe(linkedWithGap);
  });

  it("ignores a pending link for someone already synced the normal way", async () => {
    const store = linking({ ctUserId: ME, ehEmployeeId: "987", lastSyncedTs: 500, lastOutcome: "ok" });
    const eh = fakeEh();

    const out = await runSyncJob(job(), deps({ store, eh }));

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
    expect(store.rows.get(ME)!.linkedAt).toBeUndefined();
  });

  it("ignores a pending link for someone synced before whose last edit needed a Correction (#186)", async () => {
    const store = linking({ ctUserId: ME, ehEmployeeId: "987", lastSyncedTs: 500, lastOutcome: "correction", externalId: String(ME) });
    const eh = fakeEh();

    expect((await runSyncJob(job(), deps({ store, eh }))).status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
    expect(store.rows.get(ME)!.linkedAt).toBeUndefined();
  });
});

describe("runSyncJob - changed-units sync for Linked employees (#151, ADR-0009)", () => {
  const ME = 17760356;
  const LINKED_AT = 500_000;

  /** A Linked employee whose Baseline is the pack as it was at the link. */
  async function linked(pack: ConnecteamUser = cloneUser(), map = fieldMap, payRate?: PayRate) {
    const mapped = applyFieldMap(pack, map, { payRate });
    const unmapped = mapped.issues.map((i) => i.ehField);
    const baseline = await takeBaseline(mapped.payload, map, "test-baseline-key", unmapped);
    return fakeGateway({
      ctUserId: ME,
      ehEmployeeId: "40213",
      lastSyncedTs: 1000,
      lastOutcome: "ok",
      externalId: String(ME),
      lastPayloadHash: "hash-at-link",
      linkedAt: LINKED_AT,
      baseline,
    });
  }

  const edit = (customFieldId: number, value: string) => {
    const user = cloneUser();
    user.customFields.find((f) => f.customFieldId === customFieldId)!.value = value;
    return user;
  };
  const update = job({ reason: "profile_update", eventTimestamp: 2000 });

  it("sends only the field that changed", async () => {
    const store = await linked();
    const eh = fakeEh({ id: 40213 });

    const out = await runSyncJob(update, deps({ store, eh, ct: fakeCt(edit(25145108, "Team Lead")) }));

    expect(out).toMatchObject({ status: "synced", ehEmployeeId: "40213" });
    expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
  });

  it("sends bank account 1 whole, its constants included, when one value in it changed", async () => {
    const store = await linked();
    const eh = fakeEh({ id: 40213 });

    await runSyncJob(update, deps({ store, eh, ct: fakeCt(edit(42923223, "063-000")) }));

    expect(eh.upserts.map((u) => u.payload)).toEqual([
      {
        bankAccount1_AccountName: "Samuel Rivera",
        bankAccount1_BSB: "063000",
        bankAccount1_AccountNumber: "00123456",
        bankAccount1_AllocatedPercentage: 100,
      },
    ]);
  });

  it("never sends an unchanged unit, even when EH holds a different value", async () => {
    const store = await linked();
    const eh = fakeEh({ id: 40213, current: { firstName: "Sam", residentialPostCode: "3000" } });

    await runSyncJob(update, deps({ store, eh, ct: fakeCt(edit(25145108, "Team Lead")) }));

    expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
  });

  it("skips an edit that changes no unit, with no EH call, and stores the new hash", async () => {
    const store = await linked();
    const eh = fakeEh({ id: 40213 });
    const ct = fakeCt(cloneUser());

    const out = await runSyncJob(update, deps({ store, eh, ct }));

    expect(out).toEqual({ status: "skipped", reason: "no change since the link" });
    expect(eh.upserts).toHaveLength(0);
    expect(eh.gets).toBe(0);
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toEqual([]);
    expect(store.rows.get(ME)!.lastPayloadHash).not.toBe("hash-at-link");
    expect(store.log).toEqual([]);
  });

  it("keeps the outcome it had when an edit changes no unit", async () => {
    const store = await linked();
    store.rows.set(ME, { ...store.rows.get(ME)!, lastOutcome: "follow_up" });

    await runSyncJob(update, deps({ store, eh: fakeEh({ id: 40213 }), ct: fakeCt(cloneUser()) }));

    expect(store.rows.get(ME)!.lastOutcome).toBe("follow_up");
  });

  it("re-baselines a Linked employee whose Baseline can't be read, sending nothing", async () => {
    const store = fakeGateway({ ctUserId: ME, ehEmployeeId: "40213", lastSyncedTs: 1000, lastOutcome: "ok", linkedAt: LINKED_AT });
    expect(store.rows.get(ME)!.baseline).toBeNull();
    const eh = fakeEh({ id: 40213 });

    const out = await runSyncJob(update, deps({ store, eh, ct: fakeCt(edit(25145108, "Team Lead")) }));

    expect(out).toEqual({ status: "skipped", reason: "Baseline unreadable: re-baselined, nothing sent" });
    expect(eh.upserts).toHaveLength(0);
    expect(eh.gets).toBe(0);

    // From the new Baseline, only a later change is sent.
    const later = edit(25145108, "Team Lead");
    later.customFields.find((f) => f.customFieldId === 42708536)!.value = "Partner";
    await runSyncJob(job({ reason: "profile_update", eventTimestamp: 3000 }), deps({ store, eh, ct: fakeCt(later) }));
    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.payload).not.toHaveProperty("jobTitle");
    expect(eh.upserts[0]!.payload).toMatchObject({ emergencyContact1_Relationship: "Partner" });
  });

  describe("the Baseline moves only for a unit EH accepted", () => {
    const thenEdit = (user: ConnecteamUser) => {
      user.customFields.find((f) => f.customFieldId === 42708536)!.value = "Partner";
      return user;
    };
    const later = job({ reason: "profile_update", eventTimestamp: 3000 });

    it("an accepted unit isn't sent again by the next edit", async () => {
      const store = await linked();
      await runSyncJob(update, deps({ store, eh: fakeEh({ id: 40213 }), ct: fakeCt(edit(25145108, "Team Lead")) }));

      const eh = fakeEh({ id: 40213 });
      await runSyncJob(later, deps({ store, eh, ct: fakeCt(thenEdit(edit(25145108, "Team Lead"))) }));

      expect(Object.keys(eh.upserts[0]!.payload)).not.toContain("jobTitle");
      expect(eh.upserts[0]!.payload).toMatchObject({ emergencyContact1_Relationship: "Partner" });
    });

    it("a unit EH rejected is sent again by the next edit", async () => {
      const store = await linked();
      const rejected = {
        outcome: "validation",
        status: 400,
        issues: [{ field: "jobTitle", reason: "too long" }],
      };
      const first = await runSyncJob(
        update,
        deps({ store, eh: fakeEh({ write: rejected }), ct: fakeCt(edit(25145108, "Team Lead")) }),
      );
      expect(first.status).toBe("correction");

      const eh = fakeEh({ id: 40213 });
      await runSyncJob(later, deps({ store, eh, ct: fakeCt(thenEdit(edit(25145108, "Team Lead"))) }));

      expect(eh.upserts[0]!.payload).toMatchObject({ jobTitle: "Team Lead", emergencyContact1_Relationship: "Partner" });
    });
  });

  describe("mapping issues count only inside changed units", () => {
    const TFN = 42923222;
    const badTfn = (user: ConnecteamUser) => {
      user.customFields.find((f) => f.customFieldId === TFN)!.value = "abc";
      return user;
    };

    it("an issue in an unchanged unit doesn't block a changed one", async () => {
      const store = await linked(badTfn(cloneUser()));
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(badTfn(edit(25145108, "Team Lead")));

      const out = await runSyncJob(update, deps({ store, eh, ct }));

      expect(out.status).toBe("synced");
      expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
      expect(ct.dms).toEqual([]);
    });

    it("an issue inside a changed unit is a Correction, and nothing is sent", async () => {
      const store = await linked();
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(badTfn(cloneUser()));

      const out = await runSyncJob(update, deps({ store, eh, ct }));

      expect(out.status).toBe("correction");
      expect(eh.upserts).toHaveLength(0);
      expect(ct.dms).toHaveLength(1);
      expect(ct.dms[0]!.userId).toBe(ME);
    });
  });

  describe("the read-back compares only what was sent", () => {
    it("a sent field that didn't stick is a Correction", async () => {
      const store = await linked();
      const eh = fakeEh({ id: 40213, readBackOverrides: { jobTitle: "Support Officer" } });

      const out = await runSyncJob(update, deps({ store, eh, ct: fakeCt(edit(25145108, "Team Lead")) }));

      expect(out).toMatchObject({ status: "correction", reason: "correction: jobTitle" });
    });

    it("a different value EH holds in a unit that wasn't sent is not a Correction", async () => {
      const store = await linked();
      const eh = fakeEh({ id: 40213, readBackOverrides: { firstName: "Sam", residentialSuburb: "Elsewhere" } });

      const out = await runSyncJob(update, deps({ store, eh, ct: fakeCt(edit(25145108, "Team Lead")) }));

      expect(out.status).toBe("synced");
    });
  });

  describe("follow-ups count only inside changed units", () => {
    const pick = (user: ConnecteamUser, customFieldId: number, value: string) => {
      user.customFields.find((f) => f.customFieldId === customFieldId)!.value = [{ id: 0, value }];
      return user;
    };
    const nonResident = (user: ConnecteamUser) => pick(pick(user, 42923315, "No"), 42923276, "No");

    it("a follow-up in a changed unit is posted, and the unit is sent", async () => {
      const store = await linked();
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(nonResident(cloneUser()));

      const out = await runSyncJob(update, deps({ store, eh, ct }));

      expect(out.status).toBe("follow_up");
      expect(eh.upserts[0]!.payload).toMatchObject({ australianResident: false });
      expect(ct.channels).toHaveLength(1);
      expect(ct.channels[0]!.text).toContain("not an Australian resident for tax");
    });

    it("a follow-up in an unchanged unit isn't posted again", async () => {
      const store = await linked(nonResident(cloneUser()));
      const ct = fakeCt(nonResident(edit(25145108, "Team Lead")));

      const out = await runSyncJob(update, deps({ store, eh: fakeEh({ id: 40213 }), ct }));

      expect(out.status).toBe("synced");
      expect(ct.channels).toEqual([]);
    });
  });

  describe("the pay-run set", () => {
    const rateMap = parseFieldMap({
      ...fieldMap,
      employmentHero: {
        businessId: "555455",
        defaults: { paySchedule: "Weekly", primaryLocation: "Connecteam", primaryPayCategory: "Permanent Ordinary Hours" },
        perEmployeeRate: { source: "connecteamPayRate" },
      },
    });
    const hourly = (defaultRate: number): PayRate => ({ rateType: "hourly", defaultRate, isDefaultRateEnabled: true });
    const withRate = (user: ConnecteamUser, rate: PayRate) => {
      const ct = fakeCt(user);
      (ct as unknown as { getPayRate: () => Promise<unknown> }).getPayRate = async () => ({ outcome: "ok", data: rate });
      return ct;
    };
    /** What a payroll admin set by hand in EH before the link. */
    const handSet = { paySchedule: "Fortnightly", primaryLocation: "Head Office", primaryPayCategory: "Salary", rate: 40, rateUnit: "Hourly" };

    it("isn't sent when the pay rate didn't change", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const eh = fakeEh({ id: 40213, current: handSet });

      await runSyncJob(update, deps({ store, eh, fieldMap: rateMap, ct: withRate(edit(25145108, "Team Lead"), hourly(40)) }));

      expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
    });

    it("is sent when the pay rate changed, leaving off the defaults EH already holds", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const eh = fakeEh({ id: 40213, current: handSet });

      const out = await runSyncJob(update, deps({ store, eh, fieldMap: rateMap, ct: withRate(cloneUser(), hourly(45)) }));

      expect(out.status).toBe("synced");
      expect(eh.upserts.map((u) => u.payload)).toEqual([{ rate: 45, rateUnit: "Hourly" }]);
    });

    it("an unsupported rate is a follow-up: the other changes go, the pay-run set doesn't, and its Baseline stays", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const daily: PayRate = { rateType: "daily", defaultRate: 300, isDefaultRateEnabled: true };
      const ct = withRate(edit(25145108, "Team Lead"), daily);
      // No rate in EH either, so nothing completes the set (#102).
      const { rate: _r, rateUnit: _u, ...noRate } = handSet;
      const eh = fakeEh({ id: 40213, current: noRate });

      const out = await runSyncJob(update, deps({ store, eh, fieldMap: rateMap, ct }));

      expect(out.status).toBe("follow_up");
      expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
      expect(ct.channels).toHaveLength(1);

      // Back on the rate the Baseline holds: nothing about pay to send.
      const after = fakeEh({ id: 40213, current: handSet });
      await runSyncJob(
        job({ reason: "profile_update", eventTimestamp: 3000 }),
        deps({ store, eh: after, fieldMap: rateMap, ct: withRate(edit(42708536, "Partner"), hourly(40)) }),
      );
      expect(Object.keys(after.upserts[0]!.payload)).not.toContain("rate");
    });

    it("a pay-run config gap doesn't block an unrelated edit: the Connecteam rate didn't change", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const { primaryLocation: _gone, ...defaults } = rateMap.employmentHero.defaults!;
      const broken = parseFieldMap({ ...rateMap, employmentHero: { ...rateMap.employmentHero, defaults } });
      const ct = withRate(edit(25145108, "Team Lead"), hourly(40));
      const eh = fakeEh({ id: 40213 });

      const out = await runSyncJob(update, deps({ store, eh, fieldMap: broken, ct }));

      expect(out.status).toBe("synced");
      expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
    });

    it("an unsupported rate with nothing else changed makes no EH write", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const daily: PayRate = { rateType: "daily", defaultRate: 300, isDefaultRateEnabled: true };
      const eh = fakeEh({ id: 40213 });

      const out = await runSyncJob(update, deps({ store, eh, fieldMap: rateMap, ct: withRate(cloneUser(), daily) }));

      expect(out.status).toBe("follow_up");
      expect(eh.upserts).toHaveLength(0);
    });

    it("an unsupported rate sends no pay-run default, even when EH's rate would complete the set", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const daily: PayRate = { rateType: "daily", defaultRate: 300, isDefaultRateEnabled: true };
      const { primaryLocation: _p, ...lacksLocation } = handSet;
      const eh = fakeEh({ id: 40213, current: lacksLocation });

      const out = await runSyncJob(update, deps({ store, eh, fieldMap: rateMap, ct: withRate(cloneUser(), daily) }));

      expect(out.status).toBe("follow_up");
      expect(eh.upserts).toHaveLength(0);
    });

    it("isn't sent when only a field-map default changed, so a rate set by hand in EH survives", async () => {
      const store = await linked(cloneUser(), rateMap, hourly(40));
      const eh = fakeEh({ id: 40213, current: { ...handSet, rate: 38 } });
      const reconfigured = parseFieldMap({
        ...rateMap,
        employmentHero: { ...rateMap.employmentHero, defaults: { ...rateMap.employmentHero.defaults, paySchedule: "Monthly" } },
      });

      await runSyncJob(
        update,
        deps({ store, eh, fieldMap: reconfigured, ct: withRate(edit(25145108, "Team Lead"), hourly(40)) }),
      );

      expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
    });
  });
});

describe("runSyncJob - Linked employees: cleared fields, new fields and key changes (#152, ADR-0009)", () => {
  const ME = 17760356;
  const JOB_TITLE = 25145108;
  const RELATIONSHIP = 42708536;

  async function linked(pack: ConnecteamUser = cloneUser(), map = fieldMap, key = "test-baseline-key") {
    const mapped = applyFieldMap(pack, map);
    const baseline = await takeBaseline(mapped.payload, map, key, mapped.issues.map((i) => i.ehField));
    return fakeGateway({
      ctUserId: ME,
      ehEmployeeId: "40213",
      lastSyncedTs: 1000,
      lastOutcome: "ok",
      externalId: String(ME),
      lastPayloadHash: "hash-at-link",
      linkedAt: 500_000,
      baseline,
    });
  }

  const set = (user: ConnecteamUser, customFieldId: number, value: string) => {
    user.customFields.find((f) => f.customFieldId === customFieldId)!.value = value;
    return user;
  };
  const edit = (ts: number) => job({ reason: "profile_update", eventTimestamp: ts });

  describe("a cleared field", () => {
    it("sends nothing to EH, posts one follow-up to clear it by hand, and stays ok", async () => {
      const store = await linked();
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(set(cloneUser(), JOB_TITLE, ""));

      await runSyncJob(edit(2000), deps({ store, eh, ct }));

      expect(eh.upserts).toHaveLength(0);
      expect(ct.dms).toEqual([]);
      expect(ct.channels).toHaveLength(1);
      expect(ct.channels[0]!.text).toContain("jobTitle");
      expect(ct.channels[0]!.text).toMatch(/clear it by hand in Employment Hero/i);
      expect(store.rows.get(ME)!.lastOutcome).toBe("ok");
    });

    it("isn't posted again by a later edit, which sends only what it changed", async () => {
      const store = await linked();
      await runSyncJob(edit(2000), deps({ store, eh: fakeEh({ id: 40213 }), ct: fakeCt(set(cloneUser(), JOB_TITLE, "")) }));

      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(set(set(cloneUser(), JOB_TITLE, ""), RELATIONSHIP, "Partner"));
      await runSyncJob(edit(3000), deps({ store, eh, ct }));

      expect(ct.channels).toEqual([]);
      expect(eh.upserts).toHaveLength(1);
      expect(eh.upserts[0]!.payload).toMatchObject({ emergencyContact1_Relationship: "Partner" });
      expect(eh.upserts[0]!.payload).not.toHaveProperty("jobTitle");
    });

    it("leaves a group now partly blank unsent, even with another value in it changed", async () => {
      const store = await linked();
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(set(set(cloneUser(), RELATIONSHIP, ""), 42708535, "Alex Rivera"));

      await runSyncJob(edit(2000), deps({ store, eh, ct }));

      expect(eh.upserts).toHaveLength(0);
      expect(ct.channels).toHaveLength(1);
      expect(ct.channels[0]!.text).toContain("emergencyContact1_Relationship");
      // The rest of the group wasn't sent either, so an edit to it is named too.
      expect(ct.channels[0]!.text).toMatch(/not sent[^]*emergencyContact1_Name/);
    });

    it("keeps an open follow-up open: the cleared-field notice doesn't resolve it", async () => {
      const store = await linked();
      store.rows.set(ME, { ...store.rows.get(ME)!, lastOutcome: "follow_up" });

      await runSyncJob(edit(2000), deps({ store, eh: fakeEh({ id: 40213 }), ct: fakeCt(set(cloneUser(), JOB_TITLE, "")) }));

      expect(store.rows.get(ME)!.lastOutcome).toBe("follow_up");
    });
  });

  describe("a field added to the field map after the link", () => {
    const before = parseFieldMap({ ...fieldMap, fields: fieldMap.fields.filter((f) => f.eh !== "jobTitle") });

    it("is baselined without being sent", async () => {
      const store = await linked(cloneUser(), before);
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(cloneUser());

      const out = await runSyncJob(edit(2000), deps({ store, eh, ct }));

      expect(out.status).toBe("skipped");
      expect(eh.upserts).toHaveLength(0);
      expect(ct.channels).toEqual([]);

      // Once baselined, a real edit to it is sent.
      const after = fakeEh({ id: 40213 });
      await runSyncJob(edit(3000), deps({ store, eh: after, ct: fakeCt(set(cloneUser(), JOB_TITLE, "Team Lead")) }));
      expect(after.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
    });

    it("is told apart from a field that was blank at the link and is now filled in, which is sent", async () => {
      const store = await linked(set(cloneUser(), JOB_TITLE, ""));
      const eh = fakeEh({ id: 40213 });

      await runSyncJob(edit(2000), deps({ store, eh, ct: fakeCt(set(cloneUser(), JOB_TITLE, "Team Lead")) }));

      expect(eh.upserts.map((u) => u.payload)).toEqual([{ jobTitle: "Team Lead" }]);
    });
  });

  describe("a Baseline made with a different key", () => {
    it("is re-baselined with nothing pushed, and one admin line goes out for the new key", async () => {
      const store = await linked(cloneUser(), fieldMap, "lost-key");
      // A second Linked employee on the same lost key, in the same store.
      const other = store.rows.get(ME)!;
      store.rows.set(ME + 1, { ...other, ctUserId: ME + 1, externalId: String(ME + 1) });
      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(set(cloneUser(), JOB_TITLE, "Team Lead"));
      const otherCt = fakeCt({ ...set(cloneUser(), JOB_TITLE, "Team Lead"), userId: ME + 1 });

      const out = await runSyncJob(edit(2000), deps({ store, eh, ct }));
      await runSyncJob(job({ ctUserId: ME + 1, reason: "profile_update", eventTimestamp: 2000 }), deps({ store, eh, ct: otherCt }));

      expect(out.status).toBe("skipped");
      expect(eh.upserts).toHaveLength(0);
      expect([...ct.dms, ...otherCt.dms]).toEqual([]);
      expect(otherCt.channels).toEqual([]);
      expect(ct.channels).toHaveLength(1);
      expect(ct.channels[0]!.text).toContain("Rotating keys");
    });

    it("after re-baselining, a real edit pushes only that unit", async () => {
      const store = await linked(cloneUser(), fieldMap, "lost-key");
      await runSyncJob(edit(2000), deps({ store, eh: fakeEh({ id: 40213 }), ct: fakeCt(set(cloneUser(), JOB_TITLE, "Team Lead")) }));

      const eh = fakeEh({ id: 40213 });
      const ct = fakeCt(set(set(cloneUser(), JOB_TITLE, "Team Lead"), RELATIONSHIP, "Partner"));
      await runSyncJob(edit(3000), deps({ store, eh, ct }));

      expect(eh.upserts).toHaveLength(1);
      expect(eh.upserts[0]!.payload).toMatchObject({ emergencyContact1_Relationship: "Partner" });
      expect(eh.upserts[0]!.payload).not.toHaveProperty("jobTitle");
    });
  });
});

describe("runSyncJob - the match key is fixed at first sync (#166, ADR-0011)", () => {
  // A synced person whose stored key differs from what the map gives now: the
  // Connecteam field it came from was edited after their first sync.
  const synced = (over: Partial<EmployeeLink> = {}) =>
    fakeGateway({
      ctUserId: 17760356,
      ehEmployeeId: "987",
      lastSyncedTs: 500,
      lastPayloadHash: "older",
      lastOutcome: "ok",
      externalId: "P-100",
      ...over,
    });

  it("looks up, writes and reads back by the stored key, and keeps it", async () => {
    const store = synced();
    const eh = fakeEh({ id: 987 });

    const out = await runSyncJob(job(), deps({ store, eh }));

    expect(out.status).toBe("synced");
    expect(eh.getKeys).toEqual(["P-100", "P-100"]);
    expect(eh.upserts.map((u) => u.externalId)).toEqual(["P-100"]);
    expect(eh.finds).toEqual([]);
    expect(store.rows.get(17760356)!.externalId).toBe("P-100");
  });

  const CHANGED =
    "The Payroll ID for Sam Rivera (17760356) changed in Connecteam; the sync still uses the old one. Change it in both places by hand if that's intended.";

  it("alerts the admin once, and still syncs by the stored key", async () => {
    const store = synced();
    const ct = fakeCt(cloneUser());

    const out = await runSyncJob(job(), deps({ store, ct }));

    expect(out.status).toBe("synced");
    expect(ct.channels).toEqual([{ id: "chan-1", text: CHANGED }]);
    expect(ct.dms).toHaveLength(0);
  });

  it("sends no alert when the mapped key is the stored one", async () => {
    const ct = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ store: synced({ externalId: "17760356" }), ct }));
    expect(ct.channels).toHaveLength(0);
  });

  it("a retried job doesn't send a second alert for the same change (ADR-0007)", async () => {
    const store = synced();
    const ct = fakeCt(cloneUser());
    const down = fakeEh({ get: { outcome: "retryable", status: 503, detail: "down" } });

    expect(await runSyncJob(job(), deps({ store, ct, eh: down }))).toMatchObject({ status: "retry" });
    expect(await runSyncJob(job(), deps({ store, ct }))).toMatchObject({ status: "synced" });

    expect(ct.channels).toHaveLength(1);
  });

  it("a later edit sends no second alert for the same new value", async () => {
    const store = synced();
    const ct = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ store, ct }));

    const edited = cloneUser();
    edited.customFields.find((f) => f.customFieldId === 25145108)!.value = "Senior Support Officer";
    const out = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: fakeCt(edited) }));

    expect(out.status).toBe("synced");
    expect(ct.channels).toHaveLength(1);
  });

  it("a failed alert releases its claim and retries the job before anything is written", async () => {
    const store = synced();
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ id: 987 });
    ct.failSends.set("chan-1", 1);

    expect(await runSyncJob(job(), deps({ store, ct, eh }))).toMatchObject({ status: "retry" });
    expect(eh.upserts).toHaveLength(0);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(500);

    expect(await runSyncJob(job(), deps({ store, ct, eh }))).toMatchObject({ status: "synced" });
    expect(ct.channels).toEqual([{ id: "chan-1", text: CHANGED }]);
  });

  it("stores the key at a first sync EH accepts", async () => {
    const store = fakeGateway();
    await runSyncJob(job(), deps({ store, eh: fakeEh({ id: 555, created: true }) }));
    expect(store.rows.get(17760356)!.externalId).toBe("17760356");
  });

  it("stores no key when EH accepted nothing: the next attempt still uses the mapped one", async () => {
    const bad = cloneUser();
    bad.customFields.find((f) => f.customFieldId === 25145118)!.value = "not-a-date";
    const store = fakeGateway();
    const eh = fakeEh();

    expect(await runSyncJob(job(), deps({ store, eh, ct: fakeCt(bad) }))).toMatchObject({ status: "correction" });
    expect(store.rows.get(17760356)!.externalId).toBeUndefined();

    const held = fakeGateway();
    const none = { outcome: "ok", data: null };
    const found = [{ id: 40213, firstName: "Samuel", surname: "Rivera", emailAddress: "sam.rivera@example.com" }];
    await runSyncJob(job(), deps({ store: held, eh: fakeEh({ get: none, existing: { emailAddress: found } }) }));
    expect(held.rows.get(17760356)).toMatchObject({ lastOutcome: "existing_match" });
    expect(held.rows.get(17760356)!.externalId).toBeUndefined();
  });
});

describe("runSyncJob - Payroll ID from a Connecteam field (#167, ADR-0011)", () => {
  const ME = 17760356;
  const FIELD = 50000001;
  const COPIED = "007421";
  const byField = parseFieldMap({ ...fieldMap, identity: { externalIdFrom: { customFieldId: FIELD } } });

  /** The synthetic user with their EH Payroll ID copied into Connecteam (blank: not filled in). */
  const withCopiedId = (value = COPIED): ConnecteamUser => {
    const user = cloneUser();
    user.customFields.push({ customFieldId: FIELD, type: "str", name: "EH Payroll ID", value });
    return user;
  };

  /** A hand-entered EH employee: the same person as the synthetic user unless overridden. */
  const handEntered = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    externalId: COPIED,
    status: "Active",
    firstName: "Samuel",
    surname: "Rivera",
    dateOfBirth: "1992-04-07T00:00:00",
    emailAddress: "sam.rivera@example.com",
    taxFileNumber: "123456782",
    ...over,
  });

  /**
   * A small stateful EH holding the given employees. Records every call; a
   * Pre-create filter returns the employees whose field equals the filter's
   * first value.
   */
  function payrollEh(...employees: Array<Record<string, unknown>>) {
    const calls: string[] = [];
    const filterValue = (filter: string) => /eq '((?:[^']|'')*)'/.exec(filter)![1]!.replace(/''/g, "'");
    return {
      calls,
      async getByExternalId(externalId: string) {
        calls.push(`GET externalid/${externalId}`);
        return { outcome: "ok", data: employees.find((e) => e.externalId === externalId) ?? null };
      },
      async getEmployee(id: string) {
        calls.push(`GET ${id}`);
        return { outcome: "ok", data: employees.find((e) => String(e.id) === id) ?? null };
      },
      async findEmployees(filter: string) {
        calls.push("FIND");
        const field = filter.split(" ")[0]!;
        const value = filterValue(filter).toLowerCase();
        return { outcome: "ok", data: employees.filter((e) => String(e[field] ?? "").toLowerCase() === value) };
      },
      async setExternalId(id: string) {
        calls.push(`PUT ${id}`);
        return { outcome: "ok", data: null };
      },
      async upsertByExternalId(externalId: string) {
        calls.push(`UPSERT ${externalId}`);
        return { outcome: "ok", data: { id: 555, status: "Active", detailedStatus: null, operationType: "Create", created: true } };
      },
    };
  }

  const run = (eh: ReturnType<typeof payrollEh>, ct: CtFake, store = fakeGateway()) =>
    runSyncJob(job(), deps({ store, eh: eh as unknown as SyncDeps["eh"], ct, fieldMap: byField }));
  const writes = (eh: ReturnType<typeof payrollEh>) => eh.calls.filter((c) => !c.startsWith("GET") && c !== "FIND");

  it("links a copied ID that finds someone whose other details agree, writing nothing to EH", async () => {
    const store = fakeGateway();
    const eh = payrollEh(handEntered(40213));
    const ct = fakeCt(withCopiedId());

    const out = await run(eh, ct, store);

    expect(out).toEqual({ status: "synced", reason: "linked: Payroll ID only", ehEmployeeId: "40213" });
    expect(writes(eh)).toEqual([]);
    expect(store.rows.get(ME)).toMatchObject({ ehEmployeeId: "40213", linkedAt: 1_000_000, externalId: COPIED });
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toEqual([
      {
        id: "chan-1",
        text:
          "🔗 Sam Rivera (17760356) is now linked to Employment Hero employee 40213.\n\n" +
          "Their Payroll ID was already in Employment Hero, so nothing was written. From now on, only what they change in Connecteam is synced.",
      },
    ]);
  });

  it("links when only some details agree, naming the ones that differ but never their values", async () => {
    const eh = payrollEh(handEntered(40213, { taxFileNumber: "876543217", emailAddress: "sam@old.example.com" }));
    const ct = fakeCt(withCopiedId());

    expect(await run(eh, ct)).toMatchObject({ status: "synced", ehEmployeeId: "40213" });

    expect(writes(eh)).toEqual([]);
    expect(ct.channels).toHaveLength(1);
    const notice = ct.channels[0]!.text;
    expect(notice).toContain("🔗 Sam Rivera (17760356) is now linked to Employment Hero employee 40213.");
    expect(notice).toContain("Their email and TFN differ in Employment Hero");
    for (const value of ["876543217", "123456782", "sam@old.example.com", "sam.rivera@example.com"]) {
      expect(notice).not.toContain(value);
    }
  });

  // A typo'd ID landing on another real employee would send later edits into their pay record.
  const someoneElse = handEntered(40377, {
    firstName: "Priya",
    surname: "Shah",
    dateOfBirth: "1988-01-02T00:00:00",
    emailAddress: "priya@example.com",
    taxFileNumber: "876543217",
  });

  it("holds a copied ID that finds someone no other detail agrees with, writing nothing to EH", async () => {
    const store = fakeGateway();
    const eh = payrollEh(someoneElse);
    const ct = fakeCt(withCopiedId());

    const out = await run(eh, ct, store);

    expect(out).toMatchObject({ status: "held" });
    expect(writes(eh)).toEqual([]);
    expect(ct.dms).toEqual([]);
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toContain("⚠️ Held: Sam Rivera (17760356)");
    expect(ct.channels[0]!.text).toContain("EH 40377: Payroll ID matched, but no other detail agreed");
    expect(store.rows.get(ME)).toMatchObject({ ehEmployeeId: null, lastOutcome: "existing_match" });
    expect(store.rows.get(ME)!.linkedAt).toBeUndefined();
    expect(store.log.map((l) => l.detail)).toEqual(["existing_match: EH 40377 (Payroll ID; email, tfn, nameDob differs)"]);
  });

  const TYPO = "Their Payroll ID in Connecteam isn't in EH; check it for a typo.";

  it("holds a copied ID that isn't in EH when the Pre-create check finds them, suggesting a typo", async () => {
    // EH holds them under 007412: the copied 007421 finds nobody.
    const eh = payrollEh(handEntered(40213, { externalId: "007412" }));
    const ct = fakeCt(withCopiedId());

    expect(await run(eh, ct)).toMatchObject({ status: "held" });

    expect(writes(eh)).toEqual([]);
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toContain("EH 40213: email, TFN and name + date of birth match");
    expect(ct.channels[0]!.text).toContain(TYPO);
    expect(ct.channels[0]!.text).not.toContain("007412");
    expect(ct.channels[0]!.text).not.toContain(COPIED);
  });

  it("suggests no typo when the key is the userId", async () => {
    const eh = payrollEh(handEntered(40213, { externalId: null }));
    const ct = fakeCt(cloneUser());

    expect(await runSyncJob(job(), deps({ eh: eh as unknown as SyncDeps["eh"], ct }))).toMatchObject({ status: "held" });
    expect(ct.channels[0]!.text).not.toContain(TYPO);
  });

  const COPY_IT = "Copy their EH Payroll ID into **EH Payroll ID** in Connecteam.";

  it("asks for the EH Payroll ID to be copied in when their field is blank and the match already has one", async () => {
    const eh = payrollEh(handEntered(40213));
    const ct = fakeCt(withCopiedId(""));

    expect(await run(eh, ct)).toMatchObject({ status: "held" });

    expect(writes(eh)).toEqual([]);
    expect(ct.channels[0]!.text).toContain(COPY_IT);
    expect(ct.channels[0]!.text).not.toContain(TYPO);
    expect(ct.channels[0]!.text).not.toContain(COPIED);
  });

  it("posts the hold again when only its hint changes, so the admin sees the new fix", async () => {
    const store = fakeGateway();
    const ct = fakeCt(withCopiedId());
    // Copied 007421, but EH holds them under 007412: the typo hint.
    const eh = payrollEh(handEntered(40213, { externalId: "007412" }));
    await runSyncJob(job(), deps({ store, eh: eh as unknown as SyncDeps["eh"], ct, fieldMap: byField }));

    // The admin clears the field: same match, now the copy-it-in hint.
    const cleared = fakeCt(withCopiedId(""));
    const again = job({ eventTimestamp: 2000 });
    expect(await runSyncJob(again, deps({ store, eh: eh as unknown as SyncDeps["eh"], ct: cleared, fieldMap: byField }))).toMatchObject({
      status: "held",
    });
    expect(cleared.channels).toHaveLength(1);
    expect(cleared.channels[0]!.text).toContain(COPY_IT);
  });

  it("names the field from the field map, when Connecteam leaves the blank field off their profile", async () => {
    const named = parseFieldMap({ ...fieldMap, identity: { externalIdFrom: { customFieldId: FIELD, name: "Payroll Number" } } });
    const ct = fakeCt(cloneUser());

    await runSyncJob(job(), deps({ eh: payrollEh(handEntered(40213)) as unknown as SyncDeps["eh"], ct, fieldMap: named }));

    expect(ct.channels[0]!.text).toContain("Copy their EH Payroll ID into **Payroll Number** in Connecteam.");
  });

  it("names the field as their profile does now, when the client renamed it after the wizard ran", async () => {
    const stale = parseFieldMap({ ...fieldMap, identity: { externalIdFrom: { customFieldId: FIELD, name: "Old Payroll Number" } } });
    const ct = fakeCt(withCopiedId(""));

    await runSyncJob(job(), deps({ eh: payrollEh(handEntered(40213)) as unknown as SyncDeps["eh"], ct, fieldMap: stale }));

    expect(ct.channels[0]!.text).toContain(COPY_IT);
  });

  it("doesn't ask for it when the match has no Payroll ID, or the client doesn't use the setting", async () => {
    const noId = fakeCt(withCopiedId(""));
    await run(payrollEh(handEntered(40213, { externalId: null })), noId);
    expect(noId.channels[0]!.text).not.toContain(COPY_IT);

    const userIdKey = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ eh: payrollEh(handEntered(40213)) as unknown as SyncDeps["eh"], ct: userIdKey }));
    expect(userIdKey.channels[0]!.text).toContain("⚠️ Held");
    expect(userIdKey.channels[0]!.text).not.toContain("Copy their EH Payroll ID");
  });

  it("creates a copied ID that isn't in EH when the Pre-create check is clear, under that ID", async () => {
    const eh = payrollEh();
    expect(await run(eh, fakeCt(withCopiedId()))).toMatchObject({ status: "synced", ehEmployeeId: "555" });
    expect(writes(eh)).toEqual([`UPSERT ${COPIED}`]);
    // Once before the write (the copied-ID check is reused) and once to read it back.
    expect(eh.calls.filter((c) => c === `GET externalid/${COPIED}`)).toHaveLength(2);
  });

  it("suggests no typo when the lookup used their stored key, not the copied one", async () => {
    // Synced under their userId before the field was filled in; EH no longer has that record.
    const store = fakeGateway({ ctUserId: ME, ehEmployeeId: "777", lastSyncedTs: 1, lastOutcome: "ok", externalId: String(ME) });
    const ct = fakeCt(withCopiedId());

    expect(await run(payrollEh(handEntered(40213, { externalId: "007412" })), ct, store)).toMatchObject({ status: "held" });
    expect(ct.channels.some((c) => c.text.includes("⚠️ Held"))).toBe(true);
    const said = ct.channels.map((c) => c.text).join("\n");
    expect(said).not.toContain(TYPO);
    // Their field isn't blank, so there's nothing to copy in either.
    expect(said).not.toContain("Copy their EH Payroll ID");
  });

  // Synced in full under the copied ID, then a later edit needed a Correction (#186).
  // This fake EH doesn't keep what's written, so only the write is checked, not the read-back.
  const correctedSince = () =>
    fakeGateway({ ctUserId: ME, ehEmployeeId: "40213", lastSyncedTs: 1, lastOutcome: "correction", externalId: COPIED });

  it("updates someone synced under it before, even after a Correction, instead of linking them", async () => {
    const store = correctedSince();
    const eh = payrollEh(handEntered(40213));
    const ct = fakeCt(withCopiedId());

    expect((await run(eh, ct, store)).reason).not.toBe("linked: Payroll ID only");
    expect(writes(eh)).toEqual([`UPSERT ${COPIED}`]);
    expect(store.rows.get(ME)!.linkedAt).toBeUndefined();
    expect(ct.channels.some((c) => c.text.includes("🔗"))).toBe(false);
  });

  it("doesn't hold someone synced under it before against the record the sync wrote", async () => {
    const store = correctedSince();
    // Their own record, though none of its details agree with theirs now.
    const eh = payrollEh({ ...someoneElse, id: 40213 });
    const ct = fakeCt(withCopiedId());

    expect((await run(eh, ct, store)).status).not.toBe("held");
    expect(writes(eh)).toEqual([`UPSERT ${COPIED}`]);
    expect(ct.channels.some((c) => c.text.includes("⚠️ Held"))).toBe(false);
  });
});

describe("runSyncJob - EH identity collision (TFN match merges two people)", () => {
  it("detects a write landing on an EH employee id already linked to a different Connecteam user", async () => {
    const store = fakeGateway();
    // A different ctUserId already owns EH employee 555 - Employment Hero's
    // TFN-matching just merged this sync's write onto that same record.
    store.rows.set(99999, {
      ctUserId: 99999,
      ehEmployeeId: "555",
      lastSyncedTs: 1,
      failureCycleCount: 0,
      lastPayloadHash: "x",
    });
    const eh = fakeEh({ id: 555, created: true });
    const ct = fakeCt(cloneUser());

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    expect(out).toMatchObject({ status: "collision" });
    expect(out.reason).toContain("555");
    expect(out.reason).toContain("99999");
    // Never saved as a normal link for the colliding user, and the pre-existing
    // owner's row is untouched.
    expect(store.rows.has(17760356)).toBe(false);
    expect(store.rows.get(99999)?.ehEmployeeId).toBe("555");
    expect(store.log).toHaveLength(1);
    expect(store.log[0]).toMatchObject({ ctUserId: 17760356, outcome: "collision" });
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toMatch(/already linked to a different Connecteam user/);
  });

  it("does not flag a collision when the EH employee id is already this same person's own link", async () => {
    const store = fakeGateway({ ctUserId: 17760356, ehEmployeeId: "555", lastPayloadHash: "old-hash" });
    const eh = fakeEh({ id: 555, created: false });

    const out = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, eh }));

    expect(out.status).not.toBe("collision");
  });
});

describe("runSyncJob - correction path", () => {
  it("an Employment Hero 400 validation failure DMs the employee and logs a correction", async () => {
    const store = fakeGateway();
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({
      write: {
        outcome: "validation",
        status: 400,
        issues: [{ field: "BankAccount1", reason: "BSB must contain 6 digits only" }],
      },
    });

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(ct.dms).toHaveLength(1);
    expect(ct.dms[0]!.userId).toBe(17760356);
    expect(ct.dms[0]!.text).toMatch(/BSB/);
    expect(store.log.at(-1)).toMatchObject({ outcome: "correction" });
    // The attempt's hash is stored (clean or not) so a byte-identical
    // re-delivery is skipped; a real edit changes the payload and re-tries.
    expect(store.rows.get(17760356)!.lastPayloadHash).toEqual(expect.any(String));
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(1000);
  });

  it("a mapping issue corrects the employee without calling Employment Hero", async () => {
    const bad = cloneUser();
    bad.customFields.find((f) => f.customFieldId === 25145118)!.value = "not-a-date";
    const ct = fakeCt(bad);
    const eh = fakeEh();

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(eh.upserts).toHaveLength(0);
    expect(ct.dms[0]!.text).toMatch(/date of birth/i);
  });

  it("a record that stays Incomplete after a 200 write triggers a correction", async () => {
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ status: "Incomplete", detailedStatus: "Tax Details are incomplete" });

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(ct.dms[0]!.text).toMatch(/tax declaration/i);
  });

  it("the third consecutive failure also DMs the direct manager", async () => {
    const user = cloneUser();
    user.customFields.push({ customFieldId: 25145114, type: "directManager", name: "Direct manager", value: 999001 });
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    const ct = fakeCt(user);
    const eh = fakeEh({
      write: { outcome: "validation", status: 400, issues: [{ field: "taxFileNumber", reason: "invalid" }] },
    });

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    expect(out.managerNotified).toBe(true);
    expect(ct.dms.map((d) => d.userId).sort()).toEqual([17760356, 999001]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(3);
  });

  it("finds the direct manager on a client account, where the field has its own id", async () => {
    // Custom-field ids are per Connecteam account; only the demo has 25145114.
    const user = cloneUser();
    user.customFields.push({ customFieldId: 51234567, type: "directManager", name: "Direct manager", value: 999001 });
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    const ct = fakeCt(user);
    const eh = fakeEh({
      write: { outcome: "validation", status: 400, issues: [{ field: "taxFileNumber", reason: "invalid" }] },
    });

    const out = await runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    expect(out.managerNotified).toBe(true);
    expect(ct.dms.map((d) => d.userId).sort()).toEqual([17760356, 999001]);
  });

  it("a clean sync after failures resets the failure count", async () => {
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    const out = await runSyncJob(job(), deps({ store, ct: fakeCt(cloneUser()) as never }));
    expect(out.status).toBe("synced");
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(0);
  });

  it("a queue retry of the same job (crash after the DM, before the state save) does not re-DM or double-bump the failure count", async () => {
    const store = fakeGateway();
    let failNextSave = true;
    const originalSave = store.saveEmployeeLink.bind(store);
    store.saveEmployeeLink = async (patch) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("D1 write failed");
      }
      return originalSave(patch);
    };
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({
      write: { outcome: "validation", status: 400, issues: [{ field: "taxFileNumber", reason: "invalid" }] },
    });
    const attempt = () => runSyncJob(job(), deps({ store, eh, ct: ct as never }));

    // Attempt 1: the correction DM goes out, then the job throws before its
    // terminal state (lastSyncedTs/lastPayloadHash) is ever saved - exactly
    // what leaves a queue redelivery looking like a first attempt.
    await expect(attempt()).rejects.toThrow("D1 write failed");
    expect(ct.dms).toHaveLength(1);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(1);

    // Attempt 2: the queue's retry of the identical message.
    const out = await attempt();
    expect(out.status).toBe("correction");
    expect(out.noticeSuppressed).toBe(true);
    expect(ct.dms).toHaveLength(1);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(1);
  });
});

describe("runSyncJob - follow-up path", () => {
  it("a non-resident result posts to the admin channel and still completes the sync", async () => {
    const user = cloneUser();
    user.customFields.find((f) => f.customFieldId === 42923315)!.value = [{ id: 1, value: "No" }]; // non-resident
    user.customFields.find((f) => f.customFieldId === 42923276)!.value = [{ id: 1, value: "No" }]; // consistent: no TFT
    const ct = fakeCt(user);
    const store = fakeGateway();

    const out = await runSyncJob(job(), deps({ store, ct: ct as never }));

    expect(out.status).toBe("follow_up");
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.id).toBe("chan-1");
    expect(ct.channels[0]!.text).toMatch(/follow-up/i);
    expect(store.log.at(-1)).toMatchObject({ outcome: "follow_up" });
    expect(store.rows.get(17760356)!.lastPayloadHash).toBeTruthy();
  });
});

describe("runSyncJob - follow-up notice de-dup (issue #27)", () => {
  const makeNonResident = (u: ConnecteamUser): ConnecteamUser => {
    u.customFields.find((f) => f.customFieldId === 42923315)!.value = [{ id: 1, value: "No" }];
    u.customFields.find((f) => f.customFieldId === 42923276)!.value = [{ id: 1, value: "No" }];
    return u;
  };
  // Clearing the USI (keeping the ABN) makes the super an SMSF -> a second,
  // additive follow-up reason.
  const alsoSmsf = (u: ConnecteamUser): ConnecteamUser => {
    u.customFields.find((f) => f.customFieldId === 42920803)!.value = "";
    return u;
  };
  const retitle = (u: ConnecteamUser): ConnecteamUser => {
    u.customFields.find((f) => f.customFieldId === 25145108)!.value = "Senior Support Officer";
    return u;
  };

  it("does not re-post the same follow-up reason while the record stays Incomplete", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });

    const first = fakeCt(makeNonResident(cloneUser()));
    const out1 = await runSyncJob(job({ eventTimestamp: 1000 }), deps({ store, eh, ct: first as never }));
    expect(out1.status).toBe("follow_up");
    expect(first.channels).toHaveLength(1);

    // A genuine later edit: different mapped payload, same follow-up reason.
    const second = fakeCt(retitle(makeNonResident(cloneUser())));
    const out2 = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, eh, ct: second as never }));

    expect(out2.status).toBe("follow_up");
    expect(out2.noticeSuppressed).toBe(true);
    expect(second.channels).toHaveLength(0);
    // The audit trail still records both follow-ups.
    expect(store.log.filter((l) => l.outcome === "follow_up")).toHaveLength(2);
  });

  it("re-posts when the follow-up reason-set actually changed", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });

    const first = fakeCt(makeNonResident(cloneUser()));
    await runSyncJob(job({ eventTimestamp: 1000 }), deps({ store, eh, ct: first as never }));
    expect(first.channels).toHaveLength(1);

    // Second edit adds SMSF super on top of the non-resident reason.
    const second = fakeCt(alsoSmsf(makeNonResident(cloneUser())));
    const out2 = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, eh, ct: second as never }));

    expect(out2.status).toBe("follow_up");
    expect(out2.noticeSuppressed).toBeFalsy();
    expect(second.channels).toHaveLength(1);
    expect(second.channels[0]!.text).toMatch(/self-managed super/i);
  });

  it("re-posts the same reason once the de-dup window has elapsed", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555 });
    let clock = 1_000_000;

    const first = fakeCt(makeNonResident(cloneUser()));
    await runSyncJob(
      job({ eventTimestamp: 1000 }),
      deps({ store, eh, ct: first as never, now: () => clock }),
    );
    expect(first.channels).toHaveLength(1);

    clock += 13 * 60 * 60 * 1000; // past FOLLOW_UP_NOTICE_DEDUPE_MS (12h)
    const second = fakeCt(retitle(makeNonResident(cloneUser())));
    const out2 = await runSyncJob(
      job({ eventTimestamp: 2000 }),
      deps({ store, eh, ct: second as never, now: () => clock }),
    );

    expect(out2.noticeSuppressed).toBeFalsy();
    expect(second.channels).toHaveLength(1);
  });
});

describe("runSyncJob - read-back mismatch", () => {
  it("a non-sensitive field that did not persist triggers a correction", async () => {
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ readBackOverrides: { residentialSuburb: "SomewhereElse" } });

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("correction");
    expect(ct.dms[0]!.text).toMatch(/address/i);
  });

  it("ignores a reformatted date on read-back (not a real mismatch)", async () => {
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({ readBackOverrides: { startDate: "2026-09-01T00:00:00", dateOfBirth: "1992-04-07T00:00:00" } });

    const out = await runSyncJob(job(), deps({ eh, ct: ct as never }));

    expect(out.status).toBe("synced");
    // No Correction - only the first-sync success message (#71).
    expect(ct.dms.map((d) => d.text)).toEqual(["Thanks, your details have now been received in Employment Hero.\n\nThis is an automated message from the Employment Hero sync."]);
  });
});

describe("runSyncJob - retryable faults", () => {
  it("an Employment Hero outage returns retry and writes nothing", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ write: { outcome: "retryable", status: 503, detail: "service unavailable" } });

    const out = await runSyncJob(job(), deps({ store, eh, ct: fakeCt(cloneUser()) as never }));

    expect(out.status).toBe("retry");
    expect(store.rows.size).toBe(0);
    expect(store.log).toHaveLength(0);
  });

  it("a Connecteam outage returns retry", async () => {
    const out = await runSyncJob(job(), deps({ ct: fakeCt(null, "retryable") as never }));
    expect(out.status).toBe("retry");
  });

  it("a Connecteam user that no longer exists is skipped, not retried", async () => {
    const out = await runSyncJob(job(), deps({ ct: fakeCt(null, "ok") as never }));
    expect(out).toMatchObject({ status: "skipped", reason: "connecteam user no longer exists" });
  });
});

describe("runSyncJob - a failed Connecteam send is retried, not lost (issue #89)", () => {
  const invalidTfn = () =>
    fakeEh({ write: { outcome: "validation", status: 400, issues: [{ field: "taxFileNumber", reason: "invalid" }] } });
  const withManager = (): ConnecteamUser => {
    const u = cloneUser();
    u.customFields.push({ customFieldId: 25145114, type: "directManager", name: "Direct manager", value: 999001 });
    return u;
  };
  const nonResident = (): ConnecteamUser => {
    const u = cloneUser();
    u.customFields.find((f) => f.customFieldId === 42923315)!.value = [{ id: 1, value: "No" }];
    u.customFields.find((f) => f.customFieldId === 42923276)!.value = [{ id: 1, value: "No" }];
    return u;
  };

  let logged: Array<Record<string, unknown>>;
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(JSON.parse(line) as Record<string, unknown>);
    });
    return () => vi.restoreAllMocks();
  });

  it("a failed Correction DM retries without bumping the cycle, and the next attempt sends it once", async () => {
    const store = fakeGateway();
    const ct = fakeCt(cloneUser());
    ct.failSends.set(17760356, 1);
    const attempt = () => runSyncJob(job(), deps({ store, eh: invalidTfn(), ct: ct as never }));

    const first = await attempt();
    expect(first.status).toBe("retry");
    expect(ct.dms).toHaveLength(0);
    expect(store.rows.get(17760356)?.failureCycleCount ?? 0).toBe(0);
    // Nothing terminal saved, so the redelivery is not skipped as "identical".
    expect(store.rows.get(17760356)?.lastPayloadHash ?? null).toBeNull();
    expect(store.log).toHaveLength(0);
    expect(logged).toContainEqual(
      expect.objectContaining({ evt: "message_send_failed", ctUserId: 17760356, notice: "correction" }),
    );

    const second = await attempt();
    expect(second.status).toBe("correction");
    expect(ct.dms.map((d) => d.userId)).toEqual([17760356]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(1);
  });

  describe("a Correction too long for one message (#112)", () => {
    // Five answers the sync can't use: each is named back to the employee, so it won't fit in 500 characters.
    const unusable = () => {
      const u = cloneUser();
      const set = (id: number, value: string) => (u.customFields.find((f) => f.customFieldId === id)!.value = [{ id: 9, value }]);
      set(42923276, "TBC");
      set(42923315, "Not sure");
      set(42923316, "Maybe");
      set(42920839, "Contractor");
      set(25145119, "Unknown");
      return u;
    };

    it("is sent as numbered parts, each within the limit, counted as one Correction", async () => {
      const store = fakeGateway();
      const ct = fakeCt(unusable());
      const out = await runSyncJob(job(), deps({ store, ct: ct as never }));
      expect(out.status).toBe("correction");
      expect(ct.dms.length).toBeGreaterThan(1);
      expect(ct.dms[0]!.text).toMatch(new RegExp(`^\\(1 of ${ct.dms.length}\\) ✏️ Hi - `));
      for (const d of ct.dms) expect(d.text.length).toBeLessThanOrEqual(500);
      const all = ct.dms.map((d) => d.text).join("\n");
      for (const answer of ["TBC", "Not sure", "Maybe", "Contractor", "Unknown"]) expect(all).toContain(`"${answer}"`);
      expect(store.rows.get(17760356)!.failureCycleCount).toBe(1);
    });

    it("if a later part fails, the retry sends only that part, and the cycle counts once", async () => {
      const store = fakeGateway();
      const ct = fakeCt(unusable());
      ct.failDmAttempts.add(2);
      const attempt = () => runSyncJob(job(), deps({ store, ct: ct as never }));

      expect((await attempt()).status).toBe("retry");
      expect(ct.dms).toHaveLength(1);
      expect(store.rows.get(17760356)?.failureCycleCount ?? 0).toBe(0);

      expect((await attempt()).status).toBe("correction");
      expect(ct.dms.map((d) => d.text.slice(0, 8))).toEqual(["(1 of 2)", "(2 of 2)"]);
      expect(store.rows.get(17760356)!.failureCycleCount).toBe(1);
    });
  });

  it("a failed manager escalation retries without re-DMing the employee or re-bumping the cycle", async () => {
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    const ct = fakeCt(withManager());
    ct.failSends.set(999001, 1);
    const attempt = () => runSyncJob(job(), deps({ store, eh: invalidTfn(), ct: ct as never }));

    const first = await attempt();
    expect(first.status).toBe("retry");
    expect(ct.dms.map((d) => d.userId)).toEqual([17760356]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(3);

    const second = await attempt();
    expect(second.status).toBe("correction");
    expect(second.managerNotified).toBe(true);
    expect(ct.dms.map((d) => d.userId)).toEqual([17760356, 999001]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(3);
  });

  it("a redelivery after both DMs went out sends neither again (ADR-0007 row 3)", async () => {
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 2 });
    let failNextSave = true;
    const originalSave = store.saveEmployeeLink.bind(store);
    store.saveEmployeeLink = async (patch) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("D1 write failed");
      }
      return originalSave(patch);
    };
    const ct = fakeCt(withManager());
    const attempt = () => runSyncJob(job(), deps({ store, eh: invalidTfn(), ct: ct as never }));

    await expect(attempt()).rejects.toThrow("D1 write failed");
    const out = await attempt();

    expect(out.status).toBe("correction");
    expect(out.noticeSuppressed).toBe(true);
    expect(ct.dms.map((d) => d.userId)).toEqual([17760356, 999001]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(3);
  });

  it("a failed Manual-follow-up notice retries, and the next attempt posts it once", async () => {
    const store = fakeGateway();
    const ct = fakeCt(nonResident());
    ct.failSends.set("chan-1", 1);
    const attempt = () => runSyncJob(job(), deps({ store, ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect(ct.channels).toHaveLength(0);
    expect(store.log).toHaveLength(0);

    expect((await attempt()).status).toBe("follow_up");
    expect(ct.channels).toHaveLength(1);
  });

  it("a failed Collision alert retries without an audit row, and the next attempt posts it once", async () => {
    const store = fakeGateway();
    store.rows.set(99999, {
      ctUserId: 99999,
      ehEmployeeId: "555",
      lastSyncedTs: 1,
      failureCycleCount: 0,
      lastPayloadHash: "x",
    });
    const ct = fakeCt(cloneUser());
    ct.failSends.set("chan-1", 1);
    const attempt = () => runSyncJob(job(), deps({ store, eh: fakeEh({ id: 555 }), ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect(ct.channels).toHaveLength(0);
    expect(store.log).toHaveLength(0);

    expect((await attempt()).status).toBe("collision");
    expect(ct.channels).toHaveLength(1);
    expect(store.log).toHaveLength(1);
  });
});

describe("dispatchBatch", () => {
  const mkMsg = (body: SyncJob, attempts = 1) => {
    const calls: string[] = [];
    const retryDelays: Array<number | undefined> = [];
    return {
      body,
      attempts,
      ack: () => calls.push("ack"),
      retry: (options?: { delaySeconds?: number }) => {
        calls.push("retry");
        retryDelays.push(options?.delaySeconds);
      },
      calls,
      retryDelays,
    };
  };

  it("delays a retry by the backoff for its attempt number (issue #90)", async () => {
    const msg = mkMsg(job({ ctUserId: 2 }), 3);
    await dispatchBatch(
      { queue: "eh-payroll-sync-queue", messages: [msg] },
      deps({ ct: fakeCt(null, "retryable") as never }),
      "eh-payroll-sync-dlq",
    );
    expect(msg.calls).toEqual(["retry"]);
    expect(msg.retryDelays).toEqual([retryDelaySeconds(3)]);
  });

  it("delays the retry of a job that threw, too", async () => {
    const store = fakeGateway();
    store.getEmployeeLink = async () => {
      throw new Error("D1 unavailable");
    };
    const msg = mkMsg(job(), 1);
    await dispatchBatch({ queue: "eh-payroll-sync-queue", messages: [msg] }, deps({ store }), "eh-payroll-sync-dlq");
    expect(msg.retryDelays).toEqual([retryDelaySeconds(1)]);
  });

  it("acks a synced message and retries a retryable one", async () => {
    const good = mkMsg(job({ ctUserId: 1 }));
    const bad = mkMsg(job({ ctUserId: 2 }));
    const d = deps({
      ct: {
        async getUser(id: number) {
          return id === 2 ? { outcome: "retryable", status: 503, detail: "x" } : { outcome: "ok", data: cloneUser() };
        },
        async sendDirectMessage() {
          return { outcome: "ok", data: null };
        },
        async sendChannelMessage() {
          return { outcome: "ok", data: null };
        },
      } as never,
    });

    await dispatchBatch({ queue: "eh-payroll-sync-queue", messages: [good, bad] }, d, "eh-payroll-sync-dlq");

    expect(good.calls).toEqual(["ack"]);
    expect(bad.calls).toEqual(["retry"]);
  });

  it("coalesces a burst for one user - runs only the newest, acks the rest", async () => {
    const store = fakeGateway();
    const eh = fakeEh({ id: 555, created: true });
    const older1 = mkMsg(job({ ctUserId: 17760356, eventTimestamp: 1000 }));
    const older2 = mkMsg(job({ ctUserId: 17760356, eventTimestamp: 1500 }));
    const newest = mkMsg(job({ ctUserId: 17760356, eventTimestamp: 2000 }));

    await dispatchBatch(
      { queue: "eh-payroll-sync-queue", messages: [older1, newest, older2] },
      deps({ store, eh }),
      "eh-payroll-sync-dlq",
    );

    expect(eh.upserts).toHaveLength(1);
    expect(store.log).toHaveLength(1);
    expect(store.rows.get(17760356)!.lastSyncedTs).toBe(2000);
    expect(older1.calls).toEqual(["ack"]);
    expect(older2.calls).toEqual(["ack"]);
    expect(newest.calls).toEqual(["ack"]);
    // Every message acked here counts toward acked_total, coalesced siblings
    // included - otherwise /health queueBacklog never drains to 0.
    expect(store.counters.get("acked_total")).toBe(3);
  });

  it("does not coalesce across different users", async () => {
    const store = fakeGateway();
    const a = mkMsg(job({ ctUserId: 1, eventTimestamp: 1000 }));
    const b = mkMsg(job({ ctUserId: 2, eventTimestamp: 1000 }));

    await dispatchBatch(
      { queue: "eh-payroll-sync-queue", messages: [a, b] },
      deps({ store, ct: fakeCt(cloneUser()) as never }),
      "eh-payroll-sync-dlq",
    );

    expect(a.calls).toEqual(["ack"]);
    expect(b.calls).toEqual(["ack"]);
    expect(store.log).toHaveLength(2);
  });

  it("routes a dead-letter batch to the system-alert handler and always acks", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    const msg = mkMsg(job());
    await dispatchBatch(
      { queue: "eh-payroll-sync-dlq", messages: [msg] },
      deps({ ct: ct as never, store }),
      "eh-payroll-sync-dlq",
    );
    expect(msg.calls).toEqual(["ack"]);
    expect(ct.channels[0]!.text).toMatch(/could not be retried/i);
    expect(store.log.at(-1)).toMatchObject({ outcome: "dead_letter" });
  });
});

describe("handleDeadLetter", () => {
  it("posts a system alert naming the user and logs dead_letter", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    await handleDeadLetter(job({ ctUserId: 42 }), {
      ct: ct as never,
      store,
      adminChannelId: "chan-1",
      now: () => 5,
    });
    expect(ct.channels[0]!.id).toBe("chan-1");
    expect(ct.channels[0]!.text).toContain("42");
    expect(ct.channels[0]!.text).toContain("every retry failed");
    expect(ct.channels[0]!.text).not.toMatch(/retry limit/);
    expect(ct.channels[0]!.text).toContain("edit their profile in Connecteam to sync again");
    expect(store.log[0]).toMatchObject({ ctUserId: 42, at: 5, outcome: "dead_letter" });
  });

  it("also notifies the integrator when onSystemAlert is provided", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    const alerts: Array<{ ctUserId: number; reason: string }> = [];
    await handleDeadLetter(job({ ctUserId: 7, reason: "profile_update" }), {
      ct: ct as never,
      store,
      adminChannelId: "chan-1",
      now: () => 5,
      onSystemAlert: async (info) => {
        alerts.push(info);
      },
    });
    expect(alerts).toEqual([{ ctUserId: 7, reason: "retries exhausted (profile_update)" }]);
  });

  it("works without onSystemAlert (integrator telemetry off)", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    await expect(
      handleDeadLetter(job({ ctUserId: 8 }), { ct: ct as never, store, adminChannelId: "c", now: () => 1 }),
    ).resolves.toBeUndefined();
  });

  it("posts one channel alert per user within the window, but audits every dead-letter (issue #27)", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    const base = { ct: ct as never, store, adminChannelId: "chan-1" };

    await handleDeadLetter(job({ ctUserId: 42 }), { ...base, now: () => 5 });
    await handleDeadLetter(job({ ctUserId: 42 }), { ...base, now: () => 60_000 });

    expect(ct.channels).toHaveLength(1);
    expect(store.log.filter((l) => l.outcome === "dead_letter")).toHaveLength(2);
  });

  it("still alerts a different user, and the same user after the window", async () => {
    const ct = fakeCt(cloneUser());
    const store = fakeGateway();
    const base = { ct: ct as never, store, adminChannelId: "chan-1" };

    await handleDeadLetter(job({ ctUserId: 42 }), { ...base, now: () => 5 });
    await handleDeadLetter(job({ ctUserId: 99 }), { ...base, now: () => 5 });
    await handleDeadLetter(job({ ctUserId: 42 }), { ...base, now: () => 5 + 61 * 60 * 1000 });

    expect(ct.channels).toHaveLength(3);
  });

  it("a failed System alert releases its claim so the next dead-letter posts it (issue #89)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ct = fakeCt(cloneUser());
    ct.failSends.set("chan-1", 1);
    const store = fakeGateway();
    const base = { ct: ct as never, store, adminChannelId: "chan-1" };

    await expect(handleDeadLetter(job({ ctUserId: 42 }), { ...base, now: () => 5 })).resolves.toBeUndefined();
    expect(ct.channels).toHaveLength(0);
    expect(store.log.at(-1)).toMatchObject({ outcome: "dead_letter" });

    await handleDeadLetter(job({ ctUserId: 42 }), { ...base, now: () => 60_000 });
    expect(ct.channels).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("runSyncJob - per-employee pay rate (issue #42)", () => {
  const rateMap = parseFieldMap({
    ...fieldMap,
    employmentHero: {
      businessId: "555455",
      defaults: {
        paySchedule: "Weekly",
        primaryLocation: "Connecteam",
        primaryPayCategory: "Permanent Ordinary Hours",
      },
      perEmployeeRate: { source: "connecteamPayRate" },
    },
  });

  const mkCt = (payRate: CtResult<PayRate | null>) => {
    const calls: Array<{ userId: number; window: { startDate: string; endDate: string } }> = [];
    const channels: Array<{ id: string; text: string }> = [];
    const ct = {
      calls,
      channels,
      async getUser() {
        return { outcome: "ok", data: cloneUser() };
      },
      async getPayRate(userId: number, window: { startDate: string; endDate: string }) {
        calls.push({ userId, window });
        return payRate;
      },
      async sendDirectMessage() {
        return { outcome: "ok", data: null };
      },
      async sendChannelMessage(id: string, text: string) {
        channels.push({ id, text });
        return { outcome: "ok", data: null };
      },
    };
    return ct as unknown as SyncDeps["ct"] & { calls: typeof calls; channels: typeof channels };
  };

  it("looks up the rate for the sync day and folds it into the EH payload", async () => {
    const ct = mkCt({ outcome: "ok", data: { rateType: "hourly", defaultRate: 40, isDefaultRateEnabled: true } });
    const eh = fakeEh({ id: 7, created: true });
    const out = await runSyncJob(
      job({ eventTimestamp: Date.parse("2026-09-10T09:00:00Z") }),
      deps({ ct, eh, store: fakeGateway(), fieldMap: rateMap }),
    );

    expect(ct.calls).toHaveLength(1);
    expect(ct.calls[0]!.window).toEqual({ startDate: "2026-09-10", endDate: "2026-09-10" });
    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.payload.rate).toBe(40);
    expect(eh.upserts[0]!.payload.rateUnit).toBe("Hourly");
    expect(eh.upserts[0]!.payload.paySchedule).toBe("Weekly");
    expect(out.status).toBe("synced");
  });

  it("no pay rate on file: still creates the EH record (without pay-run keys) and raises a follow-up", async () => {
    // A missing per-employee rate is a data gap, not a field-map misconfiguration
    // (the location axis is fine) - the record still gets created/updated as a
    // safety net, just without any pay-run keys, same as a client who never
    // configured a rate axis at all.
    const ct = mkCt({ outcome: "ok", data: null });
    const eh = fakeEh({ id: 7, created: true });
    const out = await runSyncJob(job(), deps({ ct, eh, store: fakeGateway(), fieldMap: rateMap }));

    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.payload).not.toHaveProperty("rate");
    expect(eh.upserts[0]!.payload).not.toHaveProperty("rateUnit");
    expect(eh.upserts[0]!.payload).not.toHaveProperty("paySchedule");
    expect(out.status).toBe("follow_up");
    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]!.text).toMatch(/pay rate/i);
  });

  it("a missing location-axis default (field-map misconfiguration) still blocks the whole write", async () => {
    const misconfigured = parseFieldMap({
      ...fieldMap,
      employmentHero: {
        businessId: "555455",
        defaults: { paySchedule: "Weekly", primaryLocation: "Connecteam" }, // no primaryPayCategory
        perEmployeeRate: { source: "connecteamPayRate" },
      },
    });
    const ct = mkCt({ outcome: "ok", data: { rateType: "hourly", defaultRate: 40, isDefaultRateEnabled: true } });
    const eh = fakeEh();

    const out = await runSyncJob(job(), deps({ ct, eh, store: fakeGateway(), fieldMap: misconfigured }));

    expect(eh.upserts).toHaveLength(0);
    expect(out.status).toBe("follow_up");
    expect(out.reason).toMatch(/primaryPayCategory/);
  });

  it("keeps a pay schedule set by hand in EH, and looks the record up only once (#102)", async () => {
    const ct = mkCt({ outcome: "ok", data: { rateType: "hourly", defaultRate: 40, isDefaultRateEnabled: true } });
    const eh = fakeEh({ id: 7, current: { id: 7, paySchedule: "Fortnightly" } });
    const out = await runSyncJob(job(), deps({ ct, eh, store: fakeGateway(), fieldMap: rateMap }));

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
    expect(eh.upserts[0]!.payload).not.toHaveProperty("paySchedule");
    expect(eh.upserts[0]!.payload.primaryLocation).toBe("Connecteam");
    expect(eh.upserts[0]!.payload.rate).toBe(40);
    // The record fetched before the write is handed to the upsert, not fetched again.
    expect(eh.upserts[0]!.current).toMatchObject({ paySchedule: "Fortnightly" });
    expect(eh.gets).toBe(2); // the lookup + the read-back
  });

  it("a default missing from the field map does not block when EH already has it (#102)", async () => {
    const misconfigured = parseFieldMap({
      ...fieldMap,
      employmentHero: {
        businessId: "555455",
        defaults: { paySchedule: "Weekly", primaryLocation: "Connecteam" }, // no primaryPayCategory
        perEmployeeRate: { source: "connecteamPayRate" },
      },
    });
    const ct = mkCt({ outcome: "ok", data: { rateType: "hourly", defaultRate: 40, isDefaultRateEnabled: true } });
    const eh = fakeEh({ id: 7, current: { primaryPayCategory: "Permanent Ordinary Hours" } });

    const out = await runSyncJob(job(), deps({ ct, eh, store: fakeGateway(), fieldMap: misconfigured }));

    expect(out.status).toBe("synced");
    expect(eh.upserts).toHaveLength(1);
    // No follow-up notice: the only channel post is the first-sync ✅.
    expect(ct.channels.map((c) => c.text)).toEqual([expect.stringMatching(/^✅ .* has synced to Employment Hero\.$/)]);
  });

  it("retries when the EH lookup before the write fails (#102)", async () => {
    const ct = mkCt({ outcome: "ok", data: { rateType: "hourly", defaultRate: 40, isDefaultRateEnabled: true } });
    const eh = fakeEh({ get: { outcome: "retryable", status: 503, detail: "down" } });
    const out = await runSyncJob(job(), deps({ ct, eh, store: fakeGateway(), fieldMap: rateMap }));
    expect(out.status).toBe("retry");
    expect(eh.upserts).toHaveLength(0);
  });

  it("retries when the pay-rates API is unavailable", async () => {
    const ct = mkCt({ outcome: "retryable", status: 503, detail: "down" });
    const out = await runSyncJob(
      job(),
      deps({ ct, eh: fakeEh(), store: fakeGateway(), fieldMap: rateMap }),
    );
    expect(out.status).toBe("retry");
  });

  it("does not call the pay-rates API when perEmployeeRate is off", async () => {
    const ct = mkCt({ outcome: "ok", data: null });
    await runSyncJob(
      job(),
      deps({ ct, eh: fakeEh({ id: 1, created: true }), store: fakeGateway() }),
    );
    expect(ct.calls).toHaveLength(0);
  });
});

describe("retry backoff (issue #90)", () => {
  // The consumer's max_retries, read from wrangler.jsonc so raising it can't
  // silently stretch the retry window past the notice claims.
  const maxRetries = (() => {
    const cfg = readFileSync(fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)), "utf8");
    const m = /"queue":\s*"eh-payroll-sync-queue",[^}]*?"max_retries":\s*(\d+)/.exec(cfg);
    if (!m) throw new Error("max_retries for eh-payroll-sync-queue not found in wrangler.jsonc");
    return Number(m[1]);
  })();
  // Delivery n (attempts = n) failing waits retryDelaySeconds(n) before n+1.
  // The last delivery (attempts = maxRetries + 1) dead-letters instead.
  const windowSeconds = Array.from({ length: maxRetries }, (_, i) => retryDelaySeconds(i + 1)).reduce(
    (a, b) => a + b,
    0,
  );

  it("doubles from 30 s and caps at 8 min", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 480, 480]);
  });

  it("spans a 5-minute Employment Hero outage before dead-lettering", () => {
    expect(windowSeconds).toBeGreaterThan(5 * 60);
  });

  it("finishes well inside the 1 h Correction claim, so a late retry can't re-send a message", () => {
    expect(windowSeconds * 1000).toBeLessThan(CORRECTION_NOTICE_DEDUPE_MS / 2);
  });
});

describe("runSyncJob - employee success message (issue #71)", () => {
  const FIRST = "Thanks, your details have now been received in Employment Hero.\n\nThis is an automated message from the Employment Hero sync.";
  const nonResident = (): ConnecteamUser => {
    const u = cloneUser();
    u.customFields.find((f) => f.customFieldId === 42923315)!.value = [{ id: 1, value: "No" }];
    u.customFields.find((f) => f.customFieldId === 42923276)!.value = [{ id: 1, value: "No" }];
    return u;
  };
  /** An employee with an open Correction cycle, whose last Correction named `fields`. */
  const inCorrection = (fields: string) => {
    const store = fakeGateway({ ctUserId: 17760356, failureCycleCount: 1, lastPayloadHash: "old" });
    store.rows.get(17760356)!.lastOutcome = "correction";
    store.log.push({ ctUserId: 17760356, at: 1, outcome: "correction", detail: `correction: ${fields}` });
    return store;
  };
  const dmsTo = (ct: CtFake, id = 17760356) => ct.dms.filter((d) => d.userId === id).map((d) => d.text);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  it("first successful sync -> exactly one message to the employee", async () => {
    const ct = fakeCt(cloneUser());
    const out = await runSyncJob(job(), deps({ ct: ct as never }));
    expect(out.status).toBe("synced");
    expect(dmsTo(ct)).toEqual([FIRST]);
  });

  it("first sync whose message fails: retries, and the retry sends it exactly once", async () => {
    const store = fakeGateway();
    const ct = fakeCt(cloneUser());
    ct.failSends.set(17760356, 1);
    const attempt = () => runSyncJob(job(), deps({ store, ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect(store.rows.get(17760356)?.lastPayloadHash ?? null).toBeNull();
    expect((await attempt()).status).toBe("synced");
    expect(dmsTo(ct)).toEqual([FIRST]);
  });

  it("a redelivery after the message went out (crash before the save) doesn't send it again", async () => {
    const store = fakeGateway();
    let failNextSave = true;
    const originalSave = store.saveEmployeeLink.bind(store);
    store.saveEmployeeLink = async (patch) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("D1 write failed");
      }
      return originalSave(patch);
    };
    const ct = fakeCt(cloneUser());
    const attempt = () => runSyncJob(job(), deps({ store, ct: ct as never }));

    await expect(attempt()).rejects.toThrow("D1 write failed");
    await attempt();
    expect(dmsTo(ct)).toEqual([FIRST]);
  });

  it("a fixed Correction -> one message naming what was fixed, and the cycle resets", async () => {
    const store = inCorrection("bankAccounts[0].bsb, tax-file-number-is-invalid");
    const ct = fakeCt(cloneUser());

    const out = await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));

    expect(out.status).toBe("synced");
    expect(dmsTo(ct)).toEqual([
      "Thanks, that's fixed: your bank details and tax file number have now been updated in Employment Hero.\n\nThis is an automated message from the Employment Hero sync.",
    ]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(0);
  });

  it("a fixed Correction whose message fails: retries with the cycle still open, then sends the same message once", async () => {
    const store = inCorrection("taxFileNumber");
    const ct = fakeCt(cloneUser());
    ct.failSends.set(17760356, 1);
    const attempt = () => runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(1);

    expect((await attempt()).status).toBe("synced");
    expect(dmsTo(ct)).toEqual(["Thanks, that's fixed: your tax file number has now been updated in Employment Hero.\n\nThis is an automated message from the Employment Hero sync."]);
    expect(store.rows.get(17760356)!.failureCycleCount).toBe(0);
  });

  it("a fix that lands as a Manual follow-up still thanks the employee, and a failed admin notice doesn't repeat the DM", async () => {
    const store = inCorrection("taxFileNumber");
    const ct = fakeCt(nonResident());
    ct.failSends.set("chan-1", 1);
    const attempt = () => runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect((await attempt()).status).toBe("follow_up");
    expect(dmsTo(ct)).toEqual(["Thanks, that's fixed: your tax file number has now been updated in Employment Hero.\n\nThis is an automated message from the Employment Hero sync."]);
    expect(ct.channels).toHaveLength(1);
  });

  it("a first sync whose DM fails posts no admin notice until the retry", async () => {
    const store = fakeGateway();
    const ct = fakeCt(nonResident());
    ct.failSends.set(17760356, 1);
    const attempt = () => runSyncJob(job(), deps({ store, ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect(ct.channels).toHaveLength(0);
    expect((await attempt()).status).toBe("follow_up");
    expect(dmsTo(ct)).toEqual([FIRST]);
    expect(ct.channels).toHaveLength(1);
  });

  it("an ordinary edit after a successful sync sends nothing", async () => {
    const store = fakeGateway({ ctUserId: 17760356, ehEmployeeId: "987", lastPayloadHash: "old" });
    store.rows.get(17760356)!.lastOutcome = "ok";
    const ct = fakeCt(cloneUser());
    await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));
    expect(ct.dms).toEqual([]);
  });

  it("an employee synced before outcomes were tracked (EH id, no lastOutcome) gets nothing on an edit", async () => {
    const store = fakeGateway({ ctUserId: 17760356, ehEmployeeId: "987", lastPayloadHash: "old" });
    const ct = fakeCt(cloneUser());
    await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));
    expect(ct.dms).toEqual([]);
  });

  it("sends nothing when the client switched it off", async () => {
    const off = parseFieldMap({ ...fieldMap, messages: { employeeSuccess: false } });
    const ct = fakeCt(cloneUser());
    const out = await runSyncJob(job(), deps({ ct: ct as never, fieldMap: off }));
    expect(out.status).toBe("synced");
    expect(ct.dms).toEqual([]);
  });

  // --- admin success notice: a ✅ in the alerts channel at the same moments ---
  const ADMIN_FIRST = "✅ Sam Rivera (17760356) has synced to Employment Hero.";
  const channelTexts = (ct: CtFake) => ct.channels.map((c) => c.text);

  it("admin ✅: first successful sync -> one post in the alerts channel", async () => {
    const ct = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ ct: ct as never }));
    expect(ct.channels).toEqual([{ id: "chan-1", text: ADMIN_FIRST }]);
  });

  it("admin ✅: a fixed Correction names what was fixed", async () => {
    const store = inCorrection("bankAccounts[0].bsb, tax-file-number-is-invalid");
    const ct = fakeCt(cloneUser());
    await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));
    expect(channelTexts(ct)).toEqual([
      "✅ Sam Rivera (17760356) fixed their bank details and tax file number and has now synced to Employment Hero.",
    ]);
  });

  it("admin ✅: not posted when the sync lands as a Manual follow-up (that notice is posted instead)", async () => {
    const ct = fakeCt(nonResident());
    expect((await runSyncJob(job(), deps({ ct: ct as never }))).status).toBe("follow_up");
    expect(ct.channels).toHaveLength(1);
    expect(channelTexts(ct)[0]).not.toMatch(/^✅/);
  });

  it("admin ✅: an ordinary edit after a successful sync posts nothing", async () => {
    const store = fakeGateway({ ctUserId: 17760356, ehEmployeeId: "987", lastPayloadHash: "old" });
    store.rows.get(17760356)!.lastOutcome = "ok";
    const ct = fakeCt(cloneUser());
    await runSyncJob(job({ eventTimestamp: 2000 }), deps({ store, ct: ct as never }));
    expect(ct.channels).toEqual([]);
  });

  it("admin ✅: a failed post retries without DMing the employee twice, then posts once", async () => {
    const store = fakeGateway();
    const ct = fakeCt(cloneUser());
    ct.failSends.set("chan-1", 1);
    const attempt = () => runSyncJob(job(), deps({ store, ct: ct as never }));

    expect((await attempt()).status).toBe("retry");
    expect((await attempt()).status).toBe("synced");
    expect(dmsTo(ct)).toEqual([FIRST]);
    expect(channelTexts(ct)).toEqual([ADMIN_FIRST]);
  });

  it("admin ✅: each setting switches off only its own message", async () => {
    const noAdmin = parseFieldMap({ ...fieldMap, messages: { adminSuccess: false } });
    const a = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ ct: a as never, fieldMap: noAdmin }));
    expect(dmsTo(a)).toEqual([FIRST]);
    expect(a.channels).toEqual([]);

    const noEmployee = parseFieldMap({ ...fieldMap, messages: { employeeSuccess: false } });
    const b = fakeCt(cloneUser());
    await runSyncJob(job(), deps({ ct: b as never, fieldMap: noEmployee }));
    expect(b.dms).toEqual([]);
    expect(channelTexts(b)).toEqual([ADMIN_FIRST]);
  });

  it("the Correction message names the client's own profile path", async () => {
    const custom = parseFieldMap({ ...fieldMap, messages: { profilePath: "Profile > Payroll Details" } });
    const ct = fakeCt(cloneUser());
    const eh = fakeEh({
      write: { outcome: "validation", status: 400, issues: [{ field: "taxFileNumber", reason: "invalid" }] },
    });
    await runSyncJob(job(), deps({ ct: ct as never, eh, fieldMap: custom }));
    expect(dmsTo(ct)[0]).toContain("➡️ To fix: go to **Profile > Payroll Details** and update it.");
  });
});
