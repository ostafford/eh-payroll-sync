/**
 * The relay's whole decision, pure and injectable:
 *
 *   system_alert  -> one OPEN GitHub issue per (client, ctUserId). First one
 *                    creates it; repeats add a comment. GitHub then emails the
 *                    integrator via issue notifications.
 *   health ok:false -> ensure an open issue per client, body = latest snapshot.
 *   health ok:true  -> if such an issue is open, comment "recovered" and close
 *                      it; otherwise do nothing (no perpetual "all good" issue).
 *
 * `forwardEmail` is an optional extra hop for integrators who want a direct
 * email rather than relying on GitHub notifications.
 */
import type { GitHubIssues } from "./github.js";
import { clientSlug, parseTelemetry, type SystemAlert, type HealthPush } from "./types.js";

export interface RelayDeps {
  gh: GitHubIssues;
  now: () => Date;
  forwardEmail?: (subject: string, text: string) => Promise<void>;
}

export interface RelayResult {
  status: number;
  body: Record<string, unknown>;
}

const LABELS_ALERT = ["eh-relay", "system-alert"];
const LABELS_HEALTH = ["eh-relay", "health"];

export async function handleTelemetry(rawBody: unknown, deps: RelayDeps): Promise<RelayResult> {
  const t = parseTelemetry(rawBody);
  if (!t) return { status: 400, body: { error: "unrecognised telemetry body" } };

  return t.kind === "system_alert"
    ? handleSystemAlert(t, deps)
    : handleHealth(t, deps);
}

async function handleSystemAlert(t: SystemAlert, deps: RelayDeps): Promise<RelayResult> {
  const client = clientSlug(t.client);
  const title = `[eh-payroll-sync] system alert — ${client} / user ${t.ctUserId}`;
  const existing = await deps.gh.findOpenByTitle(title);

  if (existing) {
    await deps.gh.comment(existing.number, `Recurred at ${t.at}.\n\n> ${t.reason}`);
    await forward(deps, title, `Recurred: ${t.reason} (${t.at})\n${existing.html_url}`);
    return { status: 202, body: { ok: true, issue: existing.number, deduped: true } };
  }

  const issue = await deps.gh.create({
    title,
    body: alertBody(client, t, deps.now()),
    labels: LABELS_ALERT,
  });
  await forward(deps, title, `${t.reason} (${t.at})\n${issue.html_url}`);
  return { status: 202, body: { ok: true, issue: issue.number, deduped: false } };
}

async function handleHealth(t: HealthPush, deps: RelayDeps): Promise<RelayResult> {
  const client = clientSlug(t.client);
  const title = `[eh-payroll-sync] health — ${client}`;
  const existing = await deps.gh.findOpenByTitle(title);

  if (!t.ok) {
    const body = healthBody(client, t, deps.now());
    if (existing) {
      await deps.gh.update(existing.number, { body });
      return { status: 202, body: { ok: true, issue: existing.number, updated: true } };
    }
    const issue = await deps.gh.create({ title, body, labels: LABELS_HEALTH });
    await forward(deps, title, `Health check failing for ${client} (${t.at})\n${issue.html_url}`);
    return { status: 202, body: { ok: true, issue: issue.number, updated: false } };
  }

  // ok: true
  if (existing) {
    await deps.gh.comment(existing.number, `Recovered — health OK again at ${t.at}.`);
    await deps.gh.update(existing.number, { state: "closed" });
    return { status: 202, body: { ok: true, issue: existing.number, closed: true } };
  }
  return { status: 202, body: { ok: true, noop: true } };
}

async function forward(deps: RelayDeps, subject: string, text: string): Promise<void> {
  if (!deps.forwardEmail) return;
  try {
    await deps.forwardEmail(subject, text);
  } catch {
    // the GitHub issue is already the source of truth; a failed email forward
    // must not fail the request.
  }
}

function alertBody(client: string, t: SystemAlert, seen: Date): string {
  return [
    `**Client:** \`${client}\``,
    `**Connecteam user:** \`${t.ctUserId}\``,
    `**Reason:** ${t.reason}`,
    `**First seen:** ${t.at}`,
    "",
    "A sync job for this user exhausted its retries and dead-lettered on the",
    "client's deployment. No employee action is possible — check the Employment",
    "Hero API status and the client's credentials. Recurrences are added as",
    "comments; close this issue once it's resolved.",
    "",
    `_relayed ${seen.toISOString()}_`,
  ].join("\n");
}

function healthBody(client: string, t: HealthPush, seen: Date): string {
  const head = [`**Client:** \`${client}\``, `**Status:** \`ok: ${t.ok}\``];
  if (t.d1) head.push(`**D1:** \`${t.d1}\``);
  if (t.fieldMap) head.push(`**Field map:** \`${t.fieldMap}\``);
  return [
    ...head,
    "",
    "```json",
    JSON.stringify({ ok: t.ok, d1: t.d1, fieldMap: t.fieldMap, ops: t.ops, at: t.at }, null, 2),
    "```",
    "",
    "This issue is opened/updated while the daily health push reports a problem,",
    "and closed automatically on the first healthy push.",
    "",
    `_relayed ${seen.toISOString()}_`,
  ].join("\n");
}
