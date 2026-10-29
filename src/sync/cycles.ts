/**
 * The failure-cycle state machine (CONTEXT.md "Correction cycle"). One sync
 * attempt that ends in a Validation failure is one cycle. Cycles do NOT
 * auto-retry - the next attempt only happens when the employee edits their
 * Connecteam data again (a fresh webhook or sweep event).
 *
 *   - cycles 1-2  -> message the employee only
 *   - cycle 3+    -> also message the Direct manager
 *   - a clean sync (or a synced-with-follow-up) resets the count to 0
 *
 * The count lives in D1 `employee_map.failure_cycle_count`; this module reaches
 * it through a thin {@link CycleStore} so it stays node-testable with a fake.
 */
import type { SyncDecision } from "./decide.js";

/**
 * Connecteam custom-field type carrying the Direct manager's Connecteam userId.
 * Matched by type, not id: custom-field ids are per account (verified live on
 * the demo account 2026-10-29: every user custom field carries `type`).
 */
export const DIRECT_MANAGER_FIELD_TYPE = "directManager";

/** The demo account's Direct manager field id - a fallback for a value with no `type`. */
export const DIRECT_MANAGER_FIELD_ID = 25145114;

/** Cycle at which the Direct manager is also messaged. */
export const MANAGER_ESCALATION_CYCLE = 3;

export interface CycleStore {
  getFailureCount(ctUserId: number): Promise<number>;
  setFailureCount(ctUserId: number, count: number): Promise<void>;
}

export type CycleOutcome =
  | { action: "none" }
  | { action: "reset"; previous: number }
  | { action: "correction"; cycle: number; notifyManager: boolean }
  | { action: "follow_up" }
  | { action: "system_alert" };

/**
 * Fold one decision into the per-person failure count and say what to send.
 * Returns the recipient shape only - resolving the Direct manager's userId and
 * the actual message send are the caller's job (#6).
 */
export async function advanceCycle(
  store: CycleStore,
  ctUserId: number,
  decision: SyncDecision,
): Promise<CycleOutcome> {
  const previous = await store.getFailureCount(ctUserId);

  switch (decision.kind) {
    case "ok": {
      if (previous > 0) {
        await store.setFailureCount(ctUserId, 0);
        return { action: "reset", previous };
      }
      return { action: "none" };
    }
    case "follow_up": {
      // The record synced (safe defaults) - treat it as a clean sync for the count.
      if (previous > 0) await store.setFailureCount(ctUserId, 0);
      return { action: "follow_up" };
    }
    case "correction": {
      const cycle = previous + 1;
      await store.setFailureCount(ctUserId, cycle);
      return { action: "correction", cycle, notifyManager: cycle >= MANAGER_ESCALATION_CYCLE };
    }
    case "retry": {
      // A system fault, not a correction cycle - leave the counter untouched.
      // Becomes a System alert only once the queue exhausts its retries.
      return { action: "system_alert" };
    }
  }
}

/** The Direct manager's Connecteam userId, or null if not set / unparseable. */
export function directManagerUserId(
  customFields: ReadonlyArray<{ customFieldId: number; type?: string; value: unknown }>,
): number | null {
  const cf =
    customFields.find((f) => f.type === DIRECT_MANAGER_FIELD_TYPE) ??
    customFields.find((f) => f.customFieldId === DIRECT_MANAGER_FIELD_ID);
  return toUserId(cf?.value);
}

function toUserId(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const s = value.trim();
    return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
  }
  if (Array.isArray(value)) return value.length > 0 ? toUserId(value[0]) : null;
  if (value && typeof value === "object" && "value" in value) {
    return toUserId((value as { value: unknown }).value);
  }
  return null;
}
