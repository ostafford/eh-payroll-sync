/**
 * D1 schema. Holds identifiers, sync bookkeeping and an audit trail only -
 * never a TFN, bank detail or any other employee value. Keep it that way.
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/** Connecteam user <-> Employment Hero employee, plus per-person sync state. */
export const employeeMap = sqliteTable("employee_map", {
  ctUserId: integer("ct_user_id").primaryKey(),
  ehEmployeeId: text("eh_employee_id"),
  /** Connecteam event time (epoch ms) of the last change we synced. */
  lastSyncedTs: integer("last_synced_ts"),
  /** Consecutive failed correction cycles; resets to 0 on a successful sync. */
  failureCycleCount: integer("failure_cycle_count").notNull().default(0),
  /** Hash of the last cleanly-synced mapped payload; NULL after any non-clean outcome. */
  lastPayloadHash: text("last_payload_hash"),
  /** The `sync_log.outcome` of the most recent attempt - lets the recheck pass (#43) find every follow_up row without scanning sync_log. */
  lastOutcome: text("last_outcome", {
    enum: ["ok", "correction", "follow_up", "retry", "dead_letter", "resolved", "collision", "excluded"],
  }),
  updatedAt: integer("updated_at").notNull(),
});

/** Last-seen state of each onboarding-pack assignment, for the approval sweep diff. */
export const onboardingState = sqliteTable(
  "onboarding_state",
  {
    assignmentId: integer("assignment_id").primaryKey(),
    ctUserId: integer("ct_user_id").notNull(),
    status: text("status", { enum: ["in_progress", "completed"] }).notNull(),
    isWaitingApproval: integer("is_waiting_approval", { mode: "boolean" }).notNull().default(false),
    seenAt: integer("seen_at").notNull(),
  },
  (t) => [index("idx_onboarding_state_user").on(t.ctUserId)],
);

/** Append-only audit log. `detail` carries field NAMES and status only. */
export const syncLog = sqliteTable(
  "sync_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ctUserId: integer("ct_user_id").notNull(),
    at: integer("at").notNull(),
    outcome: text("outcome", {
      enum: ["ok", "correction", "follow_up", "retry", "dead_letter", "resolved", "collision", "excluded"],
    }).notNull(),
    detail: text("detail"),
  },
  (t) => [index("idx_sync_log_user_at").on(t.ctUserId, t.at)],
);

/** Operational counters and markers surfaced by /health. Counts and timestamps only. */
export const syncMeta = sqliteTable("sync_meta", {
  key: text("key").primaryKey(),
  num: integer("num").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
