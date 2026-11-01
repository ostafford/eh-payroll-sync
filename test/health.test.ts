import { describe, it, expect, beforeEach } from "vitest";
import { buildHealth, type HealthEnv } from "../src/health.js";
import { resetFieldMapCache } from "../src/mapping/loader.js";

beforeEach(resetFieldMapCache);

const okDb = (
  metaRows: Array<{ key: string; num: number }> = [],
  rosterRows: Array<Record<string, unknown>> = [],
) => ({
  prepare: (query: string) => ({
    first: async () => ({ ok: 1 }),
    all: async () => ({ results: query.includes("employee_map") ? rosterRows : metaRows }),
  }),
});

const baseEnv = (over: Partial<HealthEnv> = {}): HealthEnv => ({
  DB: okDb(),
  FIELD_MAP_CLIENT: "_example",
  EH_BUSINESS_ID: "",
  ...over,
});

describe("buildHealth", () => {
  it("is ok when D1 responds and the field-map loads", async () => {
    const h = await buildHealth(baseEnv());
    expect(h).toMatchObject({
      ok: true,
      service: "eh-payroll-sync",
      d1: "ok",
      fieldMap: "ok",
      config: { fieldMapClient: "_example", businessConfigured: false },
    });
    expect(typeof h.time).toBe("string");
  });

  it("is not ok and reports d1:error when the D1 query throws", async () => {
    const h = await buildHealth(
      baseEnv({
        DB: {
          prepare: () => ({
            first: async () => {
              throw new Error("no db");
            },
            all: async () => {
              throw new Error("no db");
            },
          }),
        },
      }),
    );
    expect(h.d1).toBe("error");
    expect(h.ok).toBe(false);
    expect(h.ops).toBeNull();
  });

  it("is not ok and explains why when the field-map client is unknown", async () => {
    const h = await buildHealth(baseEnv({ FIELD_MAP_CLIENT: "missing" }));
    expect(h.ok).toBe(false);
    expect(h.fieldMap).toContain("No field-map bundled");
    expect(h.config.fieldMapClient).toBe("missing");
  });

  it("reports businessConfigured once EH_BUSINESS_ID is set", async () => {
    const h = await buildHealth(baseEnv({ EH_BUSINESS_ID: "555455" }));
    expect(h.config.businessConfigured).toBe(true);
  });

  it("derives queue backlog, dead-letter count and last sweep time from sync_meta", async () => {
    const h = await buildHealth(
      baseEnv({
        DB: okDb([
          { key: "enqueued_total", num: 10 },
          { key: "acked_total", num: 7 },
          { key: "dl_total", num: 1 },
          { key: "last_sweep_ok_at", num: 1_700_000_000_000 },
          { key: "webhook_202_total", num: 4 },
          { key: "webhook_401_total", num: 2 },
        ]),
      }),
    );
    expect(h.ops).toEqual({
      queueBacklog: 2,
      deadLettered: 1,
      lastSweepOkAt: new Date(1_700_000_000_000).toISOString(),
      webhookAccepted: 4,
      webhookRejected: 2,
      ready: 0,
      waitingEmployee: 0,
      waitingAdmin: 0,
      broken: 0,
      leftOut: 0,
    });
  });

  it("reports zeroed ops and a null sweep time before anything has run", async () => {
    const h = await buildHealth(baseEnv());
    expect(h.ops).toEqual({
      queueBacklog: 0,
      deadLettered: 0,
      lastSweepOkAt: null,
      webhookAccepted: 0,
      webhookRejected: 0,
      ready: 0,
      waitingEmployee: 0,
      waitingAdmin: 0,
      broken: 0,
      leftOut: 0,
    });
  });

  it("derives the sync-status roster counts (issue #44) from employee_map + sync_log", async () => {
    const h = await buildHealth(
      baseEnv({
        DB: okDb(
          [],
          [
            { ctUserId: 1, ehEmployeeId: "1", failureCycleCount: 0, lastOutcome: "ok", latestOutcome: "ok", latestDetail: "synced" },
            { ctUserId: 2, ehEmployeeId: "2", failureCycleCount: 1, lastOutcome: "correction", latestOutcome: "correction", latestDetail: "correction: taxFileNumber" },
            { ctUserId: 3, ehEmployeeId: "3", failureCycleCount: 0, lastOutcome: "follow_up", latestOutcome: "follow_up", latestDetail: "follow_up: pay-run defaults" },
            { ctUserId: 4, ehEmployeeId: null, failureCycleCount: null, lastOutcome: null, latestOutcome: "dead_letter", latestDetail: "retries exhausted" },
            { ctUserId: 5, ehEmployeeId: null, failureCycleCount: 0, lastOutcome: "excluded", latestOutcome: "excluded", latestDetail: "excluded: customField 42920839 (Employee Status)" },
          ],
        ),
      }),
    );
    // Left out by choice (rules.exclude) is its own count, never "broken".
    expect(h.ops).toMatchObject({ ready: 1, waitingEmployee: 1, waitingAdmin: 1, broken: 1, leftOut: 1 });
  });
});
