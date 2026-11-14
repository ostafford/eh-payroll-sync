import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index.js";
import { SyncStore } from "../../src/db/store.js";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sync_meta"),
    env.DB.prepare("DELETE FROM employee_map"),
    env.DB.prepare("DELETE FROM sync_log"),
    env.DB.prepare("DELETE FROM pending_link"),
    env.DB.prepare("DELETE FROM onboarding_state"),
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
      linked: 0,
      held: 0,
      pendingLinks: 0,
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
      linked: 0,
      held: 0,
      pendingLinks: 0,
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

  it("counts Linked and Held employees and pending links from real D1 rows (#156)", async () => {
    const store = new SyncStore(env.DB);
    const baseline = { keyId: "k1", units: { phone: "fp-phone" } };
    await store.completeLink({ ctUserId: 1, ehEmployeeId: "41", lastSyncedTs: 1, lastPayloadHash: "h1", lastOutcome: "ok" }, 10, baseline);
    await store.completeLink({ ctUserId: 2, ehEmployeeId: "42", lastSyncedTs: 1, lastPayloadHash: "h2", lastOutcome: "ok" }, 11, baseline);
    await store.saveEmployeeLink({ ctUserId: 3, ehEmployeeId: null, lastSyncedTs: 1, lastPayloadHash: null, lastOutcome: "existing_match" });
    await store.appendSyncLog({ ctUserId: 3, at: 1, outcome: "existing_match", detail: "existing_match: 40213" });
    await store.saveEmployeeLink({ ctUserId: 4, ehEmployeeId: "44", lastSyncedTs: 1, lastPayloadHash: "h4", lastOutcome: "ok" });
    await store.savePendingLink({ ctUserId: 5, ehEmployeeId: "45", confirmedAt: 1 });
    await store.savePendingLink({ ctUserId: 6, ehEmployeeId: null, confirmedAt: 1 });
    await store.savePendingLink({ ctUserId: 3, ehEmployeeId: "40213", confirmedAt: 1 });

    const { body } = await getHealth();
    expect(body.ops).toMatchObject({ linked: 2, held: 1, pendingLinks: 3 });
  });
});
