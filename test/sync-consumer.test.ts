import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFieldMap } from "../src/mapping/schema.js";
import type { ConnecteamUser } from "../src/mapping/apply.js";
import { syntheticUser } from "./fixtures/connecteam-user.js";
import {
  runSyncJob,
  dispatchBatch,
  handleDeadLetter,
  retryDelaySeconds,
  type SyncDeps,
} from "../src/sync/consumer.js";
import { CORRECTION_NOTICE_DEDUPE_MS } from "../src/sync/notices.js";
import type { SyncJob } from "../src/sync/job.js";
import type { EmployeeLink, EmployeeLinkPatch, SyncGateway, SyncLogEntry } from "../src/sync/gateway.js";
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
): SyncGateway & {
  rows: Map<number, EmployeeLink>;
  log: SyncLogEntry[];
  counters: Map<string, number>;
  meta: Map<string, number>;
} {
  const rows = new Map<number, EmployeeLink>();
  if (seed.ctUserId !== undefined) {
    rows.set(seed.ctUserId, {
      ctUserId: seed.ctUserId,
      ehEmployeeId: seed.ehEmployeeId ?? null,
      lastSyncedTs: seed.lastSyncedTs ?? null,
      failureCycleCount: seed.failureCycleCount ?? 0,
      lastPayloadHash: seed.lastPayloadHash ?? null,
    });
  }
  const log: SyncLogEntry[] = [];
  const counters = new Map<string, number>();
  const meta = new Map<string, number>();
  return {
    rows,
    log,
    counters,
    meta,
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
      });
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
}

type CtFake = SyncDeps["ct"] & {
  dms: Array<{ userId: number; text: string }>;
  channels: Array<{ id: string; text: string }>;
  /** Recipient (user id or channel id) -> how many more sends to it fail as `retryable`. */
  failSends: Map<number | string, number>;
};
type EhFake = SyncDeps["eh"] & {
  upserts: Array<{ externalId: string; payload: Record<string, unknown>; current?: unknown }>;
  gets: number;
};

function fakeCt(user: ConnecteamUser | null, userOutcome: "ok" | "retryable" | "error" = "ok"): CtFake {
  const dms: Array<{ userId: number; text: string }> = [];
  const channels: Array<{ id: string; text: string }> = [];
  const failSends = new Map<number | string, number>();
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
    async getUser() {
      if (userOutcome === "retryable") return { outcome: "retryable", status: 503, detail: "down" };
      if (userOutcome === "error") return { outcome: "error", status: 500, detail: "bad" };
      return { outcome: "ok", data: user };
    },
    async sendDirectMessage(userId: number, text: string) {
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
  return {
    upserts,
    gets: 0,
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
    expect(dmsTo(ct)[0]).toContain("To fix: go to Profile > Payroll Details and update it.");
  });
});
