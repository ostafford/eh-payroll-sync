/**
 * Route-level checks only (auth + wiring + shape). The roster-derivation and
 * digest-content logic are covered at the unit level in test/status-*.test.ts
 * with fake gateways/Connecteam clients - a real `worker.fetch` round trip here
 * would otherwise need a live Connecteam account (POST /status/digest always
 * sends at least the "all clear" message, even for an empty/ready-only roster).
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../../src/index.js";
import { SyncStore } from "../../src/db/store.js";

const SECRET = "worker-test-webhook-secret";

beforeEach(async () => {
  (env as Record<string, unknown>).CT_WEBHOOK_SECRET = SECRET;
  (env as Record<string, unknown>).STATUS_TOKEN = "";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM employee_map"),
    env.DB.prepare("DELETE FROM sync_log"),
  ]);
});

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://worker.example${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /status (in workerd, real D1)", () => {
  it("rejects with no Authorization header", async () => {
    const { status } = await call("/status");
    expect(status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const { status } = await call("/status", { headers: { authorization: "Bearer nope" } });
    expect(status).toBe(401);
  });

  it("accepts the webhook secret as a fallback bearer token and returns an empty roster", async () => {
    const { status, body } = await call("/status", { headers: { authorization: `Bearer ${SECRET}` } });
    expect(status).toBe(200);
    expect(body.counts).toEqual({ ready: 0, waitingEmployee: 0, waitingAdmin: 0, broken: 0, leftOut: 0 });
    expect(body.employees).toEqual([]);
    expect(typeof body.generatedAt).toBe("string");
  });

  it("uses STATUS_TOKEN over CT_WEBHOOK_SECRET when both are set", async () => {
    (env as Record<string, unknown>).STATUS_TOKEN = "dedicated-status-token";
    const rejected = await call("/status", { headers: { authorization: `Bearer ${SECRET}` } });
    expect(rejected.status).toBe(401);
    const accepted = await call("/status", { headers: { authorization: "Bearer dedicated-status-token" } });
    expect(accepted.status).toBe(200);
  });

  it("lists a ready employee with no employee PII beyond ids and state - no Connecteam call needed", async () => {
    const store = new SyncStore(env.DB);
    await store.saveEmployeeLink({ ctUserId: 100, ehEmployeeId: "555", lastSyncedTs: 1, lastPayloadHash: "h", lastOutcome: "ok" });
    await store.appendSyncLog({ ctUserId: 100, at: 1, outcome: "ok", detail: "synced" });

    const { status, body } = await call("/status", { headers: { authorization: `Bearer ${SECRET}` } });
    expect(status).toBe(200);
    expect(body.counts).toEqual({ ready: 1, waitingEmployee: 0, waitingAdmin: 0, broken: 0, leftOut: 0 });
    expect(body.employees).toEqual([{ ctUserId: 100, ehEmployeeId: "555", state: "ready", reasons: [] }]);
  });
});

describe("POST /status/digest auth (in workerd)", () => {
  it("rejects with no Authorization header", async () => {
    const { status } = await call("/status/digest", { method: "POST" });
    expect(status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const { status } = await call("/status/digest", { method: "POST", headers: { authorization: "Bearer nope" } });
    expect(status).toBe(401);
  });
});

describe("POST /status/digest result (in workerd, Connecteam stubbed; issue #94)", () => {
  const realFetch = globalThis.fetch;
  const auth = { method: "POST", headers: { authorization: `Bearer ${SECRET}` } };
  // An empty roster sends exactly one "all clear" channel message. Every other
  // outbound call throws, so this test can never reach a real account.
  const stubChannelSend = (status: number) => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("/chat/v1/conversations/")) {
        return new Response(JSON.stringify({ requestId: "r", data: {} }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected outbound fetch: ${String(url)}`);
    }) as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("answers 200 sent when every message went out", async () => {
    stubChannelSend(200);
    const { status, body } = await call("/status/digest", auth);
    expect(status).toBe(200);
    expect(body).toEqual({ status: "sent", messages: 1 });
  });

  it("answers 502 failed when a send fails, instead of claiming it was sent", async () => {
    stubChannelSend(503);
    const { status, body } = await call("/status/digest", auth);
    expect(status).toBe(502);
    expect(body).toEqual({ status: "failed", sent: 0, messages: 1 });
  });
});
