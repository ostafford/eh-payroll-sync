/**
 * The end-to-end sync for one queued job (issue #6). Given a Connecteam user id
 * it: resolves the user, maps them, upserts the Employment Hero record, reads it
 * back, runs {@link decide}, drives the failure-cycle state machine, sends any
 * message, and records the link + audit row. Replaying an old or unchanged event
 * is a no-op.
 *
 * Everything it touches is injected ({@link SyncDeps}) so it runs unchanged in a
 * unit test with fakes or in the Worker with real clients and D1. It never
 * throws for an expected retryable fault - it returns `status: "retry"` and lets
 * the queue handler call `message.retry()`.
 *
 * The queue retries a job up to 5 times, with a growing delay
 * ({@link retryDelaySeconds}), re-running it from the start. That is
 * only safe because every side effect below is idempotent (the EH upsert, the
 * link) or claimed before it happens (each message). A new side effect must be
 * one or the other - see docs/adr/0007. Every send's result is checked: a
 * failed one releases its claim and the job returns `status: "retry"` (#89).
 */
import type { SyncJob } from "./job.js";
import type { FieldMap } from "../mapping/schema.js";
import { applyFieldMap, leftOutBy, type ConnecteamUser as MappingUser } from "../mapping/apply.js";
import type { ConnecteamClient } from "../connecteam/client.js";
import type { CtResult, PayRate } from "../connecteam/types.js";
import type { EhPayrollClient } from "../eh/client.js";
import type { EhEmployee } from "../eh/types.js";
import {
  decide,
  compareReadBack,
  auditDetail,
  correctionFieldsFromAudit,
  type SyncDecision,
  type ReadBackResult,
} from "./decide.js";
import {
  correctionMessages,
  managerEscalationMessage,
  followUpNoticeMessage,
  systemAlertMessage,
  collisionAlertMessage,
  correctionTopics,
  firstSyncMessage,
  correctionFixedMessage,
  adminFirstSyncMessage,
  adminCorrectionFixedMessage,
  type PersonRef,
} from "./messages.js";
import { advanceCycle, directManagerUserId, MANAGER_ESCALATION_CYCLE } from "./cycles.js";
import { payloadHash } from "./canonical.js";
import { logEvent } from "../log.js";
import {
  noticeKey,
  shouldPostNotice,
  releaseNotice,
  type NoticeKind,
  FOLLOW_UP_NOTICE_DEDUPE_MS,
  SYSTEM_ALERT_NOTICE_DEDUPE_MS,
  CORRECTION_NOTICE_DEDUPE_MS,
} from "./notices.js";
import type { EmployeeLink, SyncGateway, SyncOutcomeLabel } from "./gateway.js";

export interface SyncDeps {
  ct: Pick<
    ConnecteamClient,
    "getUser" | "getPayRate" | "sendDirectMessage" | "sendChannelMessage"
  >;
  eh: Pick<EhPayrollClient, "upsertByExternalId" | "getByExternalId">;
  store: SyncGateway;
  fieldMap: FieldMap;
  /** Connecteam conversation id for the "EH Sync Alerts" channel. */
  adminChannelId: string;
  /** Overridable clock for the audit timestamp. */
  now?: () => number;
  /** Optional: also notify the integrator when a job dead-letters. Best-effort. */
  onSystemAlert?: (info: { ctUserId: number; reason: string }) => Promise<void>;
}

export type SyncJobStatus = "synced" | "correction" | "follow_up" | "skipped" | "retry" | "collision" | "excluded";

export interface SyncJobOutcome {
  status: SyncJobStatus;
  /** Redaction-safe explanation: skip reason, retry reason, or the decision detail. */
  reason: string;
  ehEmployeeId?: string;
  managerNotified?: boolean;
  /** A follow-up decision whose channel notice was suppressed as a recent duplicate. */
  noticeSuppressed?: boolean;
}

