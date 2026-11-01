/**
 * Turns the outcome of one sync attempt into a single decision: synced cleanly,
 * the employee must fix a value, a payroll admin must finish something by hand,
 * or the attempt should be retried. Pure - no network, no logging, no D1.
 *
 * What triggers a correction (issue #5, decisions locked during design):
 *   - `applyFieldMap` produced field issues, so the payload was never sent, OR
 *   - EH rejected the write with an HTTP 400 validation body, OR
 *   - the write succeeded (2xx) but the record is still `Incomplete` - this is
 *     where a bad TFN surfaces: EH accepts it (200) and marks the record
 *     Incomplete, it is never a 400, so the hint comes from `detailedStatus`, OR
 *   - a post-write read-back of non-sensitive fields disagrees with what we sent.
 *
 * `retry` covers only faults the employee cannot fix (EH outage, auth failure,
 * unexpected 4xx). The queue retries those and, once exhausted, they become a
 * System alert to the admin channel.
 */
import type { EhResult } from "../eh/client.js";
import type { EhFieldError } from "../eh/errors.js";
import type { EhWriteResult } from "../eh/types.js";
import type { MappingIssue, PayloadValue } from "../mapping/apply.js";

export type SyncDecision =
  | { kind: "ok" }
  | { kind: "correction"; fields: EhFieldError[] }
  | { kind: "follow_up"; reasons: string[] }
  | { kind: "retry"; detail: string };

/** Result of comparing what we sent against a post-write read-back. */
export interface ReadBackResult {
  matched: boolean;
  mismatches: EhFieldError[];
}

export interface DecideInput {
  /** Field problems from `applyFieldMap`. Non-empty => the payload was NOT sent. */
  mappingIssues?: MappingIssue[];
  /** The EH upsert result. Absent when `mappingIssues` stopped the send. */
  write?: EhResult<EhWriteResult>;
  /** Plain-language admin follow-ups from `applyFieldMap`. */
  followUps?: string[];
  /** Optional post-write read-back comparison (non-sensitive fields only). */
  readBack?: ReadBackResult;
  /**
   * The client shipped the complete company-wide pay-run set via
   * `employmentHero.defaults` (issue #26). When that is true and EH *still*
   * reports the pay-run axis incomplete, the fix is a one-time field-map
   * correction (the default names don't match the business), not per-employee
   * admin setup - so the follow-up says that instead.
   */
  payRunDefaultsComplete?: boolean;
  /**
   * The all-or-nothing pay-run set could not be completed before the write
   * (issue #42: no Connecteam pay rate, unsupported `rateType`, missing
   * `defaults` name). The payload carries no pay-run keys, so nothing is sent -
   * these reasons go straight to the admin channel as one follow-up.
   */
  payRunUnresolved?: string[];
}

const INCOMPLETE = "incomplete";

/**
 * EH reports `status: Incomplete` for two very different reasons:
 *  - data the *employee* entered is missing/invalid (TFN, bank, address, ...)
 *    -> a Correction message they can act on, OR
 *  - setup only a *payroll admin* can do in EH: pay-run defaults, award / pay
 *    rate / classification, employing entity. The sync never touches these
 *    (out of scope - see docs/PLAN.md), so telling the employee to "fix" them
 *    is wrong; it must go to the alerts channel as a Manual-follow-up notice.
 *
 * `detailedStatus` is a short EH phrase. We reroute the phrases we know are
 * admin-only (confirmed real: "Pay Run Defaults are incomplete") and leave
 * everything else as a Correction - matching the previous behaviour for any
 * phrase we have not seen.
 */
const ADMIN_ONLY_INCOMPLETE =
  /pay run default|pay-run default|pay category|pay rate|\baward\b|classification|employing entity|employee default|leave allowance|opening balance|work type/i;

/**
 * The subset of admin-only phrases that a complete pay-run set is meant to
 * satisfy: pay schedule / location / pay category / rate, and - since issue #39,
 * when the client is on the award path (`employmentHero.payRateTemplate`, which
 * makes `payRunDefaultsComplete` true) - award / classification too. This regex
 * is only consulted when `payRunDefaultsComplete` is true, so a client that has
 * NOT configured the award path still gets the plain admin follow-up for these.
 * `employing entity` stays absent - nothing in the field-map covers it.
 */
const PAY_RUN_SET_INCOMPLETE =
  /pay run default|pay-run default|pay category|pay rate|pay schedule|primary location|employee default|\baward\b|classification/i;

function incompleteIsAdminOnly(detailedStatus: string | null): boolean {
  return ADMIN_ONLY_INCOMPLETE.test(detailedStatus ?? "");
}

function incompleteIsPayRunSet(detailedStatus: string | null): boolean {
  return PAY_RUN_SET_INCOMPLETE.test(detailedStatus ?? "");
}

function adminIncompleteReason(detailedStatus: string | null): string {
  const s = (detailedStatus ?? "").trim();
  return `Employment Hero marked the record incomplete${
    s ? ` ("${s}")` : ""
  } - a payroll admin needs to finish the employee's setup in Employment Hero (e.g. pay-run defaults / award / pay rate).`;
}

/**
 * The client configured a complete company-wide pay-run set, yet EH still flags
 * the pay-run axis incomplete: the default *values* did not validate against the
 * business (a wrong pay-category / location / pay-schedule name is accepted on
 * the create with a 200 but silently not applied). One field-map fix clears it
 * for every employee - it is not per-person admin work.
 */
