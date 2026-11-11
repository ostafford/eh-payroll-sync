import { describe, it, expect, vi } from "vitest";
import {
  diffAssignments,
  underRatePressure,
  runSweep,
  type OnboardingStateRow,
  type SweepDeps,
} from "../src/cron/sweep.js";
import type { OnboardingAssignment, RateLimit } from "../src/connecteam/types.js";
import type { SyncJob } from "../src/sync/job.js";

const asg = (over: Partial<OnboardingAssignment>): OnboardingAssignment => ({
  id: 1,
  userId: 100,
  status: "in_progress",
  isWaitingApproval: false,
  ...over,
});

const priorMap = (rows: OnboardingStateRow[]) =>
  new Map(rows.map((r) => [r.assignmentId, r] as const));

const stateRow = (over: Partial<OnboardingStateRow>): OnboardingStateRow => ({
  assignmentId: 1,
  ctUserId: 100,
  status: "in_progress",
  isWaitingApproval: false,
  ...over,
});

describe("diffAssignments", () => {
  it("enqueues an assignment that just reached approved (no prior row)", () => {
    const d = diffAssignments([asg({ id: 1, userId: 100, status: "completed" })], priorMap([]), 20);
    expect(d.toEnqueue.map((a) => a.id)).toEqual([1]);
    expect(d.toPersist.map((a) => a.id)).toEqual([1]);
    expect(d.deferred).toBe(0);
  });

  it("does not re-enqueue an assignment already recorded as completed", () => {
    const d = diffAssignments(
      [asg({ id: 1, status: "completed" })],
      priorMap([stateRow({ assignmentId: 1, status: "completed" })]),
      20,
    );
    expect(d.toEnqueue).toEqual([]);
    expect(d.toPersist).toEqual([]);
  });

  it("ignores an assignment that is not yet approved, but keeps its state fresh", () => {
    const d = diffAssignments([asg({ id: 2, status: "in_progress", isWaitingApproval: true })], priorMap([]), 20);
    expect(d.toEnqueue).toEqual([]);
    expect(d.toPersist.map((a) => a.id)).toEqual([2]);
  });

  it("re-enqueues after an un-approve then re-approve (in_progress -> completed)", () => {
    const d = diffAssignments(
      [asg({ id: 1, status: "completed" })],
      priorMap([stateRow({ assignmentId: 1, status: "in_progress" })]),
      20,
    );
    expect(d.toEnqueue.map((a) => a.id)).toEqual([1]);
  });

  it("records an un-approve (completed -> in_progress) without enqueuing", () => {
    const d = diffAssignments(
      [asg({ id: 1, status: "in_progress" })],
      priorMap([stateRow({ assignmentId: 1, status: "completed" })]),
      20,
    );
    expect(d.toEnqueue).toEqual([]);
    expect(d.toPersist.map((a) => a.id)).toEqual([1]);
  });

  it("persists a changed isWaitingApproval flag on an unapproved assignment", () => {
    const d = diffAssignments(
      [asg({ id: 1, status: "in_progress", isWaitingApproval: true })],
      priorMap([stateRow({ assignmentId: 1, status: "in_progress", isWaitingApproval: false })]),
      20,
    );
    expect(d.toPersist.map((a) => a.id)).toEqual([1]);
  });

  it("caps enqueues at the budget and defers the rest without persisting them", () => {
    const many = Array.from({ length: 25 }, (_, i) => asg({ id: i + 1, userId: 100 + i, status: "completed" }));
    const d = diffAssignments(many, priorMap([]), 10);
    expect(d.toEnqueue).toHaveLength(10);
    expect(d.toPersist).toHaveLength(10);
    expect(d.deferred).toBe(15);
    // deferred assignments keep no row -> next sweep re-sees them as new.
    expect(d.toPersist.map((a) => a.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("underRatePressure", () => {
  const rl = (over: Partial<RateLimit>): RateLimit => ({
    minuteRemaining: 100,
    minuteLimit: 200,
    dayRemaining: 15000,
    ...over,
  });

  it("is false when there are no headers", () => {
    expect(underRatePressure(null)).toBe(false);
  });
  it("is false when plenty of budget remains", () => {
    expect(underRatePressure(rl({}))).toBe(false);
  });
  it("is true when the per-minute budget is nearly gone", () => {
    expect(underRatePressure(rl({ minuteRemaining: 5 }))).toBe(true);
  });
  it("is true when the daily budget is nearly gone", () => {
    expect(underRatePressure(rl({ dayRemaining: 50 }))).toBe(true);
  });
  it("ignores a null field", () => {
    expect(underRatePressure(rl({ minuteRemaining: null, dayRemaining: null }))).toBe(false);
  });
});

// --- runSweep ------------------------------------------------------------

function sweepDeps(over: Partial<SweepDeps> = {}): {
  deps: SweepDeps;
  enqueued: SyncJob[][];
  persisted: Array<{ assignments: readonly OnboardingAssignment[]; seenAt: number }>;
  state: OnboardingStateRow[];
  /** Approved, never-synced people with a pending link, before the queued marker (what D1 would match). */
  unsynced: number[];
} {
  const enqueued: SyncJob[][] = [];
  const unsynced: number[] = [];
  const queuedLinks = new Set<number>();
  const persisted: Array<{ assignments: readonly OnboardingAssignment[]; seenAt: number }> = [];
  const state: OnboardingStateRow[] = [];
  const deps: SweepDeps = {
    packId: 5474,
    listAssignments: over.listAssignments ?? (async () => ({ outcome: "ok", data: [] })),
    rateLimit: over.rateLimit ?? (() => null),
    readState: over.readState ?? (async () => state),
    writeState:
      over.writeState ??
      (async (assignments, seenAt) => {
        persisted.push({ assignments, seenAt });
        for (const a of assignments) {
          const row: OnboardingStateRow = {
            assignmentId: a.id,
            ctUserId: a.userId,
            status: a.status,
            isWaitingApproval: a.isWaitingApproval,
          };
          const i = state.findIndex((s) => s.assignmentId === a.id);
          if (i === -1) state.push(row);
          else state[i] = row;
        }
      }),
    enqueue: over.enqueue ?? (async (jobs) => { enqueued.push(jobs); }),
    listUnsyncedLinks: over.listUnsyncedLinks ?? (async () => unsynced.filter((id) => !queuedLinks.has(id))),
    markLinksQueued:
      over.markLinksQueued ??
      (async (ctUserIds) => {
        for (const id of ctUserIds) queuedLinks.add(id);
      }),
    now: over.now ?? (() => 1_700_000_000_000),
    ...(over.maxEnqueuePerSweep !== undefined ? { maxEnqueuePerSweep: over.maxEnqueuePerSweep } : {}),
  };
  return { deps, enqueued, persisted, state, unsynced };
}

describe("runSweep", () => {
  it("enqueues an approval job per newly-approved assignment and records their state", async () => {
    const h = sweepDeps({
      listAssignments: async () => ({
        outcome: "ok",
        data: [
          asg({ id: 1, userId: 101, status: "completed" }),
          asg({ id: 2, userId: 102, status: "completed" }),
          asg({ id: 3, userId: 103, status: "in_progress" }),
        ],
      }),
    });

    const res = await runSweep(h.deps);

    expect(res).toMatchObject({ status: "ok", listed: 3, enqueued: 2, deferred: 0 });
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toEqual([
      { reason: "approval", ctUserId: 101, eventTimestamp: 1_700_000_000_000 },
      { reason: "approval", ctUserId: 102, eventTimestamp: 1_700_000_000_000 },
    ]);
    expect(h.state.map((s) => s.assignmentId).sort()).toEqual([1, 2, 3]);
  });

  it("is a no-op on the next run when nothing changed", async () => {
    const data = [asg({ id: 1, userId: 101, status: "completed" })];
    const h = sweepDeps({ listAssignments: async () => ({ outcome: "ok", data }) });

    await runSweep(h.deps);
    const second = await runSweep(h.deps);

    expect(second).toMatchObject({ status: "ok", enqueued: 0 });
    expect(h.enqueued).toHaveLength(1); // only the first run enqueued
  });

  it("drains a first-run backlog across sweeps, throttled to the budget", async () => {
    const data = Array.from({ length: 25 }, (_, i) => asg({ id: i + 1, userId: 100 + i, status: "completed" }));
    const h = sweepDeps({ maxEnqueuePerSweep: 10, listAssignments: async () => ({ outcome: "ok", data }) });

    const r1 = await runSweep(h.deps);
    const r2 = await runSweep(h.deps);
    const r3 = await runSweep(h.deps);
    const r4 = await runSweep(h.deps);

    expect([r1.enqueued, r2.enqueued, r3.enqueued, r4.enqueued]).toEqual([10, 10, 5, 0]);
    expect(h.enqueued.flat()).toHaveLength(25);
    expect(new Set(h.enqueued.flat().map((j) => j.ctUserId)).size).toBe(25);
  });

  it("holds new approvals when Connecteam signals rate pressure, but still records other changes", async () => {
    const h = sweepDeps({
      rateLimit: () => ({ minuteRemaining: 3, minuteLimit: 200, dayRemaining: 9000 }),
      listAssignments: async () => ({
        outcome: "ok",
        data: [
          asg({ id: 1, userId: 101, status: "completed" }),
          asg({ id: 2, userId: 102, status: "in_progress", isWaitingApproval: true }),
        ],
      }),
    });

    const res = await runSweep(h.deps);

    expect(res).toMatchObject({ status: "skipped", enqueued: 0, deferred: 1 });
    expect(h.enqueued).toHaveLength(0);
    expect(h.state.map((s) => s.assignmentId)).toEqual([2]); // the in_progress change was still persisted
  });

  it("re-enqueues after an un-approve then re-approve", async () => {
    let status: "in_progress" | "completed" = "completed";
    const h = sweepDeps({
      listAssignments: async () => ({ outcome: "ok", data: [asg({ id: 1, userId: 101, status })] }),
    });

    await runSweep(h.deps); // initial approval -> enqueue #1
    status = "in_progress";
    await runSweep(h.deps); // un-approve -> just records
    status = "completed";
    await runSweep(h.deps); // re-approve -> enqueue #2

    expect(h.enqueued.flat().map((j) => j.ctUserId)).toEqual([101, 101]);
  });

  it("returns retry and touches nothing when the list call is retryable", async () => {
    const enqueue = vi.fn(async () => {});
    const writeState = vi.fn(async () => {});
    const res = await runSweep(
      sweepDeps({
        enqueue,
        writeState,
        listAssignments: async () => ({ outcome: "retryable", status: 503, detail: "down" }),
      }).deps,
    );
    expect(res.status).toBe("retry");
    expect(enqueue).not.toHaveBeenCalled();
    expect(writeState).not.toHaveBeenCalled();
  });
});

describe("runSweep - approved, never-synced people with a pending link (#155)", () => {
  it("queues them for their link, with no new approval needed", async () => {
    const h = sweepDeps();
    h.unsynced.push(201);

    const res = await runSweep(h.deps);

    expect(res).toMatchObject({ status: "ok", enqueued: 1 });
    expect(h.enqueued).toEqual([[{ reason: "approval", ctUserId: 201, eventTimestamp: 1_700_000_000_000 }]]);
  });

  it("queues each one once: the next tick, with their job still in flight, queues nobody", async () => {
    const h = sweepDeps();
    h.unsynced.push(201);

    await runSweep(h.deps);
    const second = await runSweep(h.deps);

    expect(second.enqueued).toBe(0);
    expect(h.enqueued.flat().map((j) => j.ctUserId)).toEqual([201]);
  });

  it("a fresh approval counts as queued for its link, so the next tick doesn't queue it again", async () => {
    const h = sweepDeps({
      listAssignments: async () => ({ outcome: "ok", data: [asg({ id: 1, userId: 101, status: "completed" })] }),
    });

    await runSweep(h.deps);
    h.unsynced.push(101); // now completed in onboarding_state, still pending, job not yet run
    const second = await runSweep(h.deps);

    expect(second.enqueued).toBe(0);
    expect(h.enqueued.flat().map((j) => j.ctUserId)).toEqual([101]);
  });

  it("share the tick's budget with fresh approvals, which go first; the rest wait for the next tick", async () => {
    const h = sweepDeps({
      maxEnqueuePerSweep: 2,
      listAssignments: async () => ({ outcome: "ok", data: [asg({ id: 1, userId: 101, status: "completed" })] }),
    });
    h.unsynced.push(201, 202, 203);

    const r1 = await runSweep(h.deps);
    const r2 = await runSweep(h.deps);

    expect([r1.enqueued, r2.enqueued]).toEqual([2, 2]);
    expect(h.enqueued.map((b) => b.map((j) => j.ctUserId))).toEqual([[101, 201], [202, 203]]);
  });

  it("queue none under Connecteam rate pressure", async () => {
    const h = sweepDeps({ rateLimit: () => ({ minuteRemaining: 3, minuteLimit: 200, dayRemaining: 9000 }) });
    h.unsynced.push(201);

    const res = await runSweep(h.deps);

    expect(res.enqueued).toBe(0);
    expect(h.enqueued).toEqual([]);
  });
});
