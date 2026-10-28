import { Hono, type Context } from "hono";
import type { Env, SyncJob } from "./env.js";
import { buildHealth } from "./health.js";
import { loadFieldMap } from "./mapping/loader.js";
import { EhPayrollClient } from "./eh/client.js";
import { ConnecteamClient } from "./connecteam/client.js";
import { SyncStore } from "./db/store.js";
import { dispatchBatch, type SyncDeps } from "./sync/consumer.js";
import { runSweep } from "./cron/sweep.js";
import { runRecheck } from "./cron/recheck.js";
import { handleWebhook } from "./webhook/inbound.js";
import { DEFAULT_SCHEME, timingSafeEqual } from "./connecteam/signature.js";
import { logEvent } from "./log.js";
import { postIntegrator, SYSTEM_ALERT_DEDUPE_MS, HEALTH_PUSH_INTERVAL_MS } from "./integrator.js";
import {
  buildStatusRoster,
  maybeRunStatusDigest as maybeRunStatusDigestCore,
  runStatusDigestNow,
} from "./status/service.js";
import { redact } from "./redact.js";

/** Dead-letter queue name (see `dead_letter_queue` in wrangler.jsonc). */
const DLQ_NAME = "eh-payroll-sync-dlq";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const health = await buildHealth(c.env);
  return c.json(health, health.ok ? 200 : 503);
});

/**
 * True if the request carries a valid `Authorization: Bearer <token>` for
 * `/status` (issue #44). `STATUS_TOKEN` is optional - unset, the webhook
 * secret doubles as the status token so /status works with no extra setup.
 * With neither configured, access is refused rather than left open.
 */
function checkStatusAuth(c: Context<{ Bindings: Env }>): boolean {
  const expected = (c.env.STATUS_TOKEN || c.env.CT_WEBHOOK_SECRET || "").trim();
  if (!expected) return false;
  const header = c.req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token.length > 0 && timingSafeEqual(token, expected);
}

function buildCt(env: Env): ConnecteamClient {
  return new ConnecteamClient({ apiKey: env.CT_API_KEY, customPublisherId: Number(env.CT_CUSTOM_PUBLISHER_ID) });
}

/**
 * Standing view of every employee's sync state (issue #44), so an admin can
 * answer "is everyone I manage fully and correctly in EH, and if not, who and
 * why?" without opening EH per-person before a pay run. See
 * src/status/roster.ts for the state definitions and src/status/service.ts for
 * the honest limit on what `ready` actually guarantees.
 */
