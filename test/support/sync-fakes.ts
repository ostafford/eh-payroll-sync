/**
 * The sync consumer's fakes (#187): an in-memory store, Connecteam and EH, and
 * the `SyncDeps` that wire them up. Shared by the consumer's own tests and the
 * preflight's parity test, so both run the sync against the same fakes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFieldMap } from "../../src/mapping/schema.js";
import type { ConnecteamUser } from "../../src/mapping/apply.js";
import { syntheticUser } from "../fixtures/connecteam-user.js";
import type { SyncDeps } from "../../src/sync/consumer.js";
import type {
  Baseline,
  EmployeeLink,
  EmployeeLinkPatch,
  PendingLink,
  RollupGateway,
  RollupKind,
  SyncLogEntry,
} from "../../src/sync/gateway.js";

export const fieldMap = parseFieldMap(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../clients/_example/field-map.json", import.meta.url)), "utf8"),
  ),
);

export const cloneUser = (): ConnecteamUser => structuredClone(syntheticUser);

// --- fakes -----------------------------------------------------------------

export function fakeGateway(
  seed: Partial<EmployeeLink> = {},
  approved = true,
): SyncDeps["store"] &
  RollupGateway & {
  rows: Map<number, EmployeeLink>;
  log: SyncLogEntry[];
  counters: Map<string, number>;
  meta: Map<string, number>;
  pending: Map<number, PendingLink>;
  /** `notice_rollup`, keyed `${kind}:${ctUserId}` (#193). */
  rollups: Map<string, { kind: RollupKind; ctUserId: number; at: number; rolledUp: boolean }>;
  /** How many more `notice_rollup` reads / writes throw, as a transient D1 error would. */
  failRollup: { count: number; record: number };
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
  const rollups = new Map<string, { kind: RollupKind; ctUserId: number; at: number; rolledUp: boolean }>();
  const failRollup = { count: 0, record: 0 };
  return {
    rows,
    log,
    counters,
    meta,
    pending,
    rollups,
    failRollup,
    async countRecentNotices(kind: RollupKind, since: number) {
      if (failRollup.count > 0 && failRollup.count--) throw new Error("D1 unavailable");
      return [...rollups.values()].filter((r) => r.kind === kind && r.at >= since).length;
    },
    async recordNotice(kind: RollupKind, ctUserId: number, at: number, rolledUp: boolean) {
      if (failRollup.record > 0 && failRollup.record--) throw new Error("D1 unavailable");
      rollups.set(`${kind}:${ctUserId}`, { kind, ctUserId, at, rolledUp });
    },
    async listRolledUp(kind: RollupKind) {
      return [...rollups.values()]
        .filter((r) => r.kind === kind && r.rolledUp)
        .sort((a, b) => a.at - b.at)
        .map(({ ctUserId, at }) => ({ ctUserId, at }));
    },
    async clearRolledUp(kind: RollupKind, ctUserIds: readonly number[]) {
      for (const id of ctUserIds) {
        const r = rollups.get(`${kind}:${id}`);
        if (r) r.rolledUp = false;
      }
    },
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

/** Seed other people's Held or Link notices, recorded (sent) at these times (#193). Their ids run from 1. */
export function recentNotices(store: ReturnType<typeof fakeGateway>, kind: RollupKind, ...at: number[]): void {
  at.forEach((t, i) => store.rollups.set(`${kind}:${i + 1}`, { kind, ctUserId: i + 1, at: t, rolledUp: false }));
}

export interface EhStub {
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

export type CtFake = SyncDeps["ct"] & {
  dms: Array<{ userId: number; text: string }>;
  channels: Array<{ id: string; text: string }>;
  /** Recipient (user id or channel id) -> how many more sends to it fail as `retryable`. */
  failSends: Map<number | string, number>;
  /** Which DM attempts (1st, 2nd, ... across the fake's life) fail as `retryable`. */
  failDmAttempts: Set<number>;
};
export type EhFake = SyncDeps["eh"] & {
  upserts: Array<{ externalId: string; payload: Record<string, unknown>; current?: unknown }>;
  gets: number;
  /** The Payroll ID of every `getByExternalId` call, in order. */
  getKeys: string[];
  /** Every `$filter` the Pre-create check sent. */
  finds: string[];
};

export function fakeCt(user: ConnecteamUser | null, userOutcome: "ok" | "retryable" | "error" = "ok"): CtFake {
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

export function fakeEh(stub: EhStub = {}): EhFake {
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

export function deps(over: Partial<SyncDeps> & { now?: () => number } = {}): SyncDeps {
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
