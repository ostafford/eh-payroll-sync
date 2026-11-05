import type { SyncJob } from "./sync/job.js";

export type { SyncJob };

/** Worker bindings. Secrets come from `wrangler secret put`; the rest from wrangler.jsonc `vars`. */
export interface Env {
  DB: D1Database;
  SYNC_QUEUE: Queue<SyncJob>;

  // secrets
  CT_API_KEY: string;
  EH_API_KEY: string;
  CT_WEBHOOK_SECRET: string;
  /**
   * Keys the HMAC-SHA-256 fingerprints in a Linked employee's Baseline
   * (ADR-0009), so a stored fingerprint of a TFN can't be brute-forced. Losing
   * or changing it re-baselines every Linked employee without pushing.
   */
  BASELINE_KEY: string;
  /**
   * Bearer token for `GET /status` and `POST /status/digest` (issue #44).
   * Optional - unset falls back to `CT_WEBHOOK_SECRET` so /status works out of
   * the box, but a dedicated token lets it be rotated/shared independently of
   * the Connecteam webhook secret.
   */
  STATUS_TOKEN?: string;

  // vars
  /** Only for a multi-tenant deployment; blank/unset loads clients/self/. */
  FIELD_MAP_CLIENT?: string;
  EH_BUSINESS_ID: string;
  CT_ONBOARDING_PACK_ID: string;
  CT_CUSTOM_PUBLISHER_ID: string;
  ADMIN_CONNECTEAM_CHANNEL_ID: string;
  /** Day of week (0=Sun..6=Sat, UTC) the weekly status digest posts. Default: 1 (Monday). */
  STATUS_DIGEST_DAY?: string;

  /**
   * Optional integrator telemetry. If set, the Worker also POSTs each System
   * alert (deduped) and a once-a-day /health summary to this URL, with
   * `x-eh-sync-secret: <INTEGRATOR_ALERT_SECRET>`. Unset = off. The receiver is
   * the standalone relay in `integrator-relay/` (issue #23).
   */
  INTEGRATOR_ALERT_URL?: string;
  INTEGRATOR_ALERT_SECRET?: string;
  /** Short slug identifying this client on the shared relay (e.g. "acme"). */
  INTEGRATOR_CLIENT_ID?: string;
}
