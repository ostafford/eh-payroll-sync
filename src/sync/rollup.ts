/**
 * Bulk summary (#193, ADR-0013): when many people get the same Held or Link
 * notice in a burst, post one summary instead of one message each.
 *
 * Each notice is sent from its own queue job, and a go-live drains the backlog
 * 20 approvals a tick, so no one invocation ever sees "many". The count lives
 * in D1 instead (`notice_rollup`): a job that finds {@link BURST_THRESHOLD}
 * notices of its kind in the last {@link BURST_WINDOW_MS} takes its claim as
 * usual, then records the person as rolled up instead of sending. The cron
 * posts the Bulk summary once the burst goes quiet.
 *
 * The threshold is soft: concurrent consumer invocations can each read a count
 * just under it, so a burst may post a few more than 3 one by one.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { RollupGateway, RollupKind, SyncGateway } from "./gateway.js";
import { bulkSummaryMessage } from "./messages.js";
import { noticeKey, sendClaimed, NO_EMPLOYEE } from "./notices.js";

/** Notices of one kind in this window, sent or rolled up, make a burst. */
export const BURST_WINDOW_MS = 10 * 60 * 1000;
/** How many notices in the window are sent one by one before the rest roll up. */
export const BURST_THRESHOLD = 3;

/** True if this person's notice should roll up into a Bulk summary instead of being sent. */
export async function inBurst(
  store: Pick<RollupGateway, "countRecentNotices">,
  kind: RollupKind,
  now: number,
): Promise<boolean> {
  return (await store.countRecentNotices(kind, now - BURST_WINDOW_MS)) >= BURST_THRESHOLD;
}

/** A burst is over once no one has been rolled up for this long. */
export const BULK_SUMMARY_QUIET_MS = 3 * 60 * 1000;
/** Post anyway once the first person has waited this long, so a long drain isn't silent. */
export const BULK_SUMMARY_MAX_WAIT_MS = 30 * 60 * 1000;

const KINDS: readonly RollupKind[] = ["existing_match", "link"];

export interface BulkSummaryDeps {
  ct: Pick<ConnecteamClient, "sendChannelMessage">;
  store: Pick<RollupGateway, "listRolledUp" | "assignSummary" | "clearSummary" | "releaseSummary"> &
    Pick<SyncGateway, "readMeta" | "setMarker">;
  /** Connecteam conversation id for the "EH Sync Alerts" channel. */
  adminChannelId: string;
  now?: () => number;
}

/** Per kind: nobody waiting, a burst still going, or the summary sent or failed to send. */
export type BulkSummaryResult = "none" | "waiting" | "sent" | "failed";

/** The claim for one summary, named by when its people were picked. */
function summaryKey(kind: RollupKind, summaryAt: number): Promise<string> {
  return noticeKey("bulk_summary", NO_EMPLOYEE, [kind, String(summaryAt)]);
}

/**
 * Run from the cron each tick: post one Bulk summary per kind whose burst is
 * over. Safe to re-run (ADR-0007): its people are picked first, in one D1
 * statement, then the summary is claimed, sent and they are cleared. A tick
 * that crashed partway leaves them picked: the next tick clears them if the
 * claim shows the summary went out, or puts them back to waiting if it
 * didn't, so nobody is counted twice. A failed send releases both.
 */
export async function runBulkSummaries(deps: BulkSummaryDeps): Promise<Record<RollupKind, BulkSummaryResult>> {
  const now = (deps.now ?? Date.now)();
  const result = {} as Record<RollupKind, BulkSummaryResult>;
  for (const kind of KINDS) {
    await recoverCrashedSummaries(deps.store, kind);
    const people = await deps.store.listRolledUp(kind);
    if (people.length === 0) {
      result[kind] = "none";
      continue;
    }
    const newest = Math.max(...people.map((p) => p.at));
    const oldest = Math.min(...people.map((p) => p.at));
    if (now - newest < BULK_SUMMARY_QUIET_MS && now - oldest < BULK_SUMMARY_MAX_WAIT_MS) {
      result[kind] = "waiting";
      continue;
    }

    const count = await deps.store.assignSummary(kind, now);
    const key = await summaryKey(kind, now);
    await deps.store.setMarker(key, now);
    const sent = await sendClaimed(deps.store, key, NO_EMPLOYEE, "bulk_summary", () =>
      deps.ct.sendChannelMessage(deps.adminChannelId, bulkSummaryMessage(kind, count)),
    );
    if (!sent) {
      await deps.store.releaseSummary(kind, now);
      result[kind] = "failed";
      continue;
    }
    await deps.store.clearSummary(kind, now);
    result[kind] = "sent";
  }
  return result;
}

/** Settle the summaries a crashed tick left picked: cleared if it went out, back to waiting if not. */
async function recoverCrashedSummaries(store: BulkSummaryDeps["store"], kind: RollupKind): Promise<void> {
  const picked = new Set(
    (await store.listRolledUp(kind)).flatMap((p) => (p.summaryAt === null ? [] : [p.summaryAt])),
  );
  for (const summaryAt of picked) {
    const key = await summaryKey(kind, summaryAt);
    if (((await store.readMeta([key]))[key] ?? 0) > 0) await store.clearSummary(kind, summaryAt);
    else await store.releaseSummary(kind, summaryAt);
  }
}
