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
import { FOLLOW_UP } from "../mapping/rules.js";
import {
  applyFieldMap,
  leftOutBy,
  type ConnecteamUser as MappingUser,
  type MappingResult,
  type PayloadValue,
} from "../mapping/apply.js";
import type { ConnecteamClient } from "../connecteam/client.js";
import type { CtResult, PayRate } from "../connecteam/types.js";
import type { EhPayrollClient, EhResult } from "../eh/client.js";
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
  existingMatchMessages,
  PAYROLL_ID_TYPO_HINT,
  copyPayrollIdHint,
  linkNoticeMessage,
  linkBlockedMessage,
  payrollIdChangedMessage,
  clearedFieldsMessage,
  baselineKeyChangedMessage,
  type LinkBlock,
  type PersonRef,
} from "./messages.js";
import { runPreCreateCheck, existingMatchDetail, compareKeys, isTerminated, type ExistingMatch, type MatchKey } from "./precheck.js";
import { advanceCycle, directManagerUserId, MANAGER_ESCALATION_CYCLE } from "./cycles.js";
import { payloadHash } from "./canonical.js";
import {
  baselineKeyId,
  changedUnits,
  clearedFields,
  newUnits,
  takeBaseline,
  unitOf,
  UNIT,
  type GroupUnit,
  type PayRunKey,
} from "./baseline.js";
import { logEvent } from "../log.js";
import {
  noticeKey,
  shouldPostNotice,
  releaseNotice,
  sendClaimed,
  type NoticeKind,
  FOLLOW_UP_NOTICE_DEDUPE_MS,
  HELD_NOTICE_DEDUPE_MS,
  SYSTEM_ALERT_NOTICE_DEDUPE_MS,
  CORRECTION_NOTICE_DEDUPE_MS,
  NO_EMPLOYEE,
} from "./notices.js";
import type { Baseline, EmployeeLink, LinkGateway, RollupGateway, RollupKind, SyncGateway, SyncOutcomeLabel } from "./gateway.js";
import { inBurst } from "./rollup.js";

export interface SyncDeps {
  ct: Pick<
    ConnecteamClient,
    "getUser" | "getPayRate" | "sendDirectMessage" | "sendChannelMessage"
  >;
  eh: Pick<EhPayrollClient, "upsertByExternalId" | "getByExternalId" | "findEmployees" | "getEmployee" | "setExternalId">;
  /**
   * `getPendingLink`: a confirmed link is made on the first approval, and a
   * "New hire, not this person" row skips the Pre-create check.
   * `countRecentNotices` / `recordNotice`: a burst of Existing-match, Link or Admin success
   * notices rolls up into one Bulk summary (#193, #199).
   */
  store: SyncGateway &
    Pick<LinkGateway, "getPendingLink" | "completeLink" | "saveBaseline"> &
    Pick<RollupGateway, "countRecentNotices" | "recordNotice">;
  /** `BASELINE_KEY`: keys a Linked employee's Baseline fingerprints (ADR-0009). */
  baselineKey: string;
  fieldMap: FieldMap;
  /** Connecteam conversation id for the "EH Sync Alerts" channel. */
  adminChannelId: string;
  /** Overridable clock for the audit timestamp. */
  now?: () => number;
  /** Optional: also notify the integrator when a job dead-letters. Best-effort. */
  onSystemAlert?: (info: { ctUserId: number; reason: string }) => Promise<void>;
}

