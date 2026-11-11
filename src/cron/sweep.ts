/**
 * The 1-minute cron sweep (issue #7). There is no Connecteam "approval" webhook,
 * so every tick the Worker lists the onboarding-pack assignments, diffs each
 * one's status against what it stored last time, and enqueues a sync for any
 * assignment that has just reached approved (`status: "completed"`).
 *
 * Throttling: at most `maxEnqueuePerSweep` approvals are enqueued per tick. The
 * rest keep their prior stored state, so the next tick picks them up - this is
 * both the first-run backlog drain and the rate-limit backoff (when Connecteam's
 * headers signal pressure the budget drops to 0).
 *
 * The diff is pure ({@link diffAssignments}); {@link runSweep} wires it to the
 * Connecteam client, D1 and the queue through injected functions.
 */
import type { CtResult, OnboardingAssignment, RateLimit } from "../connecteam/types.js";
import type { SyncJob } from "../sync/job.js";

/** One row of `onboarding_state`, as the sweep reads it. */
export interface OnboardingStateRow {
  assignmentId: number;
  ctUserId: number;
  status: "in_progress" | "completed";
  isWaitingApproval: boolean;
}

export interface SweepDiff {
  /** Assignments that just reached approved and need a sync enqueued. */
  toEnqueue: OnboardingAssignment[];
  /** Assignments whose `onboarding_state` row should be inserted/refreshed. */
  toPersist: OnboardingAssignment[];
  /** Approvals held back this tick because the enqueue budget was spent. */
  deferred: number;
}

const APPROVED = "completed";

export function diffAssignments(
  assignments: readonly OnboardingAssignment[],
  prior: ReadonlyMap<number, OnboardingStateRow>,
  budget: number,
): SweepDiff {
  const toEnqueue: OnboardingAssignment[] = [];
  const toPersist: OnboardingAssignment[] = [];
  let deferred = 0;

  for (const a of assignments) {
    const was = prior.get(a.id);
    // "Just approved" = now completed, wasn't completed last time we looked.
    // This also covers un-approve -> re-approve: an un-approve moves the
    // assignment back to `in_progress` (verified live 2026-08-31, see
    // docs/field-mapping.md), so a re-approve is a fresh in_progress -> completed.
    const justApproved = a.status === APPROVED && was?.status !== APPROVED;

    if (justApproved) {
      if (toEnqueue.length < budget) {
        toEnqueue.push(a);
        toPersist.push(a); // only record the approved state once it's queued
      } else {
        deferred++; // leave the prior state untouched so the next tick retries
      }
      continue;
    }

    const changed =
      was === undefined ||
      was.status !== a.status ||
      was.isWaitingApproval !== a.isWaitingApproval ||
      was.ctUserId !== a.userId;
    if (changed) toPersist.push(a);
  }

  return { toEnqueue, toPersist, deferred };
}

export interface SweepDeps {
  packId: number;
  listAssignments: (packId: number) => Promise<CtResult<OnboardingAssignment[]>>;
  /** Rate-limit headers from the most recent Connecteam call. */
  rateLimit: () => RateLimit | null;
  readState: () => Promise<OnboardingStateRow[]>;
  writeState: (assignments: readonly OnboardingAssignment[], seenAt: number) => Promise<void>;
  enqueue: (jobs: SyncJob[]) => Promise<void>;
  /**
   * Approved, never-synced people with a pending link not yet queued for it
   * (#155): their pack is `completed` but they have no `employee_map` row, e.g.
   * after an old dead-letter. A D1 read, never an EH call.
   */
  listUnsyncedLinks: () => Promise<number[]>;
  /** Record that these people's pending links are queued, so a later tick doesn't queue them again. */
  markLinksQueued: (ctUserIds: readonly number[]) => Promise<void>;
  now?: () => number;
  maxEnqueuePerSweep?: number;
}

export interface SweepResult {
  status: "ok" | "skipped" | "retry";
  listed: number;
  enqueued: number;
  deferred: number;
  reason?: string;
}

const DEFAULT_MAX_ENQUEUE = 20;
/** Hold new approvals when fewer than this many Connecteam calls remain this minute. */
const RATE_MINUTE_FLOOR = 20;
/** Or when the daily budget is nearly gone. */
const RATE_DAY_FLOOR = 200;

export function underRatePressure(rl: RateLimit | null): boolean {
  if (rl === null) return false;
  if (rl.minuteRemaining !== null && rl.minuteRemaining <= RATE_MINUTE_FLOOR) return true;
  if (rl.dayRemaining !== null && rl.dayRemaining <= RATE_DAY_FLOOR) return true;
  return false;
}

export async function runSweep(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now ?? Date.now;
  const max = deps.maxEnqueuePerSweep ?? DEFAULT_MAX_ENQUEUE;
  const empty = { listed: 0, enqueued: 0, deferred: 0 };

  const listed = await deps.listAssignments(deps.packId);
  if (listed.outcome === "retryable") {
    return { status: "retry", ...empty, reason: `connecteam unavailable: ${listed.detail}` };
  }
  if (listed.outcome === "error") {
    return { status: "retry", ...empty, reason: `connecteam error ${listed.status}` };
  }

  const budget = underRatePressure(deps.rateLimit()) ? 0 : max;

  const prior = new Map((await deps.readState()).map((r) => [r.assignmentId, r] as const));
  const diff = diffAssignments(listed.data, prior, budget);
  const { toEnqueue, toPersist } = diff;

  // Fresh approvals take the budget first; any links left over wait for the next tick.
  const unsynced = await deps.listUnsyncedLinks();
  const linkIds = unsynced.slice(0, budget - toEnqueue.length);
  const deferred = diff.deferred + unsynced.length - linkIds.length;

  const at = now();
  const ctUserIds = [...toEnqueue.map((a) => a.userId), ...linkIds];
  if (ctUserIds.length > 0) {
    await deps.enqueue(ctUserIds.map((ctUserId) => ({ reason: "approval", ctUserId, eventTimestamp: at })));
    // Fresh approvals too: next tick they'd match the list while their job is still in flight.
    await deps.markLinksQueued(ctUserIds);
  }
  if (toPersist.length > 0) {
    await deps.writeState(toPersist, at);
  }

  return {
    status: budget === 0 && deferred > 0 ? "skipped" : "ok",
    listed: listed.data.length,
    enqueued: ctUserIds.length,
    deferred,
  };
}
