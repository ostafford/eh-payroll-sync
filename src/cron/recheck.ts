/**
 * Daily EH-status recheck pass (issue #43). `src/cron/sweep.ts` and the queue
 * consumer only look at an employee at two moments: the pack first reaching
 * `completed`, and (via the `user_updated` webhook) a Connecteam profile edit.
 * Between those moments the integration is blind to EH - a record EH marks
 * `Incomplete` for admin-only reasons (pay-run defaults, award, ...) stays that
 * way in our view even after a payroll admin finishes it by hand in EH, and the
 * Manual-follow-up notice never learns it is resolved.
 *
 * This pass re-reads every employee whose last attempt ended in a
 * Manual-follow-up. It is read-only against EH: only `getByExternalId`, never
 * `upsertByExternalId` - it never touches a pay run. `getByExternalId` only
 * returns `status` ("Complete" | "Incomplete"), not the `detailedStatus` reason
 * phrase (that only comes back on a POST/PUT write envelope - confirmed
 * `docs/eh-complete-criteria.md`), so this pass can tell WHETHER a record is
 * still Incomplete but not WHY. That is fine for its one job:
 *
 *   - status no longer Incomplete -> the record resolved without a profile
 *     edit. Write a `resolved` sync_log row, flip `employee_map.last_outcome`
 *     off `follow_up` (so it drops out of the next recheck) and post a
 *     one-line resolved notice. The notice goes first: if it fails to send,
 *     the row stays on `follow_up` and the next run tries again (#94).
 *   - still Incomplete -> do nothing. A changed reason-set can only be told
 *     apart from an unchanged one via `detailedStatus`, which needs a write;
 *     surfacing a new admin reason stays the job of the next real sync
 *     (profile edit or approval), same as before this pass existed.
 *
 * It also re-queues every Held employee (#155, #165). Their hold can be
 * resolved without a profile edit - a link confirmed in the link list, or the
 * Payroll ID filled in in Connecteam (ADR-0011) - and D1 can't see the second,
 * so each one simply runs again. Deciding who that is is a D1 read, never an
 * EH call.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { EhPayrollClient } from "../eh/client.js";
import type { RecheckGateway } from "../sync/gateway.js";
import { resolvedNoticeMessage, type PersonRef } from "../sync/messages.js";
import { logEvent } from "../log.js";
import type { SyncJob } from "../sync/job.js";

export interface RecheckDeps {
  eh: Pick<EhPayrollClient, "getByExternalId">;
  ct: Pick<ConnecteamClient, "getUser" | "sendChannelMessage">;
  store: RecheckGateway;
  /** Connecteam conversation id for the "EH Sync Alerts" channel. */
  adminChannelId: string;
  /** Put sync jobs on the queue: how Held employees run again. */
  enqueue: (jobs: SyncJob[]) => Promise<void>;
  now?: () => number;
  /**
   * Cap on EH lookups this run. The approval sweep's own Connecteam budget
   * (issue #7) is what actually gates Connecteam call volume; this cap just
   * keeps one recheck run from burning a large EH batch in one tick, so the
   * pass still yields headroom the sweep might need. Any employees past the
   * cap are simply picked up on the next daily run.
   */
  maxPerRun?: number;
  /**
   * Cap on Held employees queued this run: the sweep's pacing of 20 a tick
   * (#155). The store lists them least recently updated first, and a re-held
   * row is updated, so any past the cap are queued on a later day.
   */
  maxHeldPerRun?: number;
}

export interface RecheckResult {
  status: "ok";
  /** Follow-up rows looked at this run (after the `maxPerRun` cap). */
  checked: number;
  /** Rows found no longer Incomplete: a `resolved` row was written. */
  resolved: number;
  /** Rows still Incomplete: left untouched. */
  stillIncomplete: number;
  /**
   * Rows skipped this run, left as they were for the next run: the EH lookup
   * failed, the record has vanished, or the resolved notice failed to send.
   */
  skipped: number;
  /** Held employees queued to run again. */
  requeued: number;
}

const DEFAULT_MAX_RECHECK = 25;
const DEFAULT_MAX_HELD = 20;
const INCOMPLETE = "incomplete";

export async function runRecheck(deps: RecheckDeps): Promise<RecheckResult> {
  const now = deps.now ?? Date.now;
  const max = deps.maxPerRun ?? DEFAULT_MAX_RECHECK;

  const held = (await deps.store.listHeldLinks()).slice(0, deps.maxHeldPerRun ?? DEFAULT_MAX_HELD);
  if (held.length > 0) {
    const at = now();
    await deps.enqueue(held.map((ctUserId) => ({ reason: "approval", ctUserId, eventTimestamp: at })));
  }

  const links = (await deps.store.listFollowUpLinks()).slice(0, max);

  let resolved = 0;
  let stillIncomplete = 0;
  let skipped = 0;

  for (const link of links) {
    if (!link.ehEmployeeId) {
      skipped++;
      continue;
    }

    // Their stored match key (ADR-0011); a row from before it existed was synced by userId.
    const found = await deps.eh.getByExternalId(link.externalId ?? String(link.ctUserId));
    if (found.outcome !== "ok" || found.data === null) {
      // Transient EH fault, or the record has vanished - leave `employee_map`
      // untouched so this row is tried again on the next recheck.
      skipped++;
      continue;
    }

    const status = found.data.status ?? null;
    if ((status ?? "").toLowerCase().includes(INCOMPLETE)) {
      stillIncomplete++;
      continue;
    }

    // Notice first, then mark resolved (issue #94): a failed send leaves the
    // row on `follow_up`, so the next daily run checks it and tries again. If
    // the send works but the save below fails, tomorrow re-sends the notice -
    // a harmless repeat for admins, chosen over adding a claim.
    const person = await personRef(deps.ct, link.ctUserId);
    const sent = await deps.ct.sendChannelMessage(
      deps.adminChannelId,
      resolvedNoticeMessage(person, status ?? "Complete"),
    );
    if (sent.outcome !== "ok") {
      logEvent({
        evt: "message_send_failed",
        ctUserId: link.ctUserId,
        notice: "resolved",
        outcome: sent.outcome,
        status: sent.status,
      });
      skipped++;
      continue;
    }

    resolved++;
    await deps.store.saveEmployeeLink({
      ctUserId: link.ctUserId,
      ehEmployeeId: link.ehEmployeeId,
      lastSyncedTs: link.lastSyncedTs,
      lastPayloadHash: link.lastPayloadHash,
      lastOutcome: "resolved",
    });
    await deps.store.appendSyncLog({
      ctUserId: link.ctUserId,
      at: now(),
      outcome: "resolved",
      detail: `resolved: status now "${status ?? "(unknown)"}"`,
    });
  }

  return { status: "ok", checked: links.length, resolved, stillIncomplete, skipped, requeued: held.length };
}

/** Best-effort name for the notice; falls back to the id-only ref. */
async function personRef(
  ct: Pick<ConnecteamClient, "getUser">,
  ctUserId: number,
): Promise<PersonRef> {
  try {
    const res = await ct.getUser(ctUserId);
    if (res.outcome === "ok" && res.data) {
      return { ctUserId, firstName: res.data.firstName, lastName: res.data.lastName };
    }
  } catch {
    // keep the id-only ref
  }
  return { ctUserId };
}
