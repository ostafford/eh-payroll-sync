/**
 * The narrow D1 surface the sync consumer needs. Kept as an interface (not a
 * `D1Database`) so the consumer stays node-testable with a fake; the concrete
 * drizzle-backed implementation is {@link ../db/store.SyncStore}, compiled only
 * into the Worker.
 */
import type { CycleStore } from "./cycles.js";
import type { RosterRow } from "../status/roster.js";

/** Matches the `sync_log.outcome` enum in {@link ../db/schema}. */
export type SyncOutcomeLabel =
  | "ok"
  | "correction"
  | "follow_up"
  | "retry"
  | "dead_letter"
  | "resolved"
  | "collision"
  /** Left out of the sync by choice (`rules.exclude`): no EH write, no message. */
  | "excluded"
  /** A Held employee: the Pre-create check found them already in EH, so nothing was written (ADR-0010). */
  | "existing_match";

/** One row of `employee_map`, as the consumer reads it. */
export interface EmployeeLink {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastSyncedTs: number | null;
  failureCycleCount: number;
  lastPayloadHash: string | null;
  /** The outcome of the most recent attempt, or undefined if not tracked by this store. */
  lastOutcome?: SyncOutcomeLabel | null;
  /** When this person became a Linked employee (epoch ms); null or undefined for everyone else. */
  linkedAt?: number | null;
  /** A Linked employee's Baseline (ADR-0009); null until it is taken, or if what's stored can't be read. */
  baseline?: Baseline | null;
}

/**
 * A Linked employee's Baseline (ADR-0009): one keyed fingerprint per unit, and
 * the id of the `BASELINE_KEY` that made them. Never a value.
 */
export interface Baseline {
  keyId: string;
  /** Unit name -> HMAC-SHA-256 fingerprint of that unit's mapped value. */
  units: Record<string, string>;
}

/** One `pending_link` row: a link the admin confirmed, waiting for the person's first approval. */
export interface PendingLink {
  ctUserId: number;
  /** The EH employee to link to, or null for "New hire, not this person" (ADR-0010). */
  ehEmployeeId: string | null;
  confirmedAt: number;
}

/** Values written back to `employee_map` after an attempt. */
export interface EmployeeLinkPatch {
  ctUserId: number;
  ehEmployeeId: string | null;
  lastSyncedTs: number | null;
  /**
   * The mapped-payload hash of this attempt, clean or not, so a byte-identical
   * re-delivery is skipped. A real later edit changes the payload and its hash.
   */
  lastPayloadHash: string | null;
  /** The outcome of this attempt (issue #43); optional so existing callers still compile. */
  lastOutcome?: SyncOutcomeLabel | null;
}

export interface SyncLogEntry {
  ctUserId: number;
  at: number;
  outcome: SyncOutcomeLabel;
  /** Redaction-safe: field NAMES + status hints only, never a value. */
  detail: string;
}

export interface SyncGateway extends CycleStore {
  getEmployeeLink(ctUserId: number): Promise<EmployeeLink | null>;
  saveEmployeeLink(patch: EmployeeLinkPatch): Promise<void>;
  appendSyncLog(entry: SyncLogEntry): Promise<void>;
  /**
   * True once this person's onboarding-pack assignment has reached
   * `status: completed` at least once (per `onboarding_state`, the approval
   * sweep's own record - see ADR-0002). Gates the `user_updated` webhook path:
   * a `profile_update` job for someone never yet approved is a mid-onboarding
   * field edit, not a real sync-worthy change, and must not write to EH or
   * message anyone. `approval` jobs (enqueued by the sweep the instant it
   * observes the completed transition) are never gated by this - they ARE the
   * approval signal.
   */
  hasBeenApproved(ctUserId: number): Promise<boolean>;
  /**
   * The Connecteam userId already linked to this EH employee id, if any -
   * detects a TFN (or other identity-field) collision. Employment Hero's
   * unstructured-employee endpoint matches/merges by TFN internally: a POST
   * for a brand-new `externalId` can still land on and silently overwrite an
   * EXISTING employee (even relabelling its `externalId`) if the TFN matches.
   * Our own read-back check can't catch this - EH also updates the
   * `externalId` on the merged record, so a read-back-by-externalId finds
   * exactly what we just sent. Checked after every successful write; a result
   * other than `null`/the current ctUserId means two Connecteam people just
   * got merged into one EH record.
   */
  findByEhEmployeeId(ehEmployeeId: string): Promise<number | null>;
  /**
   * The `detail` of this person's newest `correction` audit row, or null. The
   * "that's fixed" success message (#71) reads what the Correction named.
   */
  latestCorrectionDetail(ctUserId: number): Promise<string | null>;
  /** Add `delta` to an operational counter for /health (queue backlog etc.). */
  bumpCounter(key: string, delta: number): Promise<void>;
  /** Read named `sync_meta` counters/markers; missing keys come back as 0. */
  readMeta(keys: string[]): Promise<Record<string, number>>;
  /** Set a `sync_meta` marker to an absolute value (e.g. a "notice last sent" ms). */
  setMarker(key: string, value: number): Promise<void>;
}

/**
 * The narrow surface the daily recheck pass (issue #43) needs. A separate
 * interface (not folded into {@link SyncGateway}) so adding it doesn't force
 * every existing fake gateway in the sync-consumer tests to grow a new method.
 */
export interface RecheckGateway
  extends Pick<SyncGateway, "appendSyncLog" | "saveEmployeeLink" | "readMeta" | "setMarker"> {
  /** Every `employee_map` row whose last attempt ended in a Manual-follow-up. */
  listFollowUpLinks(): Promise<EmployeeLink[]>;
}

/**
 * The storage linking needs: `pending_link` rows and the linked state on
 * `employee_map`. A separate interface for the same reason as
 * {@link RecheckGateway}.
 */
export interface LinkGateway {
  getPendingLink(ctUserId: number): Promise<PendingLink | null>;
  listPendingLinks(): Promise<PendingLink[]>;
  /** Add a pending link, or replace this person's existing one. */
  savePendingLink(link: PendingLink): Promise<void>;
  deletePendingLink(ctUserId: number): Promise<void>;
  /**
   * Record a link made on a first approval, in one D1 batch: the
   * `employee_map` row (saved as {@link SyncGateway.saveEmployeeLink} would),
   * marked linked with its first Baseline, and the `pending_link` row
   * deleted. One batch, so no re-run finds the person synced but not linked.
   */
  completeLink(patch: EmployeeLinkPatch, linkedAt: number, baseline: Baseline): Promise<void>;
  /** Mark an existing `employee_map` row as a Linked employee, with their first Baseline. */
  markLinked(ctUserId: number, linkedAt: number, baseline: Baseline): Promise<void>;
  /** Replace a Linked employee's Baseline (it rolls forward unit by unit, ADR-0009). */
  saveBaseline(ctUserId: number, baseline: Baseline): Promise<void>;
}

/**
 * The narrow surface the sync-status roster (issue #44) needs: every person we
 * have ever seen, joined with their latest `sync_log` row, plus the markers the
 * weekly digest schedules itself off. A separate interface for the same reason
 * as {@link RecheckGateway} - existing fake gateways in other tests don't need
 * to grow this method.
 */
export interface StatusGateway extends Pick<SyncGateway, "readMeta" | "setMarker"> {
  listRosterRows(): Promise<RosterRow[]>;
}
