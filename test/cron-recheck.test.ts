import { describe, it, expect, vi, afterEach } from "vitest";
import { runRecheck, type RecheckDeps } from "../src/cron/recheck.js";
import type { EmployeeLink, EmployeeLinkPatch, RecheckGateway, SyncLogEntry } from "../src/sync/gateway.js";

// --- fakes -------------------------------------------------------------

function fakeStore(seed: EmployeeLink[] = []): RecheckGateway & {
  rows: Map<number, EmployeeLink>;
  log: SyncLogEntry[];
  meta: Map<string, number>;
} {
  const rows = new Map(seed.map((r) => [r.ctUserId, r] as const));
  const log: SyncLogEntry[] = [];
  const meta = new Map<string, number>();
  return {
    rows,
    log,
    meta,
    async listFollowUpLinks() {
      return [...rows.values()].filter((r) => r.lastOutcome === "follow_up" && r.ehEmployeeId !== null);
    },
    async saveEmployeeLink(patch: EmployeeLinkPatch) {
      rows.set(patch.ctUserId, {
        ctUserId: patch.ctUserId,
        ehEmployeeId: patch.ehEmployeeId,
        lastSyncedTs: patch.lastSyncedTs,
        lastPayloadHash: patch.lastPayloadHash,
        lastOutcome: patch.lastOutcome ?? null,
        failureCycleCount: rows.get(patch.ctUserId)?.failureCycleCount ?? 0,
      });
    },
    async appendSyncLog(entry) {
      log.push(entry);
    },
    async readMeta(keys: string[]) {
      return Object.fromEntries(keys.map((k) => [k, meta.get(k) ?? 0]));
    },
    async setMarker(key: string, value: number) {
      meta.set(key, value);
    },
  };
}

function link(over: Partial<EmployeeLink>): EmployeeLink {
  return {
    ctUserId: 100,
    ehEmployeeId: "555",
    lastSyncedTs: 1000,
    failureCycleCount: 0,
    lastPayloadHash: "abc",
    lastOutcome: "follow_up",
    ...over,
  };
}

type EhFake = RecheckDeps["eh"] & { calls: string[] };

function fakeEh(byExternalId: Record<string, { status: string | null } | "retryable" | "not_found">): EhFake {
  const calls: string[] = [];
  return {
    calls,
    async getByExternalId(externalId: string) {
      calls.push(externalId);
      const stub = byExternalId[externalId];
      if (stub === "retryable") return { outcome: "retryable", status: null, detail: "down" };
      if (stub === "not_found" || stub === undefined) return { outcome: "ok", data: null };
      return {
        outcome: "ok",
        data: { id: 1, externalId, ...(stub.status !== null ? { status: stub.status } : {}) },
      };
    },
  };
}

type CtFake = RecheckDeps["ct"] & { channels: Array<{ id: string; text: string }> };

/** `failSends`: how many channel sends fail as `retryable` before they start working. */
function fakeCt(failSends = 0): CtFake {
  const channels: Array<{ id: string; text: string }> = [];
  let failsLeft = failSends;
  return {
    channels,
    async getUser(userId: number) {
      return { outcome: "ok", data: { userId, firstName: "Ada", lastName: "Lovelace" } as never };
    },
    async sendChannelMessage(id: string, text: string) {
      if (failsLeft > 0) {
        failsLeft--;
        return { outcome: "retryable", status: 429, detail: "rate limited" };
      }
      channels.push({ id, text });
      return { outcome: "ok", data: null };
    },
  };
}

const ADMIN_CHANNEL = "admin-channel";

