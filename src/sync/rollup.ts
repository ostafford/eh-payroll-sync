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
import { noticeKey, sendClaimed, shouldPostNotice, NO_EMPLOYEE } from "./notices.js";

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
/**
 * Holds a summary's claim until the tick after a crash has cleared its people,
 * with room to spare. Short of a week, so the same people's weekly Held
 * reminders roll up into a new summary.
 */
const BULK_SUMMARY_CLAIM_MS = 24 * 60 * 60 * 1000;

const KINDS: readonly RollupKind[] = ["existing_match", "link"];

export interface BulkSummaryDeps {
  ct: Pick<ConnecteamClient, "sendChannelMessage">;
  store: Pick<RollupGateway, "listRolledUp" | "clearRolledUp"> & Pick<SyncGateway, "readMeta" | "setMarker">;
  /** Connecteam conversation id for the "EH Sync Alerts" channel. */
  adminChannelId: string;
  now?: () => number;
}

/** Per kind: nobody waiting, a burst still going, or the summary sent or failed to send. */
export type BulkSummaryResult = "none" | "waiting" | "sent" | "failed";

/**
 * Run from the cron each tick: post one Bulk summary per kind whose burst is
 * over. Claimed by who it counts before it's sent (ADR-0007), so a tick that
 * crashed after the send only clears them. A failed send releases the claim
 * and leaves them waiting for the next tick.
 */
export async function runBulkSummaries(deps: BulkSummaryDeps): Promise<Record<RollupKind, BulkSummaryResult>> {
  const now = (deps.now ?? Date.now)();
  const result = {} as Record<RollupKind, BulkSummaryResult>;
  for (const kind of KINDS) {
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

    const ids = people.map((p) => p.ctUserId);
    const key = await noticeKey("bulk_summary", NO_EMPLOYEE, [kind, ...ids.map(String)]);
    if (await shouldPostNotice(deps.store, key, BULK_SUMMARY_CLAIM_MS, now)) {
      const sent = await sendClaimed(deps.store, key, NO_EMPLOYEE, "bulk_summary", () =>
        deps.ct.sendChannelMessage(deps.adminChannelId, bulkSummaryMessage(kind, ids.length)),
      );
      if (!sent) {
        result[kind] = "failed";
        continue;
      }
    }
    // Only those listed: anyone rolled up since waits for the next summary.
    await deps.store.clearRolledUp(kind, ids);
    result[kind] = "sent";
  }
  return result;
}
