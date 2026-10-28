// The Worker loads clients/self/field-map.json (FIELD_MAP_CLIENT is blank), so
// this fails while a client's map is mid-tuning. The wizard checks the map with
// `npm run validate-field-map` instead (issue #56).
import { env, createExecutionContext, createMessageBatch } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index.js";
import type { SyncJob } from "../../src/sync/job.js";

const RELAY = "https://relay.test/hook";
const realFetch = globalThis.fetch;
let integratorPosts: Array<Record<string, unknown>>;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sync_meta"),
    env.DB.prepare("DELETE FROM sync_log"),
  ]);
  integratorPosts = [];
  (env as Record<string, unknown>).INTEGRATOR_ALERT_URL = RELAY;
  (env as Record<string, unknown>).INTEGRATOR_ALERT_SECRET = "s3cr3t";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === RELAY) {
      integratorPosts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("", { status: 200 });
    }
    // Connecteam / Employment Hero - keep the sync path happy without real network.
    return new Response(JSON.stringify({ requestId: "r", data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (env as Record<string, unknown>).INTEGRATOR_ALERT_URL;
  delete (env as Record<string, unknown>).INTEGRATOR_ALERT_SECRET;
});

const dlqJob = (ctUserId: number): SyncJob => ({ reason: "profile_update", ctUserId, eventTimestamp: 1000 });
const qMsg = (body: SyncJob, id: string) => ({ id, timestamp: new Date(), attempts: 1, body });

describe("integrator telemetry (in workerd, real D1)", () => {
  it("POSTs one system_alert to the relay per dead-letter, deduped by user", async () => {
    const run = async (id: string) => {
      const ctx = createExecutionContext();
      await worker.queue(createMessageBatch("eh-payroll-sync-dlq", [qMsg(dlqJob(500), id)]), env, ctx);
    };

    await run("d1");
    await run("d2"); // same user, inside the dedupe window

    const alerts = integratorPosts.filter((p) => p.kind === "system_alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "system_alert", ctUserId: 500 });
    expect(String(alerts[0]!.reason)).toContain("retries exhausted");
  });

  it("sends nothing to the relay when INTEGRATOR_ALERT_URL is unset", async () => {
    delete (env as Record<string, unknown>).INTEGRATOR_ALERT_URL;
    const ctx = createExecutionContext();
    await worker.queue(createMessageBatch("eh-payroll-sync-dlq", [qMsg(dlqJob(501), "d3")]), env, ctx);
    expect(integratorPosts).toHaveLength(0);
  });
});