app.get("/status", async (c) => {
  if (!checkStatusAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const roster = await buildStatusRoster({ store: new SyncStore(c.env.DB), ct: buildCt(c.env) });
  return c.json(redact(roster));
});

/** On-demand version of the weekly status digest the admin channel gets automatically. */
app.post("/status/digest", async (c) => {
  if (!checkStatusAuth(c)) return c.json({ error: "unauthorized" }, 401);
  const result = await runStatusDigestNow({
    store: new SyncStore(c.env.DB),
    ct: buildCt(c.env),
    adminChannelId: c.env.ADMIN_CONNECTEAM_CHANNEL_ID,
  });
  // 502: Connecteam, upstream of us, didn't take a message (issue #94).
  if (result.outcome === "failed") {
    return c.json({ status: "failed", sent: result.sent, messages: result.messages }, 502);
  }
  return c.json({ status: "sent", messages: result.messages });
});

/**
 * Connecteam `user_updated` webhook. Check the shared secret, answer
 * immediately, and enqueue a `profile_update` sync. The secret check + payload
 * parsing are in src/webhook/inbound.ts; this route only does the enqueue.
 */
app.post("/webhook", async (c) => {
  const rawBody = await c.req.text();
  const outcome = await handleWebhook({
    rawBody,
    signatureHeader: c.req.header(DEFAULT_SCHEME.header),
    secret: c.env.CT_WEBHOOK_SECRET,
  });
  const store = new SyncStore(c.env.DB);

  if (outcome.job) {
    try {
      await c.env.SYNC_QUEUE.send(outcome.job);
      await store.bumpCounter("enqueued_total", 1);
    } catch {
      logEvent({ evt: "webhook", status: 503, ctUserId: outcome.job.ctUserId, reason: "enqueue failed" });
      return c.json({ error: "could not enqueue" }, 503);
    }
  }

  // Delivery-outcome counters, surfaced by /health so setup (issue #28) and
  // ongoing ops can see the webhook is actually live: a 202 means Connecteam
  // delivered and the signature verified; a 401 means a delivery arrived but
  // its secretKey did not match CT_WEBHOOK_SECRET.
  if (outcome.status === 202) await store.bumpCounter("webhook_202_total", 1);
  else if (outcome.status === 401) await store.bumpCounter("webhook_401_total", 1);

  logEvent({
    evt: "webhook",
    status: outcome.status,
    ctUserId: outcome.job?.ctUserId ?? null,
    ...(outcome.shape ? { shape: outcome.shape } : {}),
  });
  return c.json(outcome.body, outcome.status as 200 | 202 | 400 | 401 | 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

function buildDeps(env: Env): SyncDeps {
  const store = new SyncStore(env.DB);
  return {
    ct: buildCt(env),
    eh: new EhPayrollClient({ apiKey: env.EH_API_KEY, businessId: env.EH_BUSINESS_ID }),
    store,
    fieldMap: loadFieldMap(env.FIELD_MAP_CLIENT),
    adminChannelId: env.ADMIN_CONNECTEAM_CHANNEL_ID,
    ...(env.INTEGRATOR_ALERT_URL
      ? {
          onSystemAlert: async ({ ctUserId, reason }: { ctUserId: number; reason: string }) => {
            // Dedupe per user within the window so a flapping client can't flood.
            const key = `integ_alert_${ctUserId}`;
            const last = (await store.readMeta([key]))[key] ?? 0;
            if (Date.now() - last < SYSTEM_ALERT_DEDUPE_MS) return;
            await store.setMarker(key, Date.now());
            await postIntegrator(env, {
              kind: "system_alert",
              client: env.INTEGRATOR_CLIENT_ID ?? "",
              ctUserId,
              reason,
              at: new Date().toISOString(),
            });
          },
        }
      : {}),
  };
}

/** Once a day, POST a redaction-safe /health summary to the integrator. */
async function maybePushHealth(env: Env, store: SyncStore): Promise<void> {
  if (!env.INTEGRATOR_ALERT_URL) return;
  const last = (await store.readMeta(["integ_health_at"])).integ_health_at ?? 0;
  if (Date.now() - last < HEALTH_PUSH_INTERVAL_MS) return;
  await store.setMarker("integ_health_at", Date.now());
  const h = await buildHealth(env);
  await postIntegrator(env, {
    kind: "health",
    client: env.INTEGRATOR_CLIENT_ID ?? "",
    ok: h.ok,
    d1: h.d1,
    fieldMap: h.fieldMap,
    ops: h.ops,
    at: h.time,
  });
}

/** Once a day, re-check every employee stuck on a Manual-follow-up (issue #43). */
const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function maybeRunRecheck(
  env: Env,
  store: SyncStore,
  ct: ConnecteamClient,
  sweepStatus: "ok" | "skipped" | "retry",
): Promise<void> {
  // "retry" = Connecteam itself is unavailable this tick; "skipped" = the sweep
  // deferred approvals under rate pressure. Either way, yield this tick to the
  // sweep and try again next minute - no marker is set, so nothing is lost.
  if (sweepStatus !== "ok") return;

  const last = (await store.readMeta(["last_recheck_at"])).last_recheck_at ?? 0;
  if (Date.now() - last < RECHECK_INTERVAL_MS) return;

  const eh = new EhPayrollClient({ apiKey: env.EH_API_KEY, businessId: env.EH_BUSINESS_ID });
  const result = await runRecheck({ eh, ct, store, adminChannelId: env.ADMIN_CONNECTEAM_CHANNEL_ID });
  await store.setMarker("last_recheck_at", Date.now());
  logEvent({ evt: "recheck", ...result });
}

/**
 * Weekly (default Monday, `STATUS_DIGEST_DAY`), post the sync-status digest to
 * the admin channel (issue #44). Gated the same way as the recheck pass: only
 * once the sweep has actually run this tick, so a digest never competes with
 * approvals for the sweep's Connecteam rate budget.
 */
async function maybeRunStatusDigest(
  env: Env,
  store: SyncStore,
  ct: ConnecteamClient,
  sweepStatus: "ok" | "skipped" | "retry",
): Promise<void> {
  if (sweepStatus !== "ok") return;
  const result = await maybeRunStatusDigestCore({
    store,
    ct,
    adminChannelId: env.ADMIN_CONNECTEAM_CHANNEL_ID,
    ...(env.STATUS_DIGEST_DAY !== undefined ? { digestDay: env.STATUS_DIGEST_DAY } : {}),
  });
  if (result !== "skipped") logEvent({ evt: "status_digest", result });
}

export default {
  fetch: app.fetch,

  /**
   * Sync queue consumer. One message = one Connecteam user to (re)sync.
   * Retryable faults call `message.retry()`; everything else acks. The
   * dead-letter queue raises a System alert.
   */
  async queue(batch, env): Promise<void> {
    await dispatchBatch(batch, buildDeps(env), DLQ_NAME);
    logEvent({ evt: "queue", queue: batch.queue, messages: batch.messages.length });
  },

  /** 1-minute cron: sweep the Connecteam onboarding API and enqueue new approvals. */
  async scheduled(_controller, env): Promise<void> {
    const ct = buildCt(env);
    const store = new SyncStore(env.DB);

    const result = await runSweep({
      packId: Number(env.CT_ONBOARDING_PACK_ID),
      listAssignments: (packId) => ct.listAssignments(packId),
      rateLimit: () => ct.lastRateLimit,
      readState: () => store.readOnboardingState(),
      writeState: (assignments, seenAt) => store.writeOnboardingState(assignments, seenAt),
      enqueue: async (jobs) => {
        await env.SYNC_QUEUE.sendBatch(jobs.map((body) => ({ body })));
        await store.bumpCounter("enqueued_total", jobs.length);
      },
    });

    if (result.status !== "retry") {
      await store.setMarker("last_sweep_ok_at", Date.now());
    }
    logEvent({ evt: "sweep", ...result });

    await maybeRunRecheck(env, store, ct, result.status);
    await maybeRunStatusDigest(env, store, ct, result.status);
    await maybePushHealth(env, store);
  },
} satisfies ExportedHandler<Env, SyncJob>;