export type SyncJobStatus =
  | "synced"
  | "correction"
  | "follow_up"
  | "skipped"
  | "retry"
  | "collision"
  | "excluded"
  /** A Held employee: the Pre-create check found them already in EH (ADR-0010). */
  | "held";

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
  const person: PersonRef = { ctUserId, firstName: user.firstName, lastName: user.lastName };

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
  // The Payroll ID to match EH by: the one stored at their first sync or
  // link, so a later edit to the field it came from can't re-key them
  // (ADR-0011). Someone never synced takes the freshly mapped one.
  const matchKey = link?.externalId ?? mapped.externalId;

  // Identical to the state we last processed. Connecteam fires one webhook per
  // changed field, so a multi-field edit is a burst of deliveries that all
  // resolve to the same mapped payload; run it once. This also stops an
  // employee stuck in a correction loop from being re-messaged (and their
  // failure cycle re-bumped) once per delivery in the burst. `lastPayloadHash`
  // is now stored on every terminal outcome, not only clean ones, except a
  // hold (see holdExisting) and a left-out person.
  if (link?.lastPayloadHash && link.lastPayloadHash === hash) {
    return { status: "skipped", reason: "identical to the last processed state" };
  }

  // Their key changed in Connecteam since it was fixed: keep the stored one,
  // and tell the admin once per new value. Before anything is written, so a
  // failed send retries the whole job.
  if (matchKey !== mapped.externalId) {
    const key = await noticeKey("payroll_id_changed", ctUserId, [mapped.externalId]);
    if (await shouldPostNotice(deps.store, key, "forever", now())) {
      const text = payrollIdChangedMessage(person);
      const sent = await sendClaimed(deps.store, key, ctUserId, "payroll_id_changed", () =>
        deps.ct.sendChannelMessage(deps.adminChannelId, text),
      );
      if (!sent) return sendFailed("payroll_id_changed");
    }
  }

  // A Linked employee never gets a full-profile sync (ADR-0009): that would
  // overwrite what EH holds for them. Only what changed since their Baseline goes.
  if (link?.linkedAt) {
    return syncChangedUnits(deps, { link, user, person, mapped, payRate, matchKey, hash, eventTimestamp, now });
  }

  // A confirmed link (ADR-0009): someone never synced before, with a
  // pending link to an EH employee, is linked on this approval. Only the
  // Payroll ID is written; nothing else about them reaches EH.
  const pending = await deps.store.getPendingLink(ctUserId);
  if (pending?.ehEmployeeId && !hasSyncedBefore(link)) {
    return linkOnApproval(deps, {
      person,
      link,
      ehEmployeeId: pending.ehEmployeeId,
      externalId: matchKey,
      payload: mapped.payload,
      unmapped: mapped.issues.map((i) => i.ehField),
      hash,
      eventTimestamp,
      now: now(),
    });
  }

  // A Payroll ID the client copied into Connecteam (ADR-0011): when it finds
  // someone in EH on their first sync, they're a Pre-existing employee, linked
  // with no EH write, but only if another detail agrees with that record.
  // Kept for the lookup below when it found nobody, so EH isn't asked twice.
  let prefetched: EhEmployee | null | undefined;
  if (mapped.externalIdFromField && !hasSyncedBefore(link)) {
    const found = await deps.eh.getByExternalId(matchKey);
    if (found.outcome !== "ok") return ehRetry(found);
    prefetched = found.data;
    if (found.data) {
      const keys = compareKeys(mapped.payload, found.data);
      if (keys.agree.length > 0) {
        return linkOnApproval(deps, {
          person,
          link,
          ehEmployeeId: String(found.data.id),
          externalId: matchKey,
          payload: mapped.payload,
          unmapped: mapped.issues.map((i) => i.ehField),
          differs: keys.differs,
          hash,
          eventTimestamp,
          now: now(),
        });
      }
      return holdExisting(deps, {
        person,
        matches: [
          { ehEmployeeId: found.data.id, terminated: isTerminated(found.data), matched: [], differs: keys.differs, byPayrollId: true },
        ],
        storedEhEmployeeId: link?.ehEmployeeId ?? null,
        eventTimestamp,
        now: now(),
      });
    }
  }

  let ehEmployeeId = link?.ehEmployeeId ?? undefined;
  let decision: SyncDecision;
  // Set once EH accepts a write under the key: stored if they have none yet.
  let keyToStore: string | null = null;

  // Re-map against EH's current record (issue #102): a pay-run value EH
  // already holds counts as set, and a `defaults` value it holds is left off
  // the write, so one set by hand in EH survives. The upsert reuses this
  // lookup, so it costs no extra call. The hash above stays EH-independent.
  let current: EhEmployee | null | undefined;
  if (mapped.issues.length === 0) {
    if (prefetched !== undefined) current = prefetched;
    else {
      const found = await deps.eh.getByExternalId(matchKey);
      if (found.outcome !== "ok") return ehRetry(found);
      current = found.data;
    }
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

    // About to create: no EH record carries this Payroll ID. Run the
    // Pre-create check first (ADR-0010) unless the admin already confirmed
    // them as "New hire, not this person" (a pending link with no EH id).
    const confirmedNewHire = current === null && pending?.ehEmployeeId === null;
    if (current === null && !confirmedNewHire) {
      const check = await runPreCreateCheck(deps.eh, mapped.payload);
      if (check.outcome !== "ok") return ehRetry(check);
      if (check.data.length > 0) {
        return holdExisting(deps, {
          person,
          matches: check.data,
          // Normally none. One we stored whose record EH no longer finds by
          // Payroll ID (relabelled or deleted there) is kept, not wiped.
          storedEhEmployeeId: link?.ehEmployeeId ?? null,
          notes: payrollIdNotes(user as unknown as MappingUser, deps.fieldMap, mapped, matchKey, check.data),
          eventTimestamp,
          now: now(),
        });
      }
    }

    // Match order: stored link -> externalId (both handled by upsertByExternalId).
    // A create goes out with EH's own merge off (`matchType=None`).
    const step = await writeAndDecide(deps, {
      matchKey,
      payload: mapped.payload,
      ehRecord: current,
      followUps,
      payRunDefaultsComplete: mapped.payRunDefaultsComplete,
      // A merge the write landed on is a Collision, not a sync.
      onAccepted: (writtenId) => collisionOutcome(deps, person, writtenId, now),
    });
    if ("outcome" in step) return step.outcome;
    decision = step.decision;
    if (step.ehEmployeeId !== null) {
      ehEmployeeId = step.ehEmployeeId;
      keyToStore = matchKey;
    }
  }

  return settle(deps, { link, user, person, hash, decision, ehEmployeeId, keyToStore, eventTimestamp, now });
}

