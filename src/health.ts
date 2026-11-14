import { loadFieldMap } from "./mapping/loader.js";
import {
  LINK_LIST_COUNTS_SQL,
  ROSTER_QUERY_SQL,
  countLinking,
  deriveRosterEntry,
  parseLinkListCounts,
  parseRosterRows,
  summarizeRoster,
} from "./status/roster.js";

/** The bits of the Worker env that /health inspects. The real Env satisfies this. */
export interface HealthEnv {
  DB: {
    prepare(query: string): {
      first(): Promise<unknown>;
      all(): Promise<{ results: unknown[] }>;
    };
  };
  FIELD_MAP_CLIENT?: string;
  EH_BUSINESS_ID: string;
}

export interface Health {
  ok: boolean;
  service: "eh-payroll-sync";
  time: string;
  d1: "ok" | "error";
  /** "ok", or the reason the client's field-map failed to load. */
  fieldMap: string;
  config: {
    fieldMapClient: string;
    businessConfigured: boolean;
  };
  /** Operational counters, or null if the meta table is unreadable. */
  ops: {
    /** Sync messages sent but not yet acked or dead-lettered. */
    queueBacklog: number;
    /** Jobs that exhausted their retries and dead-lettered. */
    deadLettered: number;
    /** ISO time the approval sweep last completed without error, or null. */
    lastSweepOkAt: string | null;
    /** `user_updated` deliveries accepted (202): Connecteam is delivering and the signature verifies. */
    webhookAccepted: number;
    /** `user_updated` deliveries rejected (401): a delivery arrived but its secretKey did not match. */
    webhookRejected: number;
    /** Sync-status roster counts (issue #44) - see src/status/roster.ts for state definitions. */
    ready: number;
    waitingEmployee: number;
    waitingAdmin: number;
    broken: number;
    /** Left out of the sync by choice (`rules.exclude`): nothing to act on, never counted as broken. */
    leftOut: number;
    /** Linking (ADR-0009, ADR-0010, #143 item 4): counts only, never an alert. Linked employees. */
    linked: number;
    /** Held employees: approved, stopped by the Pre-create check, waiting on the admin. */
    held: number;
    /** Links confirmed in the link stage and not made yet (the Link list). */
    pendingLinks: number;
  } | null;
}

export async function buildHealth(env: HealthEnv): Promise<Health> {
  let d1: Health["d1"] = "error";
  try {
    await env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch {
    d1 = "error";
  }

  let fieldMap = "ok";
  try {
    loadFieldMap(env.FIELD_MAP_CLIENT);
  } catch (err) {
    fieldMap = err instanceof Error ? err.message : "invalid field-map";
  }

  return {
    ok: d1 === "ok" && fieldMap === "ok",
    service: "eh-payroll-sync",
    time: new Date().toISOString(),
    d1,
    fieldMap,
    config: {
      fieldMapClient: env.FIELD_MAP_CLIENT?.trim() || "self",
      businessConfigured: Boolean(env.EH_BUSINESS_ID),
    },
    ops: await readOps(env),
  };
}

async function readOps(env: HealthEnv): Promise<Health["ops"]> {
  try {
    const { results } = await env.DB.prepare("SELECT key, num FROM sync_meta").all();
    const m = new Map((results as Array<{ key: string; num: number }>).map((r) => [r.key, r.num]));
    const enqueued = m.get("enqueued_total") ?? 0;
    const acked = m.get("acked_total") ?? 0;
    const deadLettered = m.get("dl_total") ?? 0;
    const sweepAt = m.get("last_sweep_ok_at") ?? 0;

    const rows = parseRosterRows((await env.DB.prepare(ROSTER_QUERY_SQL).all()).results);
    const counts = summarizeRoster(rows.map(deriveRosterEntry));
    const linking = countLinking(rows);
    const linkList = parseLinkListCounts((await env.DB.prepare(LINK_LIST_COUNTS_SQL).all()).results);

    return {
      queueBacklog: Math.max(0, enqueued - acked - deadLettered),
      deadLettered,
      lastSweepOkAt: sweepAt > 0 ? new Date(sweepAt).toISOString() : null,
      webhookAccepted: m.get("webhook_202_total") ?? 0,
      webhookRejected: m.get("webhook_401_total") ?? 0,
      ready: counts.ready,
      waitingEmployee: counts.waitingEmployee,
      waitingAdmin: counts.waitingAdmin,
      broken: counts.broken,
      leftOut: counts.leftOut,
      linked: linking.linked,
      held: linking.held,
      pendingLinks: linkList.pending,
    };
  } catch {
    return null;
  }
}
