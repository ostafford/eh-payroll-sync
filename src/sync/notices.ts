/**
 * De-dup for notices that could otherwise repeat: the two admin-channel kinds
 * that repeat while a record sits `Incomplete` (issue #27) - a Manual-follow-up
 * notice and a System alert - plus the employee-facing Correction message,
 * which can repeat on a queue retry of the exact same job (no relation to #27).
 *
 * Connecteam fires one `user_updated` per changed field, so every real profile
 * edit re-runs the sync. The mapped-payload hash in `consumer.ts` only skips
 * byte-identical re-deliveries - a genuine edit changes the payload but can
 * leave the exact same follow-up reason in place ("Pay Run Defaults are
 * incomplete"), so the notice fires again. Observed: one user edited 3x in
 * ~90s while still Incomplete -> 3 identical notices in the channel.
 *
 * Fix: remember, in `sync_meta`, when each distinct notice last went out - keyed
 * by user AND a hash of its reason-set, so a notice whose reasons actually
 * changed (e.g. non-resident newly added) still posts. Same marker mechanism
 * the integrator system-alert de-dup already uses (src/index.ts); this one
 * guards the client's own alerts channel. One `sync_meta` row accumulates per
 * user per distinct reason-set - a few hundred at most for a single client, so
 * left unpruned; a `DELETE FROM sync_meta WHERE key LIKE 'notice:%' AND
 * num < <cutoff>` in the cron would clear them if it ever matters.
 *
 * The `correction` kind uses the same marker mechanism but a different key
 * ingredient on purpose: `consumer.ts` passes the mapped-payload hash, not the
 * decision's reasons. A genuine edit (even to an unrelated field) changes that
 * hash, so this guard never suppresses a fresh Correction cycle attempt - it
 * only catches a queue redelivery of the *exact same* job (a crash after the
 * DM went out but before the ack), which would otherwise re-DM the employee
 * and double-bump their failure-cycle count via `advanceCycle`.
 */
import { sha256Hex } from "./canonical.js";
import type { SyncGateway } from "./gateway.js";

export type NoticeKind =
  | "correction"
  | "manager_escalation"
  | "employee_success"
  | "admin_success"
  | "follow_up"
  | "system_alert"
  | "collision"
  | "existing_match"
  | "link"
  | "link_blocked"
  | "payroll_id_changed";

/** A follow-up can wait on a payroll admin for a while - at most twice a day. */
export const FOLLOW_UP_NOTICE_DEDUPE_MS = 12 * 60 * 60 * 1000;
/** Repeated dead-letters for one user in an hour are one incident. */
export const SYSTEM_ALERT_NOTICE_DEDUPE_MS = 60 * 60 * 1000;
/**
 * Only needs to outlast realistic queue-retry timing (`max_retries: 5`), not
 * throttle genuine re-attempts - see the `correction` note above.
 */
export const CORRECTION_NOTICE_DEDUPE_MS = 60 * 60 * 1000;

type MetaStore = Pick<SyncGateway, "readMeta" | "setMarker">;

/**
 * `sync_meta` key for one user's notice of a given kind and reason-set. The
 * reason-set is normalised (trimmed, lower-cased, de-duplicated, sorted) before
 * hashing so wording-order changes don't defeat the match and a genuinely new
 * reason does.
 */
export async function noticeKey(
  kind: NoticeKind,
  ctUserId: number,
  reasons: readonly string[],
): Promise<string> {
  const normalised = [
    ...new Set(reasons.map((r) => r.trim().toLowerCase().replace(/\s+/g, " "))),
  ]
    .filter(Boolean)
    .sort();
  const hash = (await sha256Hex(normalised.join("\n"))).slice(0, 16);
  return `notice:${kind}:${ctUserId}:${hash}`;
}

/**
 * True if this exact notice has NOT gone out within `windowMs`, or ever with
 * `"forever"` (a changed Payroll ID: one alert per new value, ADR-0011). On true it also
 * stamps the send time - a claim taken BEFORE the send, so a re-run of the job
 * skips it (ADR-0007). A caller must check the send's result and
 * {@link releaseNotice} on failure, or a failed send is lost (issue #89).
 */
export async function shouldPostNotice(
  store: MetaStore,
  key: string,
  windowMs: number | "forever",
  now: number,
): Promise<boolean> {
  const last = (await store.readMeta([key]))[key] ?? 0;
  if (last > 0 && (windowMs === "forever" || now - last < windowMs)) return false;
  await store.setMarker(key, now);
  return true;
}

/**
 * Undo a {@link shouldPostNotice} claim whose send failed, so the job's retry
 * sends it. A 0 marker reads as "never sent".
 */
export async function releaseNotice(store: Pick<MetaStore, "setMarker">, key: string): Promise<void> {
  await store.setMarker(key, 0);
}