function payDefaultsRejectedReason(detailedStatus: string | null): string {
  const s = (detailedStatus ?? "").trim();
  return `Employment Hero still reports the pay-run defaults incomplete${
    s ? ` ("${s}")` : ""
  } even though company-wide employmentHero.defaults are set - the default names likely do not match this business (check paySchedule / primaryLocation / primaryPayCategory / rateUnit). Fix the field-map once; it applies to every employee.`;
}

export function decide(input: DecideInput): SyncDecision {
  const mappingIssues = input.mappingIssues ?? [];
  if (mappingIssues.length > 0) {
    return { kind: "correction", fields: mappingIssues.map(issueToFieldError) };
  }

  // Pay-run set could not be completed pre-send (issue #42). Nothing was written;
  // route the reasons to the admin channel rather than the employee - a pay rate
  // is admin/config work, not something the employee can fix in their profile.
  const payRunUnresolved = input.payRunUnresolved ?? [];
  if (payRunUnresolved.length > 0) {
    return { kind: "follow_up", reasons: [...payRunUnresolved, ...(input.followUps ?? [])] };
  }

  const { write } = input;
  if (!write) return { kind: "retry", detail: "no write result to decide on" };

  switch (write.outcome) {
    case "validation":
      return { kind: "correction", fields: write.issues };
    case "retryable":
      return { kind: "retry", detail: write.detail };
    case "client_error":
      // 401 / 403 / 404 / an unhandled 4xx: not something the employee can fix.
      // Let the queue retry and, on exhaustion, dead-letter it to a System alert.
      return { kind: "retry", detail: `EH ${write.status}: ${write.detail}` };
    case "ok": {
      const { status, detailedStatus } = write.data;
      if ((status ?? "").toLowerCase().includes(INCOMPLETE)) {
        if (incompleteIsAdminOnly(detailedStatus)) {
          const payRunReason =
            input.payRunDefaultsComplete && incompleteIsPayRunSet(detailedStatus)
              ? payDefaultsRejectedReason(detailedStatus)
              : adminIncompleteReason(detailedStatus);
          // Surface any other admin follow-ups (non-resident, SMSF, INTERNATIONAL
          // address) in the same notice rather than losing them.
          return {
            kind: "follow_up",
            reasons: [payRunReason, ...(input.followUps ?? [])],
          };
        }
        return { kind: "correction", fields: [incompleteFieldError(detailedStatus)] };
      }
      if (input.readBack && !input.readBack.matched) {
        return { kind: "correction", fields: input.readBack.mismatches };
      }
      const followUps = input.followUps ?? [];
      if (followUps.length > 0) return { kind: "follow_up", reasons: followUps };
      return { kind: "ok" };
    }
  }
}

/**
 * Compare a sent payload against a read-back record, non-sensitive fields only.
 * TFN, bank and super member values are never compared (never re-fetched).
 * Pass `fields` to restrict the comparison to a known-safe subset.
 */
const SENSITIVE = /taxfilenumber|tfn|bankaccount|membernumber/i;

export function compareReadBack(
  sent: Record<string, PayloadValue>,
  fetched: Record<string, unknown>,
  fields?: string[],
): ReadBackResult {
  const keys = (fields ?? Object.keys(sent)).filter((k) => !SENSITIVE.test(k));
  const mismatches: EhFieldError[] = [];
  for (const key of keys) {
    if (!(key in sent)) continue;
    if (norm(sent[key]) !== norm(fetched[key])) {
      mismatches.push({ field: key, reason: "value did not match after the write" });
    }
  }
  return { matched: mismatches.length === 0, mismatches };
}

/** A redaction-safe one-line audit string: field NAMES and status hints only. */
export function auditDetail(decision: SyncDecision): string {
  switch (decision.kind) {
    case "ok":
      return "synced";
    case "retry":
      return `retry: ${decision.detail}`;
    case "follow_up":
      return `follow_up: ${decision.reasons.join(" | ")}`;
    case "correction": {
      // EH sometimes names the field only in prose ("Tax File Number is
      // invalid") with no "Field:" prefix, so `field` comes through as
      // "(unknown)". Fall back to a short redaction-safe slug of the reason so
      // the audit row still says what failed.
      const names = [
        ...new Set(
          decision.fields.map((f) =>
            f.field && f.field !== "(unknown)" ? f.field : reasonSlug(f.reason),
          ),
        ),
      ];
      return `correction: ${names.join(", ")}`;
    }
  }
}

/**
 * The field names a `correction` row's detail (written by {@link auditDetail})
 * lists, or `[]` for any other detail (#71). The success message reads them
 * back to say what was fixed.
 */
export function correctionFieldsFromAudit(detail: string | null): string[] {
  const prefix = "correction: ";
  if (!detail?.startsWith(prefix)) return [];
  return detail
    .slice(prefix.length)
    .split(", ")
    .map((f) => f.trim())
    .filter(Boolean);
}

function issueToFieldError(i: MappingIssue): EhFieldError {
  return { field: i.ehField, reason: i.reason, ...(i.answer ? { answer: i.answer } : {}) };
}

/** A short, punctuation-free tag from an EH reason for the audit row. */
function reasonSlug(reason: string): string {
  const slug = reason.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 40 ? slug.slice(0, 40).replace(/-+$/g, "") : slug || "(unknown)";
}

function incompleteFieldError(detailedStatus: string | null): EhFieldError {
  const reason =
    detailedStatus && detailedStatus.trim() !== ""
      ? detailedStatus.trim()
      : "Employment Hero marked the record incomplete.";
  return { field: "(incomplete)", reason };
}

function norm(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim().toLowerCase();
}