export async function runSyncJob(job: SyncJob, deps: SyncDeps): Promise<SyncJobOutcome> {
  const now = deps.now ?? Date.now;
  const { ctUserId, eventTimestamp } = job;

  // A `profile_update` job is the `user_updated` webhook firing - which fires on
  // every field save, including mid-onboarding, before a pack is ever Approved
  // (ADR-0002: the webhook only covers "ongoing edits AFTER approval"). Without
  // this gate, filling in one field at a time during onboarding would run a
  // full sync - and send a Correction/Manual-follow-up - on every keystroke's
  // worth of save, for data that was never meant to reach EH yet. `approval`
  // jobs are never gated here: the sweep only ever enqueues one the instant it
  // observes the completed transition, so it IS the approval signal.
  if (job.reason === "profile_update" && !(await deps.store.hasBeenApproved(ctUserId))) {
    return { status: "skipped", reason: "onboarding pack not yet approved" };
  }

  const link = await deps.store.getEmployeeLink(ctUserId);

  // Ordering / replay: last-write-wins on the Connecteam event time.
  if (link?.lastSyncedTs != null && eventTimestamp <= link.lastSyncedTs) {
    return { status: "skipped", reason: "stale or duplicate event" };
  }

  // Resolve the Connecteam user. A missing user is skipped, not a failure -
  // some onboarding assignments point at users that no longer exist.
  const userRes = await deps.ct.getUser(ctUserId);
  if (userRes.outcome === "retryable") return { status: "retry", reason: `connecteam unavailable: ${userRes.detail}` };
  if (userRes.outcome === "error") return { status: "retry", reason: `connecteam error ${userRes.status}` };
  if (userRes.data === null) return { status: "skipped", reason: "connecteam user no longer exists" };
  const user = userRes.data;

  // Left out of the sync by choice (rules.exclude), e.g. an employee type that
  // isn't paid through payroll: no EH call, no message. Recorded once, by field
  // name only (never the answer), so the status digest can count them.
  const excludedBy = leftOutBy(user as unknown as MappingUser, deps.fieldMap);
  if (excludedBy) {
    if (link?.lastOutcome === "excluded") return { status: "skipped", reason: "left out of the sync by choice" };
    const detail = `excluded: ${excludedBy}`;
    await deps.store.saveEmployeeLink({
      ctUserId,
      ehEmployeeId: link?.ehEmployeeId ?? null,
      lastSyncedTs: eventTimestamp,
      lastPayloadHash: null,
      lastOutcome: "excluded",
    });
    await deps.store.appendSyncLog({ ctUserId, at: now(), outcome: "excluded", detail });
    return { status: "excluded", reason: detail };
  }

  // Per-employee pay rate (issue #42): only when the client opted in via
  // `employmentHero.perEmployeeRate`. `applyFieldMap` is pure, so the network
  // call happens here and the result is passed in.
  let payRate: PayRate | null | undefined;
  if (deps.fieldMap.employmentHero.perEmployeeRate) {
    // Ask for the rate effective on the event date. The API returns one
    // `payRate` per user for the window; a same-day window = "the rate that
    // applies now". (Widen this if the live API rejects start == end.)
    const day = new Date(eventTimestamp).toISOString().slice(0, 10);
    const rateRes = await deps.ct.getPayRate(ctUserId, { startDate: day, endDate: day });
    if (rateRes.outcome === "retryable") {
      return { status: "retry", reason: `connecteam pay-rates unavailable: ${rateRes.detail}` };
    }
    if (rateRes.outcome === "error") {
      return { status: "retry", reason: `connecteam pay-rates error ${rateRes.status}` };
    }
    payRate = rateRes.data;
    if (payRate && Array.isArray(payRate.resourcesRates) && payRate.resourcesRates.length > 0) {
      // Per-resource overrides don't map to EH's single `rate` - we use
      // `defaultRate` and just note that overrides exist (redact drops values).
      logEvent({
        evt: "payrate_resource_overrides",
        ctUserId,
        rateType: payRate.rateType,
        overrides: payRate.resourcesRates.length,
      });
    }
  }

  let mapped = applyFieldMap(user as unknown as MappingUser, deps.fieldMap, { payRate });
  const hash = await payloadHash(mapped.payload);

  // Identical to the state we last processed. Connecteam fires one webhook per
  // changed field, so a multi-field edit is a burst of deliveries that all
  // resolve to the same mapped payload; run it once. This also stops an
  // employee stuck in a correction loop from being re-messaged (and their
  // failure cycle re-bumped) once per delivery in the burst. `lastPayloadHash`
  // is now stored on every terminal outcome, not only clean ones.
  if (link?.lastPayloadHash && link.lastPayloadHash === hash) {
    return { status: "skipped", reason: "identical to the last processed state" };
  }

  let ehEmployeeId = link?.ehEmployeeId ?? undefined;
  let decision: SyncDecision;

  // Re-map against EH's current record (issue #102): a pay-run value EH
  // already holds counts as set, and a `defaults` value it holds is left off
  // the write, so one set by hand in EH survives. The upsert reuses this
  // lookup, so it costs no extra call. The hash above stays EH-independent.
  let current: EhEmployee | null | undefined;
  if (mapped.issues.length === 0) {
    const found = await deps.eh.getByExternalId(mapped.externalId);
    if (found.outcome === "retryable") return { status: "retry", reason: `employment hero unavailable: ${found.detail}` };
    if (found.outcome !== "ok") return { status: "retry", reason: `employment hero error ${found.status}` };
    current = found.data;
    mapped = applyFieldMap(user as unknown as MappingUser, deps.fieldMap, { payRate, ehRecord: current });
  }

  if (mapped.issues.length > 0) {
    // The payload never leaves the Worker - the employee must fix it first.
    decision = decide({ mappingIssues: mapped.issues });
  } else if (mapped.payRunIssues.length > 0 && mapped.payRunBlocking) {
    // The pay-run LOCATION axis (defaults.paySchedule/primaryLocation/
    // primaryPayCategory) is unresolved - a field-map misconfiguration, not a
    // per-employee gap. EH 400s a partial set, so nothing is sent; the reasons
    // go to the admin channel as one follow-up instead.
    decision = decide({ payRunUnresolved: mapped.payRunIssues, followUps: mapped.followUps });
  } else {
    // Either the pay-run set is fully resolved, or the only gap is the
    // per-employee RATE axis (no classification picked yet / no Connecteam pay
    // rate on file) - a data gap for this one person, not a config bug. Create
    // or update their EH record now regardless (without pay-run keys, same as a
    // client who never configured a rate axis at all) and surface the gap as a
    // follow-up rather than leaving them absent from EH until someone gets to
    // it - safety net for a skipped admin field or a renamed award template.
    const followUps = [...mapped.payRunIssues, ...mapped.followUps];

    // Match order: stored link -> externalId (both handled by upsertByExternalId).
    // Email fallback for the very first match is deferred - it needs an EH
    // employee-search endpoint that issue #2 did not build/verify.
    const write = await deps.eh.upsertByExternalId(mapped.externalId, mapped.payload, current);
    if (write.outcome === "retryable") return { status: "retry", reason: `employment hero unavailable: ${write.detail}` };
    if (write.outcome === "client_error") return { status: "retry", reason: `employment hero error ${write.status}` };

    let readBack: ReadBackResult | undefined;
    if (write.outcome === "ok") {
      ehEmployeeId = String(write.data.id);

      // Employment Hero's unstructured-employee endpoint matches/merges by TFN
      // internally - a write for a brand-new externalId can still land on and
      // silently overwrite an EXISTING employee (even relabelling its
      // externalId) if the TFN collides. The read-back below can't catch this:
      // EH relabels the merged record's externalId too, so a read-back-by-
      // externalId finds exactly what we just sent. Check employee_map instead.
      const collidingCtUserId = await deps.store.findByEhEmployeeId(ehEmployeeId);
      if (collidingCtUserId !== null && collidingCtUserId !== ctUserId) {
        const key = await noticeKey("collision", ctUserId, [ehEmployeeId]);
        if (await shouldPostNotice(deps.store, key, SYSTEM_ALERT_NOTICE_DEDUPE_MS, now())) {
          const text = collisionAlertMessage(
            ehEmployeeId,
            { ctUserId, firstName: user.firstName, lastName: user.lastName },
            collidingCtUserId,
          );
          const sent = await sendClaimed(deps.store, key, ctUserId, "collision", () =>
            deps.ct.sendChannelMessage(deps.adminChannelId, text),
          );
          // Before the audit row, so the retry doesn't write a second one.
          if (!sent) return sendFailed("collision");
        }
        await deps.store.appendSyncLog({
          ctUserId,
          at: now(),
          outcome: "collision",
          detail: `collision: EH employee ${ehEmployeeId} already linked to Connecteam user ${collidingCtUserId}`,
        });
        // Deliberately not saved as a link and the failure cycle is left
        // untouched - this isn't a normal sync outcome for this person, it's
        // two people's records needing a human to untangle them in EH.
        return {
          status: "collision",
          reason: `EH employee ${ehEmployeeId} already linked to Connecteam user ${collidingCtUserId}`,
        };
      }

      const rb = await deps.eh.getByExternalId(mapped.externalId);
      if (rb.outcome === "ok" && rb.data) {
        readBack = compareReadBack(
          mapped.payload,
          rb.data as Record<string, unknown>,
          readBackFields(deps.fieldMap),
        );
      }
    }
    decision = decide({
      write,
      followUps,
      payRunDefaultsComplete: mapped.payRunDefaultsComplete,
      ...(readBack ? { readBack } : {}),
    });
  }

  if (decision.kind === "retry") return { status: "retry", reason: decision.detail };

  const person = { ctUserId, firstName: user.firstName, lastName: user.lastName };

  let managerNotified = false;
  let noticeSuppressed = false;
  if (decision.kind === "correction") {
    // Retry-safety: a queue redelivery of this exact job (a crash after the DM
    // went out but before the ack, or a retry after a failed send) must not
    // re-bump the failure-cycle count or re-message anyone who already got it.
    // Key on the mapped-payload hash rather than the decision's reasons, so a
    // genuine subsequent edit - which always changes the hash - still gets its
    // own Correction message. The employee and the Direct manager each have
    // their own claim, so a failed manager DM can be retried without DMing the
    // employee twice (issue #89).
    // A Correction too long for one message goes as numbered parts, each with
    // its own claim (the first keeps the single-message key), so a retry after
    // a failed later part sends only what's missing.
    const parts = correctionMessages(decision.fields, deps.fieldMap.messages.profilePath, deps.fieldMap.messages.automatedNote);
    let sentPart = false;
    for (const [i, text] of parts.entries()) {
      const key = await noticeKey("correction", ctUserId, i === 0 ? [hash] : [hash, `part ${i + 1}`]);
      if (!(await shouldPostNotice(deps.store, key, CORRECTION_NOTICE_DEDUPE_MS, now()))) continue;
      const sent = await sendClaimed(deps.store, key, ctUserId, "correction", () => deps.ct.sendDirectMessage(ctUserId, text));
      if (!sent) return sendFailed("correction");
      sentPart = true;
    }
    let escalate: boolean;
    if (sentPart) {
      // Bumped only once the employee has the message, so a failed send leaves
      // nothing to undo. The cycle count is saved before the manager DM, so a
      // retry of a failed manager DM reads it back below.
      const cycle = await advanceCycle(deps.store, ctUserId, decision);
      escalate = cycle.action === "correction" && cycle.notifyManager;
    } else {
      noticeSuppressed = true;
      escalate = (await deps.store.getFailureCount(ctUserId)) >= MANAGER_ESCALATION_CYCLE;
    }

    const managerId = escalate ? directManagerUserId(user.customFields) : null;
    if (managerId !== null) {
      const managerKey = await noticeKey("manager_escalation", ctUserId, [hash]);
      if (await shouldPostNotice(deps.store, managerKey, CORRECTION_NOTICE_DEDUPE_MS, now())) {
        const sent = await sendClaimed(deps.store, managerKey, ctUserId, "manager_escalation", () =>
          deps.ct.sendDirectMessage(managerId, managerEscalationMessage(decision.fields, person, deps.fieldMap.messages.automatedNote)),
        );
        if (!sent) return sendFailed("manager_escalation");
        managerNotified = true;
      }
    }
  } else {
    // The success messages (#71) go out BEFORE advanceCycle resets the cycle,
    // so a failed send retries with the cycle still open and picks the same
    // wording. One claim per recipient covers both wordings: after a reset, a
    // retry would choose the other one, and its own key would let it send twice.
    // The employee and the admin channel each have their own claim, so a failed
    // admin send can be retried without DMing the employee twice.
    const { employeeSuccess, adminSuccess } = deps.fieldMap.messages;
    const success = employeeSuccess || adminSuccess ? await successKind(link, deps.store) : null;
    if (success && employeeSuccess) {
      const key = await noticeKey("employee_success", ctUserId, [hash]);
      if (await shouldPostNotice(deps.store, key, CORRECTION_NOTICE_DEDUPE_MS, now())) {
        const sent = await sendClaimed(deps.store, key, ctUserId, "employee_success", () =>
          deps.ct.sendDirectMessage(ctUserId, employeeSuccessText(success, deps.fieldMap.messages.automatedNote)),
        );
        if (!sent) return sendFailed("employee_success");
      }
    }
    // A follow-up posts its own notice to the channel below, which already
    // says the sync completed, so the ✅ is only for a clean sync.
    if (success && adminSuccess && decision.kind === "ok") {
      const key = await noticeKey("admin_success", ctUserId, [hash]);
      if (await shouldPostNotice(deps.store, key, CORRECTION_NOTICE_DEDUPE_MS, now())) {
        const sent = await sendClaimed(deps.store, key, ctUserId, "admin_success", () =>
          deps.ct.sendChannelMessage(deps.adminChannelId, adminSuccessText(success, person)),
        );
        if (!sent) return sendFailed("admin_success");
      }
    }
    await advanceCycle(deps.store, ctUserId, decision);
    if (decision.kind === "follow_up") {
      // The record synced (safe defaults); a payroll admin still has to finish it
      // by hand in EH. While that stays undone, every later profile edit lands
      // here again with the same reason - post it once per window, not per edit.
      const key = await noticeKey("follow_up", ctUserId, decision.reasons);
      if (await shouldPostNotice(deps.store, key, FOLLOW_UP_NOTICE_DEDUPE_MS, now())) {
        const sent = await sendClaimed(deps.store, key, ctUserId, "follow_up", () =>
          deps.ct.sendChannelMessage(deps.adminChannelId, followUpNoticeMessage(decision.reasons, person)),
        );
        // The cycle reset above is idempotent, so the retry may repeat it.
        if (!sent) return sendFailed("follow_up");
      } else {
        noticeSuppressed = true;
      }
    }
  }

  // Store the hash on every terminal outcome so an identical re-delivery is
  // skipped above. A genuine later edit changes the mapped payload -> new hash
  // -> it is processed again. `lastOutcome` is what the daily recheck pass
  // (#43) uses to find every employee stuck on a Manual-follow-up without
  // scanning sync_log.
  const outcome = outcomeLabel(decision);
  await deps.store.saveEmployeeLink({
    ctUserId,
    ehEmployeeId: ehEmployeeId ?? null,
    lastSyncedTs: eventTimestamp,
    lastPayloadHash: hash,
    lastOutcome: outcome,
  });
  await deps.store.appendSyncLog({
    ctUserId,
    at: now(),
    outcome,
    detail: auditDetail(decision),
  });

  return {
    status: decision.kind === "ok" ? "synced" : decision.kind,
    reason: auditDetail(decision),
    ...(ehEmployeeId ? { ehEmployeeId } : {}),
    managerNotified,
    ...(noticeSuppressed ? { noticeSuppressed: true } : {}),
  };
}

