/**
 * Wires the pure roster/digest logic to Connecteam and D1 for `GET /status`,
 * `POST /status/digest`, and the weekly cron digest (issue #44).
 *
 * Honest limit (also documented in RUNBOOK.md): `ready` means EH accepted every
 * value we sent and reports the record payroll-ready - NOT that the values are
 * truthful. EH validates format only; it never rejects a bad TFN at the API, it
 * just stores it and marks the record Incomplete (see CONTEXT.md "Validation
 * failure"). Human correctness of the data stays a spot-check, not a per-record
 * guarantee this roster can make.
 */
import type { ConnecteamClient } from "../connecteam/client.js";
import type { StatusGateway } from "../sync/gateway.js";
import {
  deriveRosterEntry,
  leftOutLabel,
  summarizeRoster,
  type RosterCounts,
  type RosterEntry,
} from "./roster.js";
import { digestMessages, type DigestEmployee } from "./digest.js";
import type { FieldMap } from "../mapping/schema.js";
import { logEvent } from "../log.js";

export interface StatusDeps {
  store: StatusGateway;
  ct: Pick<ConnecteamClient, "getUser" | "sendChannelMessage">;
  adminChannelId: string;
  /** The field map's `rules.exclude`, to label people left out by choice ("Employee Status: PBV"). */
  exclude?: NonNullable<NonNullable<FieldMap["rules"]>["exclude"]>;
}

export interface StatusEmployee extends RosterEntry {
  /** Best-effort display name, fetched from Connecteam. Omitted for `ready` rows to avoid an unnecessary lookup. */
  name?: string;
}

export interface StatusRoster {
  generatedAt: string;
  counts: RosterCounts;
  employees: StatusEmployee[];
}

/**
 * One entry per person the sync has ever touched. Names are fetched from
 * Connecteam best-effort, and only for anyone not `ready` - a `ready` roster of
 * any real size would otherwise mean one Connecteam call per employee on every
 * request for a name nobody asked to see (the state + reasons + ids are enough
 * for a fully-synced person).
 */
export async function buildStatusRoster(deps: Pick<StatusDeps, "store" | "ct" | "exclude">): Promise<StatusRoster> {
  const rows = await deps.store.listRosterRows();
  const entries = rows.map(deriveRosterEntry);

  const employees: StatusEmployee[] = [];
  for (const entry of entries) {
    if (entry.state === "ready") {
      employees.push(entry);
      continue;
    }
    // Left out by choice: shown as a count, so no name is looked up.
    if (entry.state === "left_out") {
      employees.push({ ...entry, reasons: entry.reasons.map((r) => leftOutLabel(r, deps.exclude)) });
      continue;
    }
    const name = await personName(deps.ct, entry.ctUserId);
    employees.push(name ? { ...entry, name } : entry);
  }

  return { generatedAt: new Date().toISOString(), counts: summarizeRoster(entries), employees };
}

export type DigestResult =
  | { outcome: "sent"; messages: number }
  | { outcome: "failed"; sent: number; messages: number };

/**
 * Send the digest to the admin channel right now, unconditionally. Stops at
 * the first chunk Connecteam fails to take (issue #94), so a digest never
 * arrives with a gap in the middle. A re-send then repeats the chunks that
 * did go out, which is acceptable for an admin-facing digest.
 */
export async function runStatusDigestNow(deps: StatusDeps): Promise<DigestResult> {
  const roster = await buildStatusRoster(deps);
  const messages = digestMessages(roster.employees as DigestEmployee[], roster.employees.length);
  for (const [sent, text] of messages.entries()) {
    const res = await deps.ct.sendChannelMessage(deps.adminChannelId, text);
    if (res.outcome !== "ok") {
      logEvent({
        evt: "message_send_failed",
        notice: "status_digest",
        outcome: res.outcome,
        status: res.status,
        chunk: sent + 1,
        messages: messages.length,
      });
      return { outcome: "failed", sent, messages: messages.length };
    }
  }
  return { outcome: "sent", messages: messages.length };
}

/** At least this long between two automatic digests, regardless of how often the cron ticks. */
export const STATUS_DIGEST_MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;
/**
 * Pause after a failed automatic digest. The cron ticks every minute, and each
 * attempt rebuilds the roster (a Connecteam lookup per non-ready person) out of
 * the same rate budget the approval sweep needs - so a Connecteam outage must
 * not mean a retry every minute.
 */
export const STATUS_DIGEST_RETRY_MS = 30 * 60 * 1000;
const DEFAULT_DIGEST_DAY = 1; // Monday (UTC), matching most payroll admins' work week.

function isDigestDay(dayVar: string | undefined, now: Date): boolean {
  const n = Number(dayVar);
  const day = Number.isInteger(n) && n >= 0 && n <= 6 ? n : DEFAULT_DIGEST_DAY;
  return now.getUTCDay() === day;
}

/**
 * Called from the 1-minute cron (src/index.ts), same pattern as
 * `maybeRunRecheck` / `maybePushHealth`: no dedicated Cloudflare Cron Trigger,
 * just a day-of-week check plus a "last sent" marker in `sync_meta` so a
 * digest fires once on its configured day even though the cron ticks every
 * minute.
 *
 * The marker is set only once every chunk has gone out (issue #94). A failed
 * digest sets `status_digest_retry_at` instead and tries again after
 * {@link STATUS_DIGEST_RETRY_MS}, while it's still the digest day (UTC). If
 * Connecteam stays down past midnight, that week's digest is skipped.
 */
export async function maybeRunStatusDigest(
  deps: StatusDeps & { digestDay?: string; now?: () => number },
): Promise<"sent" | "skipped" | "failed"> {
  const now = deps.now ?? Date.now;
  if (!isDigestDay(deps.digestDay, new Date(now()))) return "skipped";

  const meta = await deps.store.readMeta(["last_status_digest_at", "status_digest_retry_at"]);
  if (now() - (meta.last_status_digest_at ?? 0) < STATUS_DIGEST_MIN_GAP_MS) return "skipped";
  if (now() < (meta.status_digest_retry_at ?? 0)) return "skipped";

  const result = await runStatusDigestNow(deps);
  if (result.outcome === "failed") {
    await deps.store.setMarker("status_digest_retry_at", now() + STATUS_DIGEST_RETRY_MS);
    return "failed";
  }
  await deps.store.setMarker("last_status_digest_at", now());
  return "sent";
}

async function personName(
  ct: Pick<ConnecteamClient, "getUser">,
  ctUserId: number,
): Promise<string | undefined> {
  try {
    const res = await ct.getUser(ctUserId);
    if (res.outcome === "ok" && res.data) {
      const name = [res.data.firstName, res.data.lastName].filter(Boolean).join(" ").trim();
      return name || undefined;
    }
  } catch {
    // best-effort - fall back to the id-only label
  }
  return undefined;
}
