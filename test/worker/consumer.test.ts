import {
  env,
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadFieldMap } from "../../src/mapping/loader.js";
import { EhPayrollClient } from "../../src/eh/client.js";
import { ConnecteamClient } from "../../src/connecteam/client.js";
import { SyncStore } from "../../src/db/store.js";
import { runSyncJob, dispatchBatch, retryDelaySeconds, type SyncDeps } from "../../src/sync/consumer.js";
import type { SyncJob } from "../../src/sync/job.js";
import { syntheticUser } from "../fixtures/connecteam-user.js";

const fieldMap = loadFieldMap("_example");

const DLQ = "eh-payroll-sync-dlq";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface WorldOpts {
  ctUser?: unknown;
  ehValidationMessage?: string;
  ehStatus?: string;
  ehDetailedStatus?: string | null;
  /** Connecteam's user lookup answers 503, so the job asks for a retry. */
  ctDown?: boolean;
}

/** A tiny in-memory Employment Hero + Connecteam, driven through the real clients. */
function world(opts: WorldOpts = {}) {
  let record: Record<string, unknown> | null = null;
  const sent = { dms: [] as Array<{ userId: number; text: string }>, channels: [] as Array<{ id: string; text: string }> };
  const ctUser = "ctUser" in opts ? opts.ctUser : syntheticUser;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyJson = init?.body ? JSON.parse(init.body as string) : {};

    // --- Employment Hero ---
    if (u.includes("/employee/unstructured/externalid/")) {
      return record ? json(200, record) : json(404, { message: "not found" });
    }
    if (method === "POST" && u.endsWith("/employee/unstructured")) {
      if (opts.ehValidationMessage) return json(400, { message: opts.ehValidationMessage });
      record = { id: 987, ...bodyJson, status: opts.ehStatus ?? "Active" };
      return json(201, {
        id: 987,
        status: opts.ehStatus ?? "Active",
        detailedStatus: opts.ehDetailedStatus ?? null,
        operationType: "Create",
      });
    }
    if (method === "PUT" && u.includes("/employee/unstructured/")) {
      if (opts.ehValidationMessage) return json(400, { message: opts.ehValidationMessage });
      record = { ...record, ...bodyJson, id: 987, status: opts.ehStatus ?? "Active" };
      return json(200, {
        id: 987,
        status: opts.ehStatus ?? "Active",
        detailedStatus: opts.ehDetailedStatus ?? null,
        operationType: "Update",
      });
    }

    // --- Connecteam ---
    if (u.includes("/users/v1/users")) {
      if (opts.ctDown) return json(503, { message: "unavailable" });
      return json(200, { requestId: "r", data: { users: ctUser ? [ctUser] : [] } });
    }
    if (method === "POST" && u.includes("/chat/v1/conversations/privateMessage/")) {
      sent.dms.push({ userId: Number(u.split("/privateMessage/")[1]), text: bodyJson.text });
      return json(200, { requestId: "r", data: {} });
    }
    if (method === "POST" && u.includes("/chat/v1/conversations/")) {
      sent.channels.push({ id: u.split("/conversations/")[1]!.split("/message")[0]!, text: bodyJson.text });
      return json(200, { requestId: "r", data: {} });
    }
    throw new Error(`unmatched ${method} ${u}`);
  }) as unknown as typeof fetch;

  const deps: SyncDeps = {
    ct: new ConnecteamClient({ apiKey: "k", customPublisherId: 2440905, fetchImpl }),
    eh: new EhPayrollClient({ apiKey: "k", businessId: "555455", fetchImpl }),
    store: new SyncStore(env.DB),
    fieldMap,
    adminChannelId: "chan-1",
    now: () => 1_700_000_000_000,
  };
  return { deps, sent, get record() { return record; } };
}

const job = (over: Partial<SyncJob> = {}): SyncJob => ({
  reason: "approval",
  ctUserId: syntheticUser.userId,
  eventTimestamp: 1000,
  ...over,
});

const qMsg = (body: SyncJob, id = "m1", attempts = 1) => ({ id, timestamp: new Date(), attempts, body });

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM employee_map"),
    env.DB.prepare("DELETE FROM sync_log"),
    env.DB.prepare("DELETE FROM sync_meta"),
  ]);
});