/** Minimal shape of a queue message / batch, so batch routing is runtime-agnostic. */
export interface QueueMessageLike<B> {
  body: B;
  /** Delivery number, starting at 1 (Cloudflare's `Message.attempts`). */
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

const RETRY_BASE_DELAY_SECONDS = 30;
const RETRY_MAX_DELAY_SECONDS = 8 * 60;

/**
 * How long to wait before redelivering a job whose delivery number `attempts`
 * just failed (issue #90). With no delay, Cloudflare redelivers a retry in the
 * next batch, so all 5 retries could be spent within seconds of a blip.
 * Doubling from 30 s (30, 60, 120, 240, 480) puts the last delivery ~15.5 min
 * after the first: long enough to ride out a short outage, and well inside
 * the 1 h Correction claim, so a late retry can't re-send a message
 * (ADR-0007). `test/sync-consumer.test.ts` checks both against `max_retries`.
 */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(RETRY_BASE_DELAY_SECONDS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_DELAY_SECONDS);
}
export interface QueueBatchLike<B> {
  queue: string;
  messages: readonly QueueMessageLike<B>[];
}

/**
 * Route one delivered batch. Messages off the dead-letter queue raise a System
 * alert and are always acked; sync messages ack on a terminal outcome and retry
 * on a retryable fault or an unexpected throw.
 */
