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
  type LinkBlock,
  type PersonRef,
} from "./messages.js";
import { runPreCreateCheck, existingMatchDetail, compareKeys, isTerminated, type ExistingMatch, type MatchKey } from "./precheck.js";
import { advanceCycle, directManagerUserId, MANAGER_ESCALATION_CYCLE } from "./cycles.js";
import { payloadHash } from "./canonical.js";
import { takeBaseline } from "./baseline.js";
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
import type { EmployeeLink, LinkGateway, SyncGateway, SyncOutcomeLabel } from "./gateway.js";

export interface SyncDeps {
  ct: Pick<
    ConnecteamClient,
    "getUser" | "getPayRate" | "sendDirectMessage" | "sendChannelMessage"
  >;
  eh: Pick<EhPayrollClient, "upsertByExternalId" | "getByExternalId" | "findEmployees" | "getEmployee" | "setExternalId">;
  /**
   * `getPendingLink`: a confirmed link is made on the first approval, and a
   * "New hire, not this person" row skips the Pre-create check.
   */
  store: SyncGateway & Pick<LinkGateway, "getPendingLink" | "completeLink">;
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
  // overwrite what EH holds for them. Until the changed-units sync (#151)
  // exists, their edits write nothing.
  if (link?.linkedAt) return { status: "skipped", reason: "linked employee: changed-units sync not built yet" };

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
  if (mapped.externalIdFromField && !hasSyncedBefore(link)) {
    const found = await deps.eh.getByExternalId(matchKey);
    if (found.outcome !== "ok") return ehRetry(found);
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
    const found = await deps.eh.getByExternalId(matchKey);
    if (found.outcome !== "ok") return ehRetry(found);
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
          notes: payrollIdNotes(user as unknown as MappingUser, deps.fieldMap, mapped.externalIdFromField, check.data),
          eventTimestamp,
          now: now(),
        });
      }
    }

    // Match order: stored link -> externalId (both handled by upsertByExternalId).
    // A create goes out with EH's own merge off (`matchType=None`).
    const write = await deps.eh.upsertByExternalId(matchKey, mapped.payload, current);
    // A validation failure isn't retried: it's the employee's to fix (decide below).
    if (write.outcome === "retryable" || write.outcome === "client_error") return ehRetry(write);

    let readBack: ReadBackResult | undefined;
    if (write.outcome === "ok") {
      ehEmployeeId = String(write.data.id);
      keyToStore = matchKey;

      // Backstop (ADR-0010): creates now go out with `matchType=None` after the
      // Pre-create check, but EH's unstructured endpoint used to match/merge by
      // TFN - a write for a brand-new externalId could land on and silently
      // overwrite an EXISTING employee (even relabelling its externalId). The
      // read-back below can't catch this: EH relabels the merged record's
      // externalId too, so a read-back-by-externalId finds exactly what we just
      // sent. Check employee_map instead.
      const collidingCtUserId = await deps.store.findByEhEmployeeId(ehEmployeeId);
      if (collidingCtUserId !== null && collidingCtUserId !== ctUserId) {
        const key = await noticeKey("collision", ctUserId, [ehEmployeeId]);
        if (await shouldPostNotice(deps.store, key, SYSTEM_ALERT_NOTICE_DEDUPE_MS, now())) {
          const text = collisionAlertMessage(
            ehEmployeeId,
            person,
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

      const rb = await deps.eh.getByExternalId(matchKey);
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
 * Connecteam field (ADR-0011): a copied ID that found nobody may be a typo;
 * a blank one, where a match already has a Payroll ID, should be filled in.
 */
function payrollIdNotes(user: MappingUser, map: FieldMap, fromField: boolean, matches: readonly ExistingMatch[]): string[] {
  const from = map.identity.externalIdFrom;
  if (from === "userId") return [];
  if (fromField) return [PAYROLL_ID_TYPO_HINT];
  if (!matches.some((m) => m.hasPayrollId)) return [];
  const name = user.customFields.find((f) => f.customFieldId === from.customFieldId)?.name;
  return [copyPayrollIdHint(name?.trim() || "their Payroll ID field")];
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
  // Keyed by what the notice says (candidates and keys), not the payload hash:
  // a later profile edit that changes nothing about the match doesn't repost
  // it within the window. The digest is the only reminder (#143 item 5).
  for (const [i, text] of existingMatchMessages(person, matches, held.notes).entries()) {
    const key = await noticeKey("existing_match", ctUserId, i === 0 ? [detail] : [detail, `part ${i + 1}`]);
    if (!(await shouldPostNotice(deps.store, key, FOLLOW_UP_NOTICE_DEDUPE_MS, held.now))) continue;
    const sent = await sendClaimed(deps.store, key, ctUserId, "existing_match", () =>
      deps.ct.sendChannelMessage(deps.adminChannelId, text),
    );
    if (!sent) return sendFailed("existing_match");
  }
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

  const key = await noticeKey("link", ctUserId, [ehEmployeeId]);
  if (await shouldPostNotice(deps.store, key, CORRECTION_NOTICE_DEDUPE_MS, linking.now)) {
    const sent = await sendClaimed(deps.store, key, ctUserId, "link", () =>
      deps.ct.sendChannelMessage(deps.adminChannelId, linkNoticeMessage(person, ehEmployeeId, weSetIt, linking.differs)),
    );
    if (!sent) return sendFailed("link");
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

/** Whether EH has accepted a sync for this person. A row saved before `lastOutcome` existed counts if it has an EH id. */
function hasSyncedBefore(link: EmployeeLink | null): boolean {
  return (
    link !== null &&
    (link.lastOutcome != null ? SYNCED_BEFORE.includes(link.lastOutcome) : link.ehEmployeeId !== null)
  );
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
