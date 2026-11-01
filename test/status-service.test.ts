import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildStatusRoster,
  maybeRunStatusDigest,
  runStatusDigestNow,
  STATUS_DIGEST_MIN_GAP_MS,
  STATUS_DIGEST_RETRY_MS,
} from "../src/status/service.js";
import type { RosterRow } from "../src/status/roster.js";
import type { ConnecteamUser, CtResult } from "../src/connecteam/types.js";

function fakeStore(rows: RosterRow[]) {
  const meta = new Map<string, number>();
  return {
    meta,
    async listRosterRows() {
      return rows;
    },
    async readMeta(keys: string[]) {
      return Object.fromEntries(keys.map((k) => [k, meta.get(k) ?? 0]));
    },
    async setMarker(key: string, value: number) {
      meta.set(key, value);
    },
  };
}

/** `failAt`: 0-based indexes of the channel-send calls that fail as `retryable`. */
function fakeCt(users: Record<number, { firstName: string; lastName: string }> = {}, failAt: number[] = []) {
  const channels: Array<{ id: string; text: string }> = [];
  let calls = 0;
  return {
    channels,
    async getUser(userId: number): Promise<CtResult<ConnecteamUser | null>> {
      const u = users[userId];
      if (!u) return { outcome: "ok", data: null };
      return { outcome: "ok", data: { userId, firstName: u.firstName, lastName: u.lastName, customFields: [] } };
    },
    async sendChannelMessage(id: string, text: string): Promise<CtResult<null>> {
      if (failAt.includes(calls++)) return { outcome: "retryable", status: 429, detail: "rate limited" };
      channels.push({ id, text });
      return { outcome: "ok", data: null };
    },
  };
}

function row(over: Partial<RosterRow>): RosterRow {
  return {
    ctUserId: 100,
    ehEmployeeId: "1",
    failureCycleCount: 0,
    lastOutcome: "ok",
    latestOutcome: "ok",
    latestDetail: "synced",
    ...over,
  };
}

const ADMIN_CHANNEL = "admin-channel";

describe("buildStatusRoster", () => {
  it("fetches a name only for non-ready employees", async () => {
    const store = fakeStore([
      row({ ctUserId: 1 }),
      row({ ctUserId: 2, lastOutcome: "correction", latestOutcome: "correction", latestDetail: "correction: bsb" }),
    ]);
    const ct = fakeCt({ 2: { firstName: "Ada", lastName: "Lovelace" } });

    const roster = await buildStatusRoster({ store, ct });

    expect(roster.counts).toEqual({ ready: 1, waitingEmployee: 1, waitingAdmin: 0, broken: 0, leftOut: 0 });
    expect(roster.employees).toEqual([
      { ctUserId: 1, ehEmployeeId: "1", state: "ready", reasons: [] },
      {
        ctUserId: 2,
        ehEmployeeId: "1",
        state: "waiting_on_employee",
        reasons: ["bsb"],
        cycleCount: 0,
        name: "Ada Lovelace",
      },
    ]);
    expect(typeof roster.generatedAt).toBe("string");
  });

  it("omits name when the Connecteam lookup fails, without throwing", async () => {
    const store = fakeStore([row({ ctUserId: 1, lastOutcome: "follow_up", latestOutcome: "follow_up", latestDetail: "follow_up: reason" })]);
    const ct = {
      async getUser() {
        return { outcome: "error" as const, status: 500, detail: "down" };
      },
      async sendChannelMessage() {
        return { outcome: "ok" as const, data: null };
      },
    };

    const roster = await buildStatusRoster({ store, ct });
    expect(roster.employees[0]).not.toHaveProperty("name");
  });

  it("never touches Connecteam when the whole roster is ready", async () => {
    const store = fakeStore([row({ ctUserId: 1 }), row({ ctUserId: 2 })]);
    let calls = 0;
    const ct = {
      async getUser() {
        calls++;
        return { outcome: "ok" as const, data: null };
      },
      async sendChannelMessage() {
        return { outcome: "ok" as const, data: null };
      },
    };
    await buildStatusRoster({ store, ct });
    expect(calls).toBe(0);
  });
});

describe("buildStatusRoster - left out by choice", () => {
  it("labels them with the field map's values and never looks up their names", async () => {
    const store = fakeStore([
      row({ ctUserId: 1, lastOutcome: "excluded", latestOutcome: "excluded", latestDetail: "excluded: customField 42920839 (Employee Status)" }),
    ]);
    let calls = 0;
    const ct = {
      async getUser() {
        calls++;
        return { outcome: "ok" as const, data: null };
      },
      async sendChannelMessage() {
        return { outcome: "ok" as const, data: null };
      },
    };
    const roster = await buildStatusRoster({ store, ct, exclude: [{ customFieldId: 42920839, values: ["PBV"] }] });
    expect(roster.employees[0]).toMatchObject({ state: "left_out", reasons: ["Employee Status: PBV"] });
    expect(roster.counts.leftOut).toBe(1);
    expect(calls).toBe(0);
  });
});