describe("runRecheck", () => {
  it("resolves a follow-up row whose EH status is no longer Incomplete", async () => {
    const store = fakeStore([link({ ctUserId: 100, ehEmployeeId: "555" })]);
    const eh = fakeEh({ "100": { status: "Complete" } });
    const ct = fakeCt();

    const result = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(result).toEqual({ status: "ok", checked: 1, resolved: 1, stillIncomplete: 0, skipped: 0 });
    expect(store.rows.get(100)?.lastOutcome).toBe("resolved");
    expect(store.log).toEqual([
      { ctUserId: 100, at: expect.any(Number), outcome: "resolved", detail: 'resolved: status now "Complete"' },
    ]);
    expect(store.rows.get(100)?.ehEmployeeId).toBe("555"); // unrelated fields preserved
    expect(ct.channels).toEqual([
      { id: ADMIN_CHANNEL, text: "✅ Ada Lovelace (100) is now Complete in Employment Hero - no more action needed." },
    ]);
  });

  it("looks EH up by the stored match key, not the Connecteam id (ADR-0011)", async () => {
    const store = fakeStore([link({ ctUserId: 100, externalId: "P-100" })]);
    const eh = fakeEh({ "P-100": { status: "Complete" } });

    const result = await runRecheck({ eh, ct: fakeCt(), store, adminChannelId: ADMIN_CHANNEL });

    expect(eh.calls).toEqual(["P-100"]);
    expect(result).toMatchObject({ resolved: 1 });
  });

  it("leaves a still-Incomplete row untouched and posts nothing", async () => {
    const store = fakeStore([link({ ctUserId: 100 })]);
    const eh = fakeEh({ "100": { status: "Incomplete" } });
    const ct = fakeCt();

    const result = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(result).toEqual({ status: "ok", checked: 1, resolved: 0, stillIncomplete: 1, skipped: 0 });
    expect(store.rows.get(100)?.lastOutcome).toBe("follow_up");
    expect(store.log).toEqual([]);
    expect(ct.channels).toEqual([]);
  });

  it("makes no EH writes - RecheckDeps only exposes getByExternalId", async () => {
    const store = fakeStore([link({ ctUserId: 100 })]);
    const eh = fakeEh({ "100": { status: "Complete" } });
    const ct = fakeCt();

    await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    // The `eh` fake only implements getByExternalId - runRecheck compiles and
    // runs against it, so it structurally cannot be calling a write method.
    expect(eh.calls).toEqual(["100"]);
  });

  it("ignores rows whose last outcome is not follow_up", async () => {
    const store = fakeStore([link({ ctUserId: 100, lastOutcome: "ok" }), link({ ctUserId: 101, lastOutcome: "correction" })]);
    const eh = fakeEh({});
    const ct = fakeCt();

    const result = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(result).toEqual({ status: "ok", checked: 0, resolved: 0, stillIncomplete: 0, skipped: 0 });
    expect(eh.calls).toEqual([]);
  });

  it("skips a row with no eh employee id without touching state", async () => {
    const store = fakeStore([link({ ctUserId: 100, ehEmployeeId: null })]);
    const eh = fakeEh({});
    const ct = fakeCt();

    const result = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    // never listed - listFollowUpLinks filters null ehEmployeeId, matching the
    // real store's WHERE clause, so this row never reaches the loop at all.
    expect(result).toEqual({ status: "ok", checked: 0, resolved: 0, stillIncomplete: 0, skipped: 0 });
    expect(eh.calls).toEqual([]);
  });

  it("skips a row on a retryable EH fault without changing its state", async () => {
    const store = fakeStore([link({ ctUserId: 100 })]);
    const eh = fakeEh({ "100": "retryable" });
    const ct = fakeCt();

    const result = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(result).toEqual({ status: "ok", checked: 1, resolved: 0, stillIncomplete: 0, skipped: 1 });
    expect(store.rows.get(100)?.lastOutcome).toBe("follow_up");
    expect(store.log).toEqual([]);
  });

  it("caps the run at maxPerRun, leaving the rest for the next cycle", async () => {
    const store = fakeStore([
      link({ ctUserId: 100, ehEmployeeId: "1" }),
      link({ ctUserId: 101, ehEmployeeId: "2" }),
      link({ ctUserId: 102, ehEmployeeId: "3" }),
    ]);
    const eh = fakeEh({ "100": { status: "Complete" }, "101": { status: "Complete" }, "102": { status: "Complete" } });
    const ct = fakeCt();

    const result = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL, maxPerRun: 2 });

    expect(result.checked).toBe(2);
    expect(eh.calls.length).toBe(2);
  });

  it("falls back to an id-only person ref when the Connecteam lookup fails", async () => {
    const store = fakeStore([link({ ctUserId: 100 })]);
    const eh = fakeEh({ "100": { status: "Complete" } });
    const sent: string[] = [];
    const ct: RecheckDeps["ct"] = {
      async getUser() {
        return { outcome: "error", status: 500, detail: "down" };
      },
      async sendChannelMessage(_id, text) {
        sent.push(text);
        return { outcome: "ok", data: null };
      },
    };

    await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(sent).toEqual([
      "✅ Connecteam user 100 is now Complete in Employment Hero - no more action needed.",
    ]);
  });
});

describe("runRecheck - a failed resolved notice (issue #94)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("leaves the row as follow_up so the next run retries, and logs message_send_failed", async () => {
    const logged: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(JSON.parse(line) as Record<string, unknown>);
    });
    const store = fakeStore([link({ ctUserId: 100, ehEmployeeId: "555" })]);
    const eh = fakeEh({ "100": { status: "Complete" } });
    const ct = fakeCt(1);

    const first = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(first).toEqual({ status: "ok", checked: 1, resolved: 0, stillIncomplete: 0, skipped: 1 });
    expect(store.rows.get(100)?.lastOutcome).toBe("follow_up");
    expect(store.log).toEqual([]);
    expect(ct.channels).toEqual([]);
    expect(logged).toContainEqual(
      expect.objectContaining({ evt: "message_send_failed", ctUserId: 100, notice: "resolved" }),
    );

    // The next daily run: Connecteam is back.
    const second = await runRecheck({ eh, ct, store, adminChannelId: ADMIN_CHANNEL });

    expect(second).toEqual({ status: "ok", checked: 1, resolved: 1, stillIncomplete: 0, skipped: 0 });
    expect(store.rows.get(100)?.lastOutcome).toBe("resolved");
    expect(store.log.map((l) => l.outcome)).toEqual(["resolved"]);
    expect(ct.channels).toHaveLength(1);
  });
});