/** What a sync carries from the start of its job to {@link settle}. */
interface SyncContext {
  link: EmployeeLink | null;
  user: { customFields: Parameters<typeof directManagerUserId>[0] };
  person: PersonRef;
  hash: string;
  eventTimestamp: number;
  now: () => number;
}

/**
 * Write a payload to EH, read back what was sent, and decide: the step a full
 * sync and a Linked employee's changed-units sync share. `onAccepted` runs
 * once EH accepts the write, before the read-back: an outcome it returns ends
 * the sync. `ehEmployeeId` is set only when EH accepted the write.
 */
async function writeAndDecide(
  deps: SyncDeps,
  write: {
    matchKey: string;
    payload: Record<string, PayloadValue>;
    ehRecord: EhEmployee | null | undefined;
    followUps: string[];
    payRunDefaultsComplete: boolean;
    onAccepted?: (ehEmployeeId: string) => Promise<SyncJobOutcome | null>;
  },
): Promise<{ outcome: SyncJobOutcome } | { decision: SyncDecision; ehEmployeeId: string | null }> {
  const result = await deps.eh.upsertByExternalId(write.matchKey, write.payload, write.ehRecord);
  // A validation failure isn't retried: it's the employee's to fix (decide below).
  if (result.outcome === "retryable" || result.outcome === "client_error") return { outcome: ehRetry(result) };

  let ehEmployeeId: string | null = null;
  let readBack: ReadBackResult | undefined;
  if (result.outcome === "ok") {
    ehEmployeeId = String(result.data.id);
    const stop = await write.onAccepted?.(ehEmployeeId);
    if (stop) return { outcome: stop };
    // Only what was sent is read back: EH is the source of truth for the rest.
    const written = await deps.eh.getByExternalId(write.matchKey);
    if (written.outcome === "ok" && written.data) {
      readBack = compareReadBack(write.payload, written.data as Record<string, unknown>, readBackFields(deps.fieldMap));
    }
  }
  const decision = decide({
    write: result,
    followUps: write.followUps,
    payRunDefaultsComplete: write.payRunDefaultsComplete,
    ...(readBack ? { readBack } : {}),
  });
  return { decision, ehEmployeeId };
}

/**
 * The Collision backstop, run once EH accepts a full sync's write: the EH
 * employee written is already linked to someone else. Null when it isn't.
 */
async function collisionOutcome(
  deps: SyncDeps,
  person: PersonRef,
  writtenId: string,
  now: () => number,
): Promise<SyncJobOutcome | null> {
  const { ctUserId } = person;
  // Backstop (ADR-0010): creates now go out with `matchType=None` after the
  // Pre-create check, but EH's unstructured endpoint used to match/merge by
  // TFN - a write for a brand-new externalId could land on and silently
  // overwrite an EXISTING employee (even relabelling its externalId). The
  // read-back after it can't catch this: EH relabels the merged record's
  // externalId too, so a read-back-by-externalId finds exactly what we just
  // sent. Check employee_map instead.
  const collidingCtUserId = await deps.store.findByEhEmployeeId(writtenId);
  if (collidingCtUserId !== null && collidingCtUserId !== ctUserId) {
    const key = await noticeKey("collision", ctUserId, [writtenId]);
    if (await shouldPostNotice(deps.store, key, SYSTEM_ALERT_NOTICE_DEDUPE_MS, now())) {
      const text = collisionAlertMessage(writtenId, person, collidingCtUserId);
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
      detail: `collision: EH employee ${writtenId} already linked to Connecteam user ${collidingCtUserId}`,
    });
    // Deliberately not saved as a link and the failure cycle is left
    // untouched - this isn't a normal sync outcome for this person, it's
    // two people's records needing a human to untangle them in EH.
    return {
      status: "collision",
      reason: `EH employee ${writtenId} already linked to Connecteam user ${collidingCtUserId}`,
    };
  }
  return null;
}

/**
 * The end of every sync that reached a decision: send its messages, move the
 * failure cycle, and record the outcome. Each send is claimed first and
 * checked (ADR-0007, #89), so a retry re-runs this safely.
 */
