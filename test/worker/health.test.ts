import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index.js";
import { SyncStore } from "../../src/db/store.js";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sync_meta"),
    env.DB.prepare("DELETE FROM employee_map"),
    env.DB.prepare("DELETE FROM sync_log"),
  ]);
});

const getHealth = async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://w.example/health"), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("/health (in workerd, real D1)", () => {
  it("reports zeroed ops before anything has run", async () => {
    const { body } = await getHealth();
    expect(body.ops).toEqual({
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
    expect(body.d1).toBe("ok");
  });

  it("derives queue backlog, dead-letter count and last sweep time from sync_meta", async () => {
    const store = new SyncStore(env.DB);
    await store.bumpCounter("enqueued_total", 5);
    await store.bumpCounter("acked_total", 2);
    await store.bumpCounter("dl_total", 1);
    await store.setMarker("last_sweep_ok_at", 1_700_000_000_000);
    await store.bumpCounter("webhook_202_total", 3);
    await store.bumpCounter("webhook_401_total", 1);

    const { body } = await getHealth();
    expect(body.ops).toEqual({
      queueBacklog: 2,
      deadLettered: 1,
      lastSweepOkAt: new Date(1_700_000_000_000).toISOString(),
      webhookAccepted: 3,
      webhookRejected: 1,
      ready: 0,
      waitingEmployee: 0,
      waitingAdmin: 0,
      broken: 0,
      leftOut: 0,
    });
  });

  it("derives the sync-status roster counts (issue #44) from real D1 rows", async () => {
    const store = new SyncStore(env.DB);
    await store.saveEmployeeLink({ ctUserId: 1, ehEmployeeId: "1", lastSyncedTs: 1, lastPayloadHash: "h1", lastOutcome: "ok" });
    await store.appendSyncLog({ ctUserId: 1, at: 1, outcome: "ok", detail: "synced" });
    await store.saveEmployeeLink({ ctUserId: 2, ehEmployeeId: "2", lastSyncedTs: 1, lastPayloadHash: "h2", lastOutcome: "correction" });
    await store.appendSyncLog({ ctUserId: 2, at: 1, outcome: "correction", detail: "correction: taxFileNumber" });

    const { body } = await getHealth();
    expect(body.ops).toMatchObject({ ready: 1, waitingEmployee: 1, waitingAdmin: 0, broken: 0 });
  });
});
