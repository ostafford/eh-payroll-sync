/**
 * Drizzle-backed {@link SyncGateway} over the D1 database. The only place the
 * Worker talks SQL. Compiled into the Worker bundle, not the node test project -
 * unit tests use a fake gateway instead.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { employeeMap, onboardingState, pendingLink, syncLog, syncMeta } from "./schema.js";
import type {
  Baseline,
  EmployeeLink,
  EmployeeLinkPatch,
  LinkGateway,
  PendingLink,
  SyncGateway,
  SyncLogEntry,
} from "../sync/gateway.js";
import type { OnboardingStateRow } from "../cron/sweep.js";
import type { OnboardingAssignment } from "../connecteam/types.js";
import { ROSTER_QUERY_SQL, parseRosterRows, type RosterRow } from "../status/roster.js";

export class SyncStore implements SyncGateway, LinkGateway {
  readonly #db: DrizzleD1Database;
  readonly #raw: D1Database;

  constructor(d1: D1Database) {
    this.#db = drizzle(d1);
    this.#raw = d1;
  }

  async getEmployeeLink(ctUserId: number): Promise<EmployeeLink | null> {
    const [row] = await this.#db
      .select()
      .from(employeeMap)
      .where(eq(employeeMap.ctUserId, ctUserId))
      .limit(1);
    if (!row) return null;
    return toEmployeeLink(row);
  }

  /** The Connecteam userId already linked to this EH employee id, if any (collision check). */
  async findByEhEmployeeId(ehEmployeeId: string): Promise<number | null> {
    const [row] = await this.#db
      .select({ ctUserId: employeeMap.ctUserId })
      .from(employeeMap)
      .where(eq(employeeMap.ehEmployeeId, ehEmployeeId))
      .limit(1);
    return row?.ctUserId ?? null;
  }

  async saveEmployeeLink(patch: EmployeeLinkPatch): Promise<void> {
    const now = Date.now();
    const lastOutcome = patch.lastOutcome ?? null;
    await this.#db
      .insert(employeeMap)
      .values({
        ctUserId: patch.ctUserId,
        ehEmployeeId: patch.ehEmployeeId,
        lastSyncedTs: patch.lastSyncedTs,
        lastPayloadHash: patch.lastPayloadHash,
        lastOutcome,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: employeeMap.ctUserId,
        set: {
          ehEmployeeId: patch.ehEmployeeId,
          lastSyncedTs: patch.lastSyncedTs,
          lastPayloadHash: patch.lastPayloadHash,
          lastOutcome,
          updatedAt: now,
        },
      });
  }

  // --- daily EH-status recheck pass (issue #43) ---

  /** Every `employee_map` row whose last attempt ended in a Manual-follow-up. */
  async listFollowUpLinks(): Promise<EmployeeLink[]> {
    const rows = await this.#db
      .select()
      .from(employeeMap)
      .where(and(eq(employeeMap.lastOutcome, "follow_up"), isNotNull(employeeMap.ehEmployeeId)));
    return rows.map(toEmployeeLink);
  }

  async getFailureCount(ctUserId: number): Promise<number> {
    const [row] = await this.#db
      .select({ n: employeeMap.failureCycleCount })
      .from(employeeMap)
      .where(eq(employeeMap.ctUserId, ctUserId))
      .limit(1);
    return row?.n ?? 0;
  }

  async setFailureCount(ctUserId: number, count: number): Promise<void> {
    const now = Date.now();
    await this.#db
      .insert(employeeMap)
      .values({ ctUserId, failureCycleCount: count, updatedAt: now })
      .onConflictDoUpdate({
        target: employeeMap.ctUserId,
        set: { failureCycleCount: count, updatedAt: now },
      });
  }

  async appendSyncLog(entry: SyncLogEntry): Promise<void> {
    await this.#db.insert(syncLog).values({
      ctUserId: entry.ctUserId,
      at: entry.at,
      outcome: entry.outcome,
      detail: entry.detail,
    });
  }

  async latestCorrectionDetail(ctUserId: number): Promise<string | null> {
    const [row] = await this.#db
      .select({ detail: syncLog.detail })
      .from(syncLog)
      .where(and(eq(syncLog.ctUserId, ctUserId), eq(syncLog.outcome, "correction")))
      .orderBy(desc(syncLog.id))
      .limit(1);
    return row?.detail ?? null;
  }

  /** True if `onboarding_state` has ever recorded this person as `completed` (ADR-0002). */
  async hasBeenApproved(ctUserId: number): Promise<boolean> {
    const [row] = await this.#db
      .select({ assignmentId: onboardingState.assignmentId })
      .from(onboardingState)
      .where(and(eq(onboardingState.ctUserId, ctUserId), eq(onboardingState.status, "completed")))
      .limit(1);
    return row !== undefined;
  }

  // --- cron approval sweep (issue #7) ---

  async readOnboardingState(): Promise<OnboardingStateRow[]> {
    const rows = await this.#db.select().from(onboardingState);
    return rows.map((r) => ({
      assignmentId: r.assignmentId,
      ctUserId: r.ctUserId,
      status: r.status,
      isWaitingApproval: r.isWaitingApproval,
    }));
  }

  async writeOnboardingState(
    assignments: readonly OnboardingAssignment[],
    seenAt: number,
  ): Promise<void> {
    for (const a of assignments) {
      await this.#db
        .insert(onboardingState)
        .values({
          assignmentId: a.id,
          ctUserId: a.userId,
          status: a.status,
          isWaitingApproval: a.isWaitingApproval,
          seenAt,
        })
        .onConflictDoUpdate({
          target: onboardingState.assignmentId,
          set: {
            ctUserId: a.userId,
            status: a.status,
            isWaitingApproval: a.isWaitingApproval,
            seenAt,
          },
        });
    }
  }

  // --- linking Pre-existing employees (ADR-0009, ADR-0010) ---

  async getPendingLink(ctUserId: number): Promise<PendingLink | null> {
    const [row] = await this.#db
      .select()
      .from(pendingLink)
      .where(eq(pendingLink.ctUserId, ctUserId))
      .limit(1);
    return row ?? null;
  }

  async listPendingLinks(): Promise<PendingLink[]> {
    return this.#db.select().from(pendingLink);
  }

  async savePendingLink(link: PendingLink): Promise<void> {
    await this.#db
      .insert(pendingLink)
      .values(link)
      .onConflictDoUpdate({
        target: pendingLink.ctUserId,
        set: { ehEmployeeId: link.ehEmployeeId, confirmedAt: link.confirmedAt },
      });
  }

  async deletePendingLink(ctUserId: number): Promise<void> {
    await this.#db.delete(pendingLink).where(eq(pendingLink.ctUserId, ctUserId));
  }

  async completeLink(patch: EmployeeLinkPatch, linkedAt: number, baseline: Baseline): Promise<void> {
    const now = Date.now();
    const linked = {
      ehEmployeeId: patch.ehEmployeeId,
      lastSyncedTs: patch.lastSyncedTs,
      lastPayloadHash: patch.lastPayloadHash,
      lastOutcome: patch.lastOutcome ?? null,
      linkedAt,
      baseline: JSON.stringify(baseline),
      updatedAt: now,
    };
    await this.#db.batch([
      this.#db
        .insert(employeeMap)
        .values({ ctUserId: patch.ctUserId, ...linked })
        .onConflictDoUpdate({ target: employeeMap.ctUserId, set: linked }),
      this.#db.delete(pendingLink).where(eq(pendingLink.ctUserId, patch.ctUserId)),
    ]);
  }

  async markLinked(ctUserId: number, linkedAt: number, baseline: Baseline): Promise<void> {
    await this.#db
      .update(employeeMap)
      .set({ linkedAt, baseline: JSON.stringify(baseline), updatedAt: Date.now() })
      .where(eq(employeeMap.ctUserId, ctUserId));
  }

  async saveBaseline(ctUserId: number, baseline: Baseline): Promise<void> {
    await this.#db
      .update(employeeMap)
      .set({ baseline: JSON.stringify(baseline), updatedAt: Date.now() })
      .where(eq(employeeMap.ctUserId, ctUserId));
  }

  // --- operational counters / markers for /health (issue #9) ---

  /** Add `delta` to a counter, creating it at `delta` if absent. */
  async bumpCounter(key: string, delta: number): Promise<void> {
    if (delta === 0) return;
    const now = Date.now();
    await this.#db
      .insert(syncMeta)
      .values({ key, num: delta, updatedAt: now })
      .onConflictDoUpdate({
        target: syncMeta.key,
        set: { num: sql`${syncMeta.num} + ${delta}`, updatedAt: now },
      });
  }

  /** Set a marker to an absolute value (e.g. a "last ok" timestamp). */
  async setMarker(key: string, value: number): Promise<void> {
    const now = Date.now();
    await this.#db
      .insert(syncMeta)
      .values({ key, num: value, updatedAt: now })
      .onConflictDoUpdate({ target: syncMeta.key, set: { num: value, updatedAt: now } });
  }

  /** Read named counters/markers; missing keys come back as 0. */
  async readMeta(keys: string[]): Promise<Record<string, number>> {
    const rows = await this.#db.select().from(syncMeta);
    const found = new Map(rows.map((r) => [r.key, r.num]));
    return Object.fromEntries(keys.map((k) => [k, found.get(k) ?? 0]));
  }

  // --- sync-status roster (issue #44) ---

  /**
   * Every person we have ever seen, joined with their latest `sync_log` row -
   * see `ROSTER_QUERY_SQL` (src/status/roster.ts) for why the id set is a UNION
   * of `employee_map` and `sync_log` rather than just `employee_map`. Raw SQL,
   * not drizzle, so `GET /health` (src/health.ts) can run the exact same query
   * text through its own minimal D1 surface and never drift from this store.
   */
  async listRosterRows(): Promise<RosterRow[]> {
    const { results } = await this.#raw.prepare(ROSTER_QUERY_SQL).all();
    return parseRosterRows(results);
  }
}

function toEmployeeLink(row: typeof employeeMap.$inferSelect): EmployeeLink {
  return {
    ctUserId: row.ctUserId,
    ehEmployeeId: row.ehEmployeeId,
    lastSyncedTs: row.lastSyncedTs,
    failureCycleCount: row.failureCycleCount,
    lastPayloadHash: row.lastPayloadHash,
    lastOutcome: row.lastOutcome,
    linkedAt: row.linkedAt,
    baseline: parseBaseline(row.baseline),
  };
}

/** The stored Baseline, or null when there is none or it isn't the shape we write. */
export function parseBaseline(text: string | null): Baseline | null {
  if (!text) return null;
  try {
    const b = JSON.parse(text) as Partial<Baseline>;
    if (typeof b.keyId !== "string" || !b.units || typeof b.units !== "object" || Array.isArray(b.units)) return null;
    if (!Object.values(b.units).every((v) => typeof v === "string")) return null;
    return { keyId: b.keyId, units: b.units };
  } catch {
    return null;
  }
}