async function settle(
  deps: SyncDeps,
  settling: SyncContext & {
    decision: SyncDecision;
    ehEmployeeId: string | undefined;
    keyToStore: string | null;
  },
): Promise<SyncJobOutcome> {
  const { link, user, person, hash, decision, ehEmployeeId, keyToStore, eventTimestamp, now } = settling;
  const { ctUserId } = person;
  if (decision.kind === "retry") return { status: "retry", reason: decision.detail };

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
      // In a burst a first sync's ✅ rolls up into the Bulk summary (#199). A
      // fixed Correction names what was fixed and comes one at a time, so it's
      // always sent and never counted. Counted before the claim, as for a Link notice.
      const at = now();
      const firstSync = success.kind === "first";
      const rollUp = firstSync && (await inBurst(deps.store, "admin_success", at));
      const key = await noticeKey("admin_success", ctUserId, [hash]);
      if (await shouldPostNotice(deps.store, key, CORRECTION_NOTICE_DEDUPE_MS, at)) {
        if (!rollUp) {
          const sent = await sendClaimed(deps.store, key, ctUserId, "admin_success", () =>
            deps.ct.sendChannelMessage(deps.adminChannelId, adminSuccessText(success, person)),
          );
          if (!sent) return sendFailed("admin_success");
        }
        if (firstSync) await recordRollup(deps.store, "admin_success", ctUserId, at, rollUp, [key]);
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
    externalId: keyToStore,
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

/**
 * What a hold's notice adds for a client whose Payroll IDs come from a
 * Connecteam field (ADR-0011): a copied ID that EH was asked for and found
 * nobody by may be a typo; a blank one, where a match already has a Payroll
 * ID, should be filled in. A stored key looked up instead gets neither.
 */
function payrollIdNotes(
  user: MappingUser,
  map: FieldMap,
  mapped: Pick<MappingResult, "externalId" | "externalIdFromField">,
  matchKey: string,
  matches: readonly ExistingMatch[],
): string[] {
  const from = map.identity.externalIdFrom;
  if (from === "userId" || matchKey !== mapped.externalId) return [];
  if (mapped.externalIdFromField) return [PAYROLL_ID_TYPO_HINT];
  if (!matches.some((m) => m.hasPayrollId)) return [];
  // The profile's name is the current one; the stored one covers a blank field Connecteam leaves off the profile.
  const live = user.customFields.find((f) => f.customFieldId === from.customFieldId)?.name.trim();
  return [copyPayrollIdHint(live || from.name || "their Payroll ID field")];
}

/**
 * A Held employee (ADR-0010): write nothing to EH, post one claimed
 * Existing-match notice to the admin channel (nothing to the employee), then
 * record `existing_match` with no EH id. The notice goes before the rows, as
 * the collision path does, so a retry after a failed send re-runs the check
 * and finds its claims: a re-run of the same job never posts it twice. A part
 * already sent keeps its claim; only a failed one is released.
 *
 * No payload hash is stored, unlike other outcomes: once the admin resolves
 * the hold, the same profile must run again (the daily recheck re-enqueues it,
 * ADR-0010), not be skipped as "identical to the last processed state". A
 * redelivery of this same job is still skipped by the stale-event guard.
 */
async function holdExisting(
  deps: SyncDeps,
  held: {
    person: PersonRef;
    matches: readonly ExistingMatch[];
    storedEhEmployeeId: string | null;
    /** Extra lines for the notice, before "To fix". */
    notes?: readonly string[];
    eventTimestamp: number;
    now: number;
  },
): Promise<SyncJobOutcome> {
  const { person, matches } = held;
  const { ctUserId } = person;
  const detail = existingMatchDetail(matches);
  // Keyed by what the notice says (candidates, keys and any Payroll ID hint),
  // not the payload hash: a later profile edit that changes none of that
  // doesn't repost it within the window, nor does the daily recheck's re-run
  // (#155). The digest is the reminder (#143 item 5). A hold with no hint keeps the key it had before hints.
  // In a burst (#193) each part is still claimed, so a re-run skips it, but
  // not sent: the person is recorded for the Bulk summary instead. Counted
  // before any claim, so a failed count leaves nothing claimed. A notice whose
  // earlier part already went out (a retry after a later part failed) is
  // finished one by one, so the admin never gets half of it.
  const shown = [detail, ...(held.notes ?? [])];
  let rollUp = await inBurst(deps.store, "existing_match", held.now);
  const claimed: string[] = [];
  for (const [i, text] of existingMatchMessages(person, matches, held.notes).entries()) {
    const key = await noticeKey("existing_match", ctUserId, i === 0 ? shown : [...shown, `part ${i + 1}`]);
    if (!(await shouldPostNotice(deps.store, key, HELD_NOTICE_DEDUPE_MS, held.now))) {
      rollUp = false;
      continue;
    }
    claimed.push(key);
    if (rollUp) continue;
    const sent = await sendClaimed(deps.store, key, ctUserId, "existing_match", () =>
      deps.ct.sendChannelMessage(deps.adminChannelId, text),
    );
    if (!sent) return sendFailed("existing_match");
  }
  if (claimed.length > 0) await recordRollup(deps.store, "existing_match", ctUserId, held.now, rollUp, claimed);
  await deps.store.saveEmployeeLink({
    ctUserId,
    ehEmployeeId: held.storedEhEmployeeId,
    lastSyncedTs: held.eventTimestamp,
    lastPayloadHash: null,
    lastOutcome: "existing_match",
  });
  await deps.store.appendSyncLog({ ctUserId, at: held.now, outcome: "existing_match", detail });
  return { status: "held", reason: detail };
}

/**
 * Make a confirmed link on the first approval (ADR-0009, #150): set the
 * Payroll ID on the chosen EH employee and nothing else, then record them as
 * a Linked employee with their first Baseline. The link counts as their first
 * sync. Its one message is the Link notice: no Success message, no Admin
 * success notice, nothing to the employee.
 *
 * Every step is safe to re-run (ADR-0007):
 *   - the EH employee is re-checked first, so once a retry finds this Payroll
 *     ID already on it, it skips the write;
 *   - the Link notice is claimed before it goes out, and sent before the rows,
 *     so a crash after it doesn't post it twice;
 *   - the `employee_map` row, `linked_at`, Baseline and the `pending_link`
 *     delete are one D1 batch, so no re-run can find the person synced but
 *     not linked (which would send them a full sync).
 *
 * A link that can't be made writes nothing to EH and posts a System alert
 * (claimed the same way). The pending link stays, for the admin to fix in
 * the link stage.
 */
async function linkOnApproval(
  deps: SyncDeps,
  linking: {
    person: PersonRef;
    link: EmployeeLink | null;
    ehEmployeeId: string;
    externalId: string;
    payload: Record<string, unknown>;
    /** EH fields with a mapping issue: baselined as unmapped, so a later fix is sent. */
    unmapped: readonly string[];
    /** Keys that disagree with the EH record, named in the Link notice (a link by a copied Payroll ID). */
    differs?: readonly MatchKey[];
    hash: string;
    eventTimestamp: number;
    now: number;
  },
): Promise<SyncJobOutcome> {
  const { person, ehEmployeeId, externalId } = linking;
  const { ctUserId } = person;
  // Before any write, so a missing key can't leave a link without a Baseline.
  const baseline = await takeBaseline(linking.payload, deps.fieldMap, deps.baselineKey, linking.unmapped);

  const other = await deps.store.findByEhEmployeeId(ehEmployeeId);
  if (other !== null && other !== ctUserId) {
    return linkBlocked(deps, linking, { kind: "linked_in_sync", otherCtUserId: other });
  }

  const byPayrollId = await deps.eh.getByExternalId(externalId);
  if (byPayrollId.outcome !== "ok") return ehRetry(byPayrollId);
  if (byPayrollId.data && String(byPayrollId.data.id) !== ehEmployeeId) {
    return linkBlocked(deps, linking, { kind: "payroll_id_elsewhere", ehEmployeeId: String(byPayrollId.data.id) });
  }

  // When the EH employee already carries this Payroll ID (a retry after the
  // write, or set by hand), they're already synced: nothing to write. A
  // marker set after our own write tells the two apart for the Link notice.
  const wroteKey = `link_put:${ctUserId}:${ehEmployeeId}`;
  if (!byPayrollId.data) {
    const target = await deps.eh.getEmployee(ehEmployeeId);
    if (target.outcome !== "ok") return ehRetry(target);
    if (!target.data) return linkBlocked(deps, linking, { kind: "not_found" });
    const theirs = String(target.data.externalId ?? "").trim();
    if (theirs && theirs !== externalId) return linkBlocked(deps, linking, { kind: "different_payroll_id" });

    if (!theirs) {
      const put = await deps.eh.setExternalId(ehEmployeeId, externalId);
      // A rejection won't change on a retry, so it goes to the admin now.
      if (put.outcome === "validation") return linkBlocked(deps, linking, { kind: "payroll_id_rejected" });
      if (put.outcome !== "ok") return ehRetry(put);
      await deps.store.setMarker(wroteKey, linking.now);
    }
  }
  const weSetIt = ((await deps.store.readMeta([wroteKey]))[wroteKey] ?? 0) > 0;

  // In a burst a plain notice rolls up into the Bulk summary (#193). One
  // naming details that differ asks the admin to check them, so it's sent.
  // Counted before the claim, so a failed count leaves nothing claimed.
  const rollUp = !linking.differs?.length && (await inBurst(deps.store, "link", linking.now));
  const key = await noticeKey("link", ctUserId, [ehEmployeeId]);
  if (await shouldPostNotice(deps.store, key, CORRECTION_NOTICE_DEDUPE_MS, linking.now)) {
    if (!rollUp) {
      const sent = await sendClaimed(deps.store, key, ctUserId, "link", () =>
        deps.ct.sendChannelMessage(deps.adminChannelId, linkNoticeMessage(person, ehEmployeeId, weSetIt, linking.differs)),
      );
      if (!sent) return sendFailed("link");
    }
    await recordRollup(deps.store, "link", ctUserId, linking.now, rollUp, [key]);
  }

  await deps.store.completeLink(
    {
      ctUserId,
      ehEmployeeId,
      lastSyncedTs: linking.eventTimestamp,
      lastPayloadHash: linking.hash,
      lastOutcome: "ok",
      externalId,
    },
    linking.now,
    baseline,
  );
  if ((linking.link?.failureCycleCount ?? 0) > 0) await deps.store.setFailureCount(ctUserId, 0);
  await deps.store.appendSyncLog({ ctUserId, at: linking.now, outcome: "ok", detail: LINKED_DETAIL });
  return { status: "synced", reason: LINKED_DETAIL, ehEmployeeId };
}

/** The unit each mapping follow-up is about. One not listed here is always posted. */
const FOLLOW_UP_UNIT: Record<string, GroupUnit> = {
  [FOLLOW_UP.nonResident]: UNIT.taxDeclaration,
  [FOLLOW_UP.smsfSuper]: UNIT.super,
  [FOLLOW_UP.internationalAddress]: UNIT.residentialAddress,
};

/**
 * A Linked employee's sync (ADR-0009, #151): send EH only the units that
 * differ from their Baseline, never the whole profile.
 */
async function syncChangedUnits(
  deps: SyncDeps,
  sync: SyncContext & {
    link: EmployeeLink;
    mapped: MappingResult;
    payRate: PayRate | null | undefined;
    matchKey: string;
  },
): Promise<SyncJobOutcome> {
  const { link, mapped } = sync;
  const { ctUserId } = link;
  const { baseline } = link;
  // Nothing sent to EH: store the hash so the next identical delivery stops
  // at the hash check. The outcome is saved as it was (the store would clear
  // one it isn't given), so an open follow-up stays open for the recheck.
  const skip = async (reason: string): Promise<SyncJobOutcome> => {
    await deps.store.saveEmployeeLink({
      ctUserId,
      ehEmployeeId: link.ehEmployeeId,
      lastSyncedTs: sync.eventTimestamp,
      lastPayloadHash: sync.hash,
      lastOutcome: link.lastOutcome ?? null,
    });
    return { status: "skipped", reason };
  };
  // No readable Baseline (a bad stored value): re-baseline from the pack as
  // it is now and send nothing, as for a lost key (ADR-0009). A full sync
  // would overwrite EH. Edits not yet pushed are absorbed into it.
  const rebaseline = async (reason: string): Promise<SyncJobOutcome> => {
    const unmapped = mapped.issues.map((i) => i.ehField);
    await deps.store.saveBaseline(ctUserId, await takeBaseline(mapped.payload, deps.fieldMap, deps.baselineKey, unmapped));
    return skip(reason);
  };
  if (!baseline) return rebaseline("Baseline unreadable: re-baselined, nothing sent");
  // A Baseline made with a different key (a rotated or lost BASELINE_KEY)
  // can't be compared, so it's re-baselined the same way. The admin hears
  // once per new key id, not once per Linked employee (#143 item 10).
  const keyId = await baselineKeyId(deps.baselineKey);
  if (baseline.keyId !== keyId) {
    const key = await noticeKey("baseline_key_changed", NO_EMPLOYEE, [keyId]);
    if (await shouldPostNotice(deps.store, key, "forever", sync.now())) {
      const sent = await sendClaimed(deps.store, key, ctUserId, "baseline_key_changed", () =>
        deps.ct.sendChannelMessage(deps.adminChannelId, baselineKeyChangedMessage()),
      );
      if (!sent) return sendFailed("baseline_key_changed");
    }
    return rebaseline(KEY_CHANGED_DETAIL);
  }
  // A Connecteam rate the sync can't map leaves no pay-run keys on the
  // payload. Marked as unmapped, its unit reads as changed (and back once the
  // rate is usable again). A field-map gap (`payRunBlocking`) isn't a change
  // to the rate, so it isn't marked: once fixed, a rate that differs is sent.
  // A Baseline with no pay-run fingerprint has nothing to differ from.
  const rateUnusable = mapped.payRunIssues.length > 0 && !mapped.payRunBlocking;
  const payRunUnmapped: PayRunKey[] = rateUnusable && baseline.units[UNIT.payRun] ? ["rate"] : [];
  const unmapped = [...mapped.issues.map((i) => i.ehField), ...payRunUnmapped];
  const current = await takeBaseline(mapped.payload, deps.fieldMap, deps.baselineKey, unmapped);
  const changed = new Set(changedUnits(baseline, current));
  // A field blanked in Connecteam (or a group now partly blank) isn't sent:
  // nothing clears an EH field safely (#135), and a group goes whole or not
  // at all. The admin is told once, naming the rest of a partly blank group,
  // and those units' Baseline moves so a later edit doesn't tell them again.
  // It's informational: it doesn't change the outcome (#143 item 9).
  const cleared = clearedFields(baseline, current);
  const clearedUnits = Object.keys(cleared);
  if (clearedUnits.length > 0) {
    const fields = Object.values(cleared).flat();
    const heldBack = clearedUnits.flatMap((unit) => current.filled?.[unit] ?? []);
    const key = await noticeKey("cleared_field", ctUserId, [sync.hash, ...fields]);
    if (await shouldPostNotice(deps.store, key, FOLLOW_UP_NOTICE_DEDUPE_MS, sync.now())) {
      const sent = await sendClaimed(deps.store, key, ctUserId, "cleared_field", () =>
        deps.ct.sendChannelMessage(deps.adminChannelId, clearedFieldsMessage(fields, heldBack, sync.person)),
      );
      if (!sent) return sendFailed("cleared_field");
    }
  }
  // A unit added to the field map since the Baseline was taken is baselined
  // without being sent: its value may be older than what EH holds (ADR-0009).
  const fresh = newUnits(baseline, current);
  const absorbed = [...clearedUnits, ...fresh];
  // The Baseline the rest of this sync moves forward from.
  let movedBaseline = baseline;
  if (absorbed.length > 0) {
    movedBaseline = moveUnits(baseline, current, absorbed);
    await deps.store.saveBaseline(ctUserId, movedBaseline);
    for (const unit of absorbed) changed.delete(unit);
  }
  if (changed.size === 0) {
    if (clearedUnits.length > 0) return skip(CLEARED_DETAIL);
    // e.g. only a constant moved
    return skip(fresh.length > 0 ? NEW_UNITS_DETAIL : "no change since the link");
  }
  // A mapping issue counts only inside a unit that changed: that unit can't
  // be sent, so it's a Correction, as in a full sync.
  const issues = mapped.issues.filter((i) => changed.has(unitOf(i.ehField)));
  let decision: SyncDecision;
  let ehEmployeeId = link.ehEmployeeId ?? undefined;
  // The units the accepted write carried: only their fingerprints move.
  let sent = new Set<string>();
  if (issues.length > 0) {
    decision = decide({ mappingIssues: issues });
  } else {
    // A changed, usable pay-run set is re-mapped against EH's current record
    // (#102): a `defaults` value EH already holds is left off, so one set by
    // hand survives. An unusable rate sends nothing about pay, whatever EH
    // holds: the Connecteam rate didn't change to anything EH can take.
    const payRunIssues = changed.has(UNIT.payRun) && rateUnusable ? mapped.payRunIssues : [];
    let sending = mapped;
    let ehRecord: EhEmployee | null | undefined;
    if (changed.has(UNIT.payRun) && !rateUnusable) {
      const found = await deps.eh.getByExternalId(sync.matchKey);
      if (found.outcome !== "ok") return ehRetry(found);
      ehRecord = found.data;
      sending = applyFieldMap(sync.user as unknown as MappingUser, deps.fieldMap, { payRate: sync.payRate, ehRecord });
    }
    // As with mapping issues, a follow-up counts only for a unit that changed.
    const followUps = sending.followUps.filter((f) => !(f in FOLLOW_UP_UNIT) || changed.has(FOLLOW_UP_UNIT[f]!));
    const payload = Object.fromEntries(Object.entries(sending.payload).filter(([key]) => changed.has(unitOf(key))));

    if (Object.keys(payload).length === 0) {
      // Only the unusable rate changed: nothing to write, the reasons go to the admin.
      decision = decide({ payRunUnresolved: payRunIssues, followUps });
    } else {
      const step = await writeAndDecide(deps, {
        matchKey: sync.matchKey,
        payload,
        ehRecord,
        followUps: [...payRunIssues, ...followUps],
        payRunDefaultsComplete: sending.payRunDefaultsComplete,
      });
      if ("outcome" in step) return step.outcome;
      decision = step.decision;
      if (step.ehEmployeeId !== null) {
        ehEmployeeId = step.ehEmployeeId;
        // A unit counts as sent only if the write carried a key of it.
        sent = new Set(Object.keys(payload).map(unitOf));
      }
    }
  }

  const outcome = await settle(deps, {
    link,
    user: sync.user,
    person: sync.person,
    hash: sync.hash,
    decision,
    ehEmployeeId,
    keyToStore: null,
    eventTimestamp: sync.eventTimestamp,
    now: sync.now,
  });
  // EH accepted what was sent: those units' fingerprints move, once its
  // messages are out (a retry after a failed send must still see the change).
  // On a Correction they stay, so the next edit sends them again.
  if (outcome.status !== "retry" && decision.kind !== "correction" && sent.size > 0) {
    await deps.store.saveBaseline(ctUserId, moveUnits(movedBaseline, current, [...sent]));
  }
  return outcome;
}

/** The `skipped` reason when a Linked employee's edit only cleared fields (and maybe added new ones) (#152). */
export const CLEARED_DETAIL = "cleared in Connecteam: follow-up posted, nothing sent";

/** The `skipped` reason when a Linked employee's Baseline was made with another key (#152). */
export const KEY_CHANGED_DETAIL = "Baseline key changed: re-baselined, nothing sent";

/** The `skipped` reason when a Linked employee's only change was units new to the field map (#152). */
export const NEW_UNITS_DETAIL = "new in the field map: baselined, nothing sent";

/** `before` with `units` taken from `now`, fingerprint and filled fields both. A unit now blank keeps an empty `filled` entry. */
function moveUnits(before: Baseline, now: Baseline, units: readonly string[]): Baseline {
  const fingerprints = { ...before.units };
  const filled = { ...before.filled };
  for (const unit of units) {
    if (now.units[unit] !== undefined) fingerprints[unit] = now.units[unit];
    else delete fingerprints[unit];
    filled[unit] = now.filled?.[unit] ?? [];
  }
  return { keyId: before.keyId, units: fingerprints, filled };
}

/** The `sync_log` detail of a link (#143 item 2). */
export const LINKED_DETAIL = "linked: Payroll ID only";

/**
 * A confirmed link that can't be made: nothing written to EH, one claimed
 * System alert, and a `collision` audit row (EH and Connecteam ids only).
 * Like a collision, no `employee_map` row is saved.
 */
async function linkBlocked(
  deps: SyncDeps,
  blocked: { person: PersonRef; ehEmployeeId: string; now: number },
  block: LinkBlock,
): Promise<SyncJobOutcome> {
  const { ctUserId } = blocked.person;
  const detail = linkBlockedDetail(blocked.ehEmployeeId, block);
  // Keyed by what it says, so a later edit doesn't repost it within the window.
  const key = await noticeKey("link_blocked", ctUserId, [detail]);
  if (await shouldPostNotice(deps.store, key, FOLLOW_UP_NOTICE_DEDUPE_MS, blocked.now)) {
    const sent = await sendClaimed(deps.store, key, ctUserId, "link_blocked", () =>
      deps.ct.sendChannelMessage(deps.adminChannelId, linkBlockedMessage(blocked.person, blocked.ehEmployeeId, block)),
    );
    if (!sent) return sendFailed("link_blocked");
  }
  await deps.store.appendSyncLog({ ctUserId, at: blocked.now, outcome: "collision", detail });
  return { status: "collision", reason: detail };
}

/** e.g. `can't link: EH employee 40213 has a different Payroll ID`. Ids only. */
export function linkBlockedDetail(ehEmployeeId: string, b: LinkBlock): string {
  return `can't link: EH employee ${ehEmployeeId} ${linkBlockedWhy(b)}`;
}

function linkBlockedWhy(b: LinkBlock): string {
  switch (b.kind) {
    case "different_payroll_id":
      return "has a different Payroll ID";
    case "payroll_id_elsewhere":
      return `isn't theirs: the Payroll ID is on EH employee ${b.ehEmployeeId}`;
    case "linked_in_sync":
      return `is already linked to Connecteam user ${b.otherCtUserId}`;
    case "not_found":
      return "no longer exists";
    case "payroll_id_rejected":
      return "rejected the Payroll ID";
  }
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
  const detail = `every retry failed, so the cause outlasted a short blip (trigger "${job.reason}")`;

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
 * Record an Existing-match, Link or Admin success notice in `notice_rollup` (#193, #199). A rolled-up notice's
 * record stands in for its send, so a failed write releases its claims and the
 * job's retry rolls it up. A sent notice keeps its claim, so the retry doesn't
 * post it again; it just goes uncounted toward a burst.
 */
async function recordRollup(
  store: Pick<SyncDeps["store"], "recordNotice" | "setMarker">,
  kind: RollupKind,
  ctUserId: number,
  now: number,
  rollUp: boolean,
  claims: readonly string[],
): Promise<void> {
  try {
    await store.recordNotice(kind, ctUserId, now, rollUp);
  } catch (err) {
    if (rollUp) for (const key of claims) await releaseNotice(store, key);
    throw err;
  }
}

/** Outcomes that mean the person has synced successfully before. */
const SYNCED_BEFORE: readonly SyncOutcomeLabel[] = ["ok", "follow_up", "resolved"];

type SuccessKind = { kind: "first" } | { kind: "fixed"; topics: string[] };

/**
 * Which success (#71) a job that just synced successfully is, judged from the
 * person's state BEFORE this job, or null for an ordinary edit:
 * - an open Correction cycle -> "fixed", with the topics it asked about
 * - never synced before -> "first"
 */
async function successKind(
  link: EmployeeLink | null,
  store: Pick<SyncGateway, "latestCorrectionDetail">,
): Promise<SuccessKind | null> {
  if (link && link.failureCycleCount > 0) {
    const fields = correctionFieldsFromAudit(await store.latestCorrectionDetail(link.ctUserId));
    return { kind: "fixed", topics: correctionTopics(fields.map((field) => ({ field, reason: "" }))) };
  }
  return hasSyncedBefore(link) ? null : { kind: "first" };
}

/**
 * Whether EH has accepted a sync for this person. A stored Payroll ID counts
 * whatever came after, since it's stored only once EH accepts a write or link:
 * a later Correction cycle mustn't send them back through first-approval linking
 * (#186). A row saved before `lastOutcome` existed counts if it has an EH id.
 * The preflight (scripts/lib/preflight.ts) uses the same rule.
 */
export function hasSyncedBefore(
  link: Pick<EmployeeLink, "lastOutcome" | "ehEmployeeId" | "externalId"> | null,
): boolean {
  if (link === null) return false;
  if (link.externalId != null) return true;
  return link.lastOutcome != null ? SYNCED_BEFORE.includes(link.lastOutcome) : link.ehEmployeeId !== null;
}

function employeeSuccessText(s: SuccessKind, note: string): string {
  return s.kind === "first" ? firstSyncMessage(note) : correctionFixedMessage(s.topics, note);
}

function adminSuccessText(s: SuccessKind, person: PersonRef): string {
  return s.kind === "first" ? adminFirstSyncMessage(person) : adminCorrectionFixedMessage(person, s.topics);
}

/** The retry for a failed Employment Hero call. */
function ehRetry(res: Exclude<EhResult<unknown>, { outcome: "ok" }>): SyncJobOutcome {
  return res.outcome === "retryable"
    ? { status: "retry", reason: `employment hero unavailable: ${res.detail}` }
    : { status: "retry", reason: `employment hero error ${res.status}` };
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