describe("queue consumer (in workerd, real D1)", () => {
  it("creates the Employment Hero record and links it in D1", async () => {
    const w = world();
    const out = await runSyncJob(job(), w.deps);

    expect(out.status).toBe("synced");
    expect(out.ehEmployeeId).toBe("987");
    expect(w.record).toMatchObject({ externalId: "17760356", firstName: "Samuel" });

    const row = await env.DB.prepare("SELECT * FROM employee_map WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .first<{ eh_employee_id: string; last_synced_ts: number; last_payload_hash: string | null }>();
    expect(row?.eh_employee_id).toBe("987");
    expect(row?.last_synced_ts).toBe(1000);
    expect(row?.last_payload_hash).toBeTruthy();

    const audit = await env.DB.prepare("SELECT outcome FROM sync_log WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .all<{ outcome: string }>();
    expect(audit.results.map((r) => r.outcome)).toEqual(["ok"]);
  });

  it("detects an EH identity collision (two Connecteam users resolving to the same EH employee id)", async () => {
    // First employee syncs cleanly and owns EH employee 987 (world()'s fake
    // always assigns id 987, standing in for Employment Hero matching two
    // people by TFN and merging them onto one record).
    await runSyncJob(job({ ctUserId: 17760356 }), world().deps);

    const secondUser = structuredClone(syntheticUser);
    secondUser.userId = 999999;
    const w2 = world({ ctUser: secondUser });

    const out = await runSyncJob(job({ ctUserId: 999999, eventTimestamp: 2000 }), w2.deps);

    expect(out).toMatchObject({ status: "collision" });
    expect(out.reason).toContain("987");
    expect(out.reason).toContain("17760356");
    expect(w2.sent.channels).toHaveLength(1);
    expect(w2.sent.channels[0]!.text).toMatch(/already linked to a different Connecteam user/);

    // The second user was never saved as owning employee 987.
    const row = await env.DB.prepare("SELECT eh_employee_id FROM employee_map WHERE ct_user_id = 999999")
      .first<{ eh_employee_id: string | null } | null>();
    expect(row).toBeNull();

    const audit = await env.DB.prepare("SELECT outcome FROM sync_log WHERE ct_user_id = 999999")
      .all<{ outcome: string }>();
    expect(audit.results.map((r) => r.outcome)).toEqual(["collision"]);
  });

  it("updates the same record on a newer event and no-ops a replay", async () => {
    await runSyncJob(job({ eventTimestamp: 1000 }), world().deps);

    // Same payload, newer event -> unchanged, no-op.
    const again = await runSyncJob(job({ eventTimestamp: 2000 }), world().deps);
    expect(again).toMatchObject({ status: "skipped", reason: "identical to the last processed state" });

    // Older/duplicate event -> stale, no-op.
    const stale = await runSyncJob(job({ eventTimestamp: 1000 }), world().deps);
    expect(stale.status).toBe("skipped");

    const row = await env.DB.prepare("SELECT last_synced_ts FROM employee_map WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .first<{ last_synced_ts: number }>();
    expect(row?.last_synced_ts).toBe(1000);
  });

  it("drives the correction path on an Employment Hero 400", async () => {
    const w = world({ ehValidationMessage: "BankAccount1: BSB must contain 6 digits only" });
    const out = await runSyncJob(job(), w.deps);

    expect(out.status).toBe("correction");
    expect(w.sent.dms).toHaveLength(1);
    expect(w.sent.dms[0]!.userId).toBe(syntheticUser.userId);
    expect(w.sent.dms[0]!.text).toMatch(/BSB/);

    const row = await env.DB.prepare("SELECT failure_cycle_count, last_payload_hash FROM employee_map WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .first<{ failure_cycle_count: number; last_payload_hash: string | null }>();
    expect(row?.failure_cycle_count).toBe(1);
    // Stored even on a correction, so an identical re-delivery is skipped.
    expect(row?.last_payload_hash).toBeTruthy();
  });

  it("thanks the employee by topic once their Correction is fixed, reading the Correction from real D1 (issue #71)", async () => {
    const bad = world({ ehValidationMessage: "BankAccount1: BSB must contain 6 digits only" });
    expect((await runSyncJob(job(), bad.deps)).status).toBe("correction");

    // The employee fixes it: a new edit (new payload), and EH now accepts it.
    const fixedUser = structuredClone(syntheticUser);
    fixedUser.customFields.find((f) => f.customFieldId === 25145108)!.value = "Senior Support Officer";
    const good = world({ ctUser: fixedUser });
    const out = await runSyncJob(job({ eventTimestamp: 2000 }), good.deps);

    expect(out.status).toBe("synced");
    expect(good.sent.dms.map((d) => d.text)).toEqual([
      "Thanks, that's fixed: your bank details have now been updated in Employment Hero.\n\nThis is an automated message from the Employment Hero sync.",
    ]);
    const row = await env.DB.prepare("SELECT failure_cycle_count FROM employee_map WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .first<{ failure_cycle_count: number }>();
    expect(row?.failure_cycle_count).toBe(0);
  });

  it("skips an identical re-delivery for an employee stuck in correction (no re-message, no cycle bump)", async () => {
    const w = world({ ehValidationMessage: "BankAccount1: BSB must contain 6 digits only" });
    await runSyncJob(job({ eventTimestamp: 1000 }), w.deps);

    const w2 = world({ ehValidationMessage: "BankAccount1: BSB must contain 6 digits only" });
    const again = await runSyncJob(job({ eventTimestamp: 2000 }), w2.deps);

    expect(again).toMatchObject({ status: "skipped", reason: "identical to the last processed state" });
    expect(w2.sent.dms).toHaveLength(0);
    const row = await env.DB.prepare("SELECT failure_cycle_count FROM employee_map WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .first<{ failure_cycle_count: number }>();
    expect(row?.failure_cycle_count).toBe(1);
  });

  it("does not re-post a follow-up notice for a still-Incomplete record on a later edit (issue #27)", async () => {
    const incomplete = { ehStatus: "Incomplete", ehDetailedStatus: "Pay Run Defaults are incomplete" };

    const w1 = world(incomplete);
    const out1 = await runSyncJob(job({ eventTimestamp: 1000 }), w1.deps);
    expect(out1.status).toBe("follow_up");
    expect(w1.sent.channels).toHaveLength(1);

    // A genuine later edit: different mapped payload, same follow-up reason.
    const edited = structuredClone(syntheticUser);
    edited.customFields.find((f) => f.customFieldId === 42920715)!.value = "Brunswick";
    const w2 = world({ ...incomplete, ctUser: edited });
    const out2 = await runSyncJob(job({ eventTimestamp: 2000 }), w2.deps);

    expect(out2.status).toBe("follow_up");
    expect(out2.noticeSuppressed).toBe(true);
    expect(w2.sent.channels).toHaveLength(0);

    const audit = await env.DB.prepare("SELECT outcome FROM sync_log WHERE ct_user_id = ?")
      .bind(syntheticUser.userId)
      .all<{ outcome: string }>();
    expect(audit.results.map((r) => r.outcome)).toEqual(["follow_up", "follow_up"]);
  });

  it("acks a good message and retries an outage through a real MessageBatch", async () => {
    // First message syncs fine; craft a second world where EH is down.
    const good = world();
    const batch = createMessageBatch("eh-payroll-sync-queue", [qMsg(job({ ctUserId: 17760356 }), "ok-1")]);
    const ctx = createExecutionContext();
    await dispatchBatch(batch, good.deps, DLQ);
    const res = await getQueueResult(batch, ctx);
    expect(res.explicitAcks).toContain("ok-1");
  });

  it("retries an outage with a backoff delay through a real MessageBatch (issue #90)", async () => {
    const w = world({ ctDown: true });
    const batch = createMessageBatch("eh-payroll-sync-queue", [qMsg(job(), "down-1", 4)]);
    const ctx = createExecutionContext();
    // The pool's test MessageBatch drops retry() options from its result
    // (vitest-pool-workers 0.22), so read the delay off the call itself.
    const retry = vi.spyOn(batch.messages[0]!, "retry");

    await dispatchBatch(batch, w.deps, DLQ);
    const res = await getQueueResult(batch, ctx);

    expect(res.explicitAcks).not.toContain("down-1");
    expect(res.retryMessages.map((m) => m.msgId)).toEqual(["down-1"]);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(4) });
  });

  it("dead-letter batch posts a System alert to the admin channel and acks", async () => {
    const w = world();
    const batch = createMessageBatch(DLQ, [qMsg(job({ ctUserId: 42 }), "dlq-1")]);
    const ctx = createExecutionContext();

    await dispatchBatch(batch, w.deps, DLQ);
    const res = await getQueueResult(batch, ctx);

    expect(res.explicitAcks).toContain("dlq-1");
    expect(w.sent.channels).toHaveLength(1);
    expect(w.sent.channels[0]!.id).toBe("chan-1");
    expect(w.sent.channels[0]!.text).toMatch(/could not be retried/i);

    const audit = await env.DB.prepare("SELECT outcome FROM sync_log WHERE ct_user_id = 42").all<{ outcome: string }>();
    expect(audit.results.map((r) => r.outcome)).toEqual(["dead_letter"]);
  });
});