export async function dispatchBatch(
  batch: QueueBatchLike<SyncJob>,
  deps: SyncDeps,
  dlqName: string,
): Promise<void> {
  if (batch.queue === dlqName) {
    for (const message of batch.messages) {
      try {
        await handleDeadLetter(message.body, deps);
      } catch {
        // Best effort - a failed alert must not loop the dead-letter queue.
      } finally {
        message.ack();
      }
    }
    await bump(deps, "dl_total", batch.messages.length);
    return;
  }

  // Connecteam fires one `user_updated` delivery per changed field, so a single
  // profile edit arrives as a burst of jobs for the same user in one batch.
  // Run only the newest per user; ack the rest without running a sync, a message
  // or a failure-cycle bump. They still count toward `acked_total` — every
  // enqueued message must land in `acked_total` or `dl_total` or the /health
  // `queueBacklog` gauge (enqueued - acked - dead-lettered) never returns to 0.
  // (A burst split across batches is still deduped by the stale-event guard in
  // runSyncJob once the first job has written `lastSyncedTs`.)
  let acked = 0;
  const newestPerUser = new Map<number, QueueMessageLike<SyncJob>>();
  for (const message of batch.messages) {
    const prev = newestPerUser.get(message.body.ctUserId);
    if (!prev || message.body.eventTimestamp > prev.body.eventTimestamp) {
      if (prev) {
        prev.ack();
        acked++;
      }
      newestPerUser.set(message.body.ctUserId, message);
    } else {
      message.ack();
      acked++;
    }
  }

  for (const message of newestPerUser.values()) {
    try {
      const outcome = await runSyncJob(message.body, deps);
      if (outcome.status === "retry") message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      else {
        message.ack();
        acked++;
      }
    } catch {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
  await bump(deps, "acked_total", acked);
}

async function bump(deps: SyncDeps, key: string, delta: number): Promise<void> {
  if (delta > 0) await deps.store.bumpCounter(key, delta);
}

/** DLQ handler: a job that exhausted its retries. Raise a System alert. */
export async function handleDeadLetter(
  job: SyncJob,
  deps: Pick<SyncDeps, "ct" | "store" | "adminChannelId" | "now" | "onSystemAlert">,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const detail = `the sync exceeded its retry limit (trigger "${job.reason}")`;

  // A user whose job keeps dead-lettering (EH auth down, a mapping bug) would
  // otherwise post an identical alert on every retry-exhaustion. Post it once
  // per window; the audit row below is still written every time.
  const key = await noticeKey("system_alert", job.ctUserId, [detail]);
  if (await shouldPostNotice(deps.store, key, SYSTEM_ALERT_NOTICE_DEDUPE_MS, now())) {
    // Best effort: put the employee's name in the alert. The sync is already
    // failing, so a failed lookup just falls back to the id.
    let person: PersonRef = { ctUserId: job.ctUserId };
    try {
      const res = await deps.ct.getUser(job.ctUserId);
      if (res.outcome === "ok" && res.data) {
        person = { ctUserId: job.ctUserId, firstName: res.data.firstName, lastName: res.data.lastName };
      }
    } catch {
      // keep the id-only ref
    }
    // A dead-letter is always acked, so a failed alert can't be retried here.
    // Releasing the claim lets the next dead-letter for this user post it.
    await sendClaimed(deps.store, key, job.ctUserId, "system_alert", () =>
      deps.ct.sendChannelMessage(deps.adminChannelId, systemAlertMessage(detail, person)),
    );
  }
  await deps.store.appendSyncLog({
    ctUserId: job.ctUserId,
    at: now(),
    outcome: "dead_letter",
    detail: "retries exhausted",
  });
  if (deps.onSystemAlert) {
    await deps.onSystemAlert({ ctUserId: job.ctUserId, reason: `retries exhausted (${job.reason})` });
  }
}

/**
 * Send one claimed message and report whether it went out (issue #89). On a
 * failed result - or a throw - release the claim so the job's retry sends it,
 * and log `message_send_failed`. Never throws for a failed send.
 */
async function sendClaimed(
  store: Pick<SyncGateway, "setMarker">,
  key: string,
  ctUserId: number,
  notice: NoticeKind,
  send: () => Promise<CtResult<null>>,
): Promise<boolean> {
  let res: CtResult<null> | { outcome: "threw" };
  try {
    res = await send();
  } catch {
    res = { outcome: "threw" };
  }
  if (res.outcome === "ok") return true;
  await releaseNotice(store, key);
  logEvent({
    evt: "message_send_failed",
    ctUserId,
    notice,
    outcome: res.outcome,
    ...("status" in res ? { status: res.status } : {}),
  });
  return false;
}

/** Outcomes that mean the person has synced successfully before. */
const SYNCED_BEFORE: readonly SyncOutcomeLabel[] = ["ok", "follow_up", "resolved"];

type SuccessKind = { kind: "first" } | { kind: "fixed"; topics: string[] };

/**
 * Which success (#71) a job that just synced successfully is, judged from the
 * person's state BEFORE this job, or null for an ordinary edit:
 * - an open Correction cycle -> "fixed", with the topics it asked about
 * - never synced before -> "first"
 * A row saved before `lastOutcome` existed counts as synced if it has an EH id.
 */
async function successKind(
  link: EmployeeLink | null,
  store: Pick<SyncGateway, "latestCorrectionDetail">,
): Promise<SuccessKind | null> {
  if (link && link.failureCycleCount > 0) {
    const fields = correctionFieldsFromAudit(await store.latestCorrectionDetail(link.ctUserId));
    return { kind: "fixed", topics: correctionTopics(fields.map((field) => ({ field, reason: "" }))) };
  }
  const syncedBefore =
    link !== null &&
    (link.lastOutcome != null ? SYNCED_BEFORE.includes(link.lastOutcome) : link.ehEmployeeId !== null);
  return syncedBefore ? null : { kind: "first" };
}

function employeeSuccessText(s: SuccessKind, note: string): string {
  return s.kind === "first" ? firstSyncMessage(note) : correctionFixedMessage(s.topics, note);
}

function adminSuccessText(s: SuccessKind, person: PersonRef): string {
  return s.kind === "first" ? adminFirstSyncMessage(person) : adminCorrectionFixedMessage(person, s.topics);
}

function sendFailed(notice: NoticeKind): SyncJobOutcome {
  return { status: "retry", reason: `connecteam send failed: ${notice}` };
}

function outcomeLabel(decision: SyncDecision): SyncOutcomeLabel {
  switch (decision.kind) {
    case "ok":
      return "ok";
    case "correction":
      return "correction";
    case "follow_up":
      return "follow_up";
    case "retry":
      return "retry";
  }
}

/**
 * Fields safe to compare on read-back: plain string pass-throughs only. Dates,
 * zero-pads, phone, dropdowns and locations are skipped - EH may return them in
 * a different-but-equivalent format, which would read as a false mismatch. TFN
 * and bank values are never re-fetched.
 */
function readBackFields(map: FieldMap): string[] {
  return map.fields
    .filter((f) => !f.sensitive && !f.map && (f.transform === "trimString" || f.transform === "lowerTrim"))
    .map((f) => f.eh);
}
