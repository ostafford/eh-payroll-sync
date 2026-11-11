import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { SyncStore } from "../../src/db/store.js";
import { runSweep, type SweepDeps } from "../../src/cron/sweep.js";
import type { OnboardingAssignment } from "../../src/connecteam/types.js";
import type { SyncJob } from "../../src/sync/job.js";

const asg = (over: Partial<OnboardingAssignment>): OnboardingAssignment => ({
  id: 1,
  userId: 100,
  status: "in_progress",
  isWaitingApproval: false,
  ...over,
});

function deps(list: OnboardingAssignment[]) {
  const store = new SyncStore(env.DB);
  const enqueued: SyncJob[] = [];
  const d: SweepDeps = {
    packId: 5474,
    listAssignments: async () => ({ outcome: "ok", data: list }),
    rateLimit: () => null,
    readState: () => store.readOnboardingState(),
    writeState: (a, seenAt) => store.writeOnboardingState(a, seenAt),
    listUnsyncedLinks: () => store.listUnsyncedLinks(),
    markLinksQueued: (ids) => store.markLinksQueued(ids),
    enqueue: async (jobs) => {
      enqueued.push(...jobs);
    },
    now: () => 1_700_000_000_000,
  };
  return { d, enqueued, store };
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM onboarding_state").run();
});

describe("cron sweep (in workerd, real D1)", () => {
  it("persists assignment state to onboarding_state and enqueues approvals once", async () => {
    const list = [
      asg({ id: 1, userId: 101, status: "completed" }),
      asg({ id: 2, userId: 102, status: "in_progress" }),
    ];
    const { d, enqueued } = deps(list);

    const first = await runSweep(d);
    expect(first).toMatchObject({ status: "ok", enqueued: 1 });
    expect(enqueued).toEqual([{ reason: "approval", ctUserId: 101, eventTimestamp: 1_700_000_000_000 }]);

    const rows = await env.DB.prepare("SELECT assignment_id, ct_user_id, status FROM onboarding_state ORDER BY assignment_id").all<{
      assignment_id: number;
      ct_user_id: number;
      status: string;
    }>();
    expect(rows.results).toEqual([
      { assignment_id: 1, ct_user_id: 101, status: "completed" },
      { assignment_id: 2, ct_user_id: 102, status: "in_progress" },
    ]);

    // Second sweep, nothing changed -> no new enqueue.
    const second = await runSweep(deps(list).d);
    // (fresh deps, but same D1) -> read sees the stored rows
    expect(second).toMatchObject({ status: "ok", enqueued: 0 });
  });

  it("re-enqueues after un-approve then re-approve", async () => {
    let list = [asg({ id: 1, userId: 101, status: "completed" })];
    const run = () => deps(list);

    const a = run();
    await runSweep(a.d);
    expect(a.enqueued).toHaveLength(1);

    list = [asg({ id: 1, userId: 101, status: "in_progress" })];
    const b = run();
    await runSweep(b.d);
    expect(b.enqueued).toHaveLength(0);

    list = [asg({ id: 1, userId: 101, status: "completed" })];
    const c = run();
    await runSweep(c.d);
    expect(c.enqueued).toEqual([{ reason: "approval", ctUserId: 101, eventTimestamp: 1_700_000_000_000 }]);
  });
});