describe("runStatusDigestNow", () => {
  it("posts the digest to the admin channel", async () => {
    const store = fakeStore([row({ ctUserId: 1, lastOutcome: "follow_up", latestOutcome: "follow_up", latestDetail: "follow_up: reason" })]);
    const ct = fakeCt();

    await runStatusDigestNow({ store, ct, adminChannelId: ADMIN_CHANNEL });

    expect(ct.channels).toHaveLength(1);
    expect(ct.channels[0]?.id).toBe(ADMIN_CHANNEL);
    expect(ct.channels[0]?.text).toContain("🟠 Waiting on admin (1):");
  });
});

describe("maybeRunStatusDigest", () => {
  it("skips on a day that does not match STATUS_DIGEST_DAY", async () => {
    // 2026-09-14 is a Monday (UTC); ask for Tuesday (2) instead.
    const store = fakeStore([row({ ctUserId: 1 })]);
    const ct = fakeCt();
    const now = () => new Date("2026-09-14T00:00:00Z").getTime();

    const result = await maybeRunStatusDigest({ store, ct, adminChannelId: ADMIN_CHANNEL, digestDay: "2", now });
    expect(result).toBe("skipped");
    expect(ct.channels).toEqual([]);
  });

  it("defaults to Monday when STATUS_DIGEST_DAY is unset", async () => {
    const store = fakeStore([row({ ctUserId: 1 })]);
    const ct = fakeCt();
    const now = () => new Date("2026-09-14T00:00:00Z").getTime(); // Monday

    const result = await maybeRunStatusDigest({ store, ct, adminChannelId: ADMIN_CHANNEL, now });
    expect(result).toBe("sent");
  });

  it("sends on the configured day and stamps the marker", async () => {
    const store = fakeStore([row({ ctUserId: 1 })]);
    const ct = fakeCt();
    const now = () => new Date("2026-09-15T00:00:00Z").getTime(); // Tuesday

    const result = await maybeRunStatusDigest({ store, ct, adminChannelId: ADMIN_CHANNEL, digestDay: "2", now });
    expect(result).toBe("sent");
    expect(ct.channels).toHaveLength(1);
    expect(store.meta.get("last_status_digest_at")).toBe(now());
  });

  it("does not send twice within the minimum gap even on the configured day", async () => {
    const store = fakeStore([row({ ctUserId: 1 })]);
    const day2Monday = new Date("2026-09-14T00:00:00Z").getTime();
    store.meta.set("last_status_digest_at", day2Monday - 1000);
    const ct = fakeCt();

    const result = await maybeRunStatusDigest({ store, ct, adminChannelId: ADMIN_CHANNEL, now: () => day2Monday });
    expect(result).toBe("skipped");
    expect(ct.channels).toEqual([]);
  });

  it("sends again once the minimum gap has passed", async () => {
    const store = fakeStore([row({ ctUserId: 1 })]);
    const firstMonday = new Date("2026-09-14T00:00:00Z").getTime();
    store.meta.set("last_status_digest_at", firstMonday - STATUS_DIGEST_MIN_GAP_MS - 1000);
    const ct = fakeCt();

    const result = await maybeRunStatusDigest({ store, ct, adminChannelId: ADMIN_CHANNEL, now: () => firstMonday });
    expect(result).toBe("sent");
  });
});

describe("a failed digest send (issue #94)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // Enough Waiting-on-admin rows that the digest splits into several messages.
  const bigRoster = () =>
    Array.from({ length: 30 }, (_, i) =>
      row({ ctUserId: 1000 + i, lastOutcome: "follow_up", latestOutcome: "follow_up", latestDetail: "follow_up: reason" }),
    );

  it("runStatusDigestNow reports a full send", async () => {
    const result = await runStatusDigestNow({ store: fakeStore([row({ ctUserId: 1 })]), ct: fakeCt(), adminChannelId: ADMIN_CHANNEL });
    expect(result).toEqual({ outcome: "sent", messages: 1 });
  });

  it("stops at the first failed chunk, so the digest never arrives with a gap in the middle", async () => {
    const ct = fakeCt({}, [1]);

    const result = await runStatusDigestNow({ store: fakeStore(bigRoster()), ct, adminChannelId: ADMIN_CHANNEL });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.messages).toBeGreaterThan(2);
    expect(result.sent).toBe(1);
    expect(ct.channels).toHaveLength(1);
  });

  it("a failed weekly digest leaves the weekly marker unset and retries after a pause, the same day", async () => {
    const store = fakeStore(bigRoster());
    const ct = fakeCt({}, [0]);
    const monday = new Date("2026-09-14T09:00:00Z").getTime();
    const tick = (at: number) => maybeRunStatusDigest({ store, ct, adminChannelId: ADMIN_CHANNEL, now: () => at });

    expect(await tick(monday)).toBe("failed");
    expect(store.meta.get("last_status_digest_at")).toBeUndefined();

    // The cron ticks every minute: no retry (or roster rebuild) until the pause is up.
    expect(await tick(monday + 60_000)).toBe("skipped");
    expect(await tick(monday + STATUS_DIGEST_RETRY_MS - 1)).toBe("skipped");
    expect(ct.channels).toHaveLength(0);

    expect(await tick(monday + STATUS_DIGEST_RETRY_MS)).toBe("sent");
    expect(store.meta.get("last_status_digest_at")).toBe(monday + STATUS_DIGEST_RETRY_MS);
    expect(ct.channels.length).toBeGreaterThan(1);
  });
});
