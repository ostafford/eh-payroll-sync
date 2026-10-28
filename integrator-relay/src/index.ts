/**
 * The integrator telemetry relay (issue #23). One standalone Worker the
 * integrator hosts once — NOT part of any client deployment. It receives the
 * `system_alert` / `health` pushes a client Worker sends when
 * `INTEGRATOR_ALERT_URL` is set, and turns them into GitHub issues (and,
 * optionally, an email webhook) so the integrator hears about a client's
 * problem promptly.
 *
 * Routes:
 *   POST /        - a telemetry push. Requires `x-eh-sync-secret: RELAY_SECRET`.
 *   GET  /health  - the relay's own liveness check.
 */
import { GitHubRestIssues } from "./github.js";
import { handleTelemetry } from "./relay.js";

export interface Env {
  /** Shared secret; every client's INTEGRATOR_ALERT_SECRET must equal this. */
  RELAY_SECRET: string;
  /** Fine-grained PAT, Issues:read+write on GITHUB_REPO. Only lives here. */
  GITHUB_TOKEN: string;
  /** "owner/name" of the repo that receives the issues. */
  GITHUB_REPO: string;
  /** Optional: also POST a compact alert here (Zapier / Make / SMTP bridge). */
  EMAIL_WEBHOOK_URL?: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/health") {
      return json(200, { ok: true, service: "eh-payroll-sync-relay" });
    }
    if (req.method !== "POST") {
      return json(405, { error: "POST only" });
    }
    if (!env.RELAY_SECRET || req.headers.get("x-eh-sync-secret") !== env.RELAY_SECRET) {
      return json(401, { error: "missing or invalid x-eh-sync-secret" });
    }
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json(500, { error: "relay not configured: GITHUB_TOKEN / GITHUB_REPO" });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON body" });
    }

    const gh = new GitHubRestIssues({ repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN });
    const forwardEmail = env.EMAIL_WEBHOOK_URL
      ? mkEmailForward(env.EMAIL_WEBHOOK_URL)
      : undefined;

    try {
      const r = await handleTelemetry(body, {
        gh,
        now: () => new Date(),
        ...(forwardEmail ? { forwardEmail } : {}),
      });
      return json(r.status, r.body);
    } catch (err) {
      // The client Worker ignores our response, but log a 502 for `wrangler tail`.
      return json(502, { error: "relay upstream failure", detail: String(err) });
    }
  },
} satisfies ExportedHandler<Env>;

/** POST a compact `{ subject, text }` to an external email webhook. */
function mkEmailForward(url: string) {
  return async (subject: string, text: string): Promise<void> => {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, text }),
    });
  };
}
