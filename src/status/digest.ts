/**
 * Composes the weekly (or on-demand) admin-channel status digest (issue #44):
 * everyone NOT `ready`, grouped by state, one line each. Silent-but-for-a-line
 * when everyone is ready. Pure - no network, no D1.
 *
 * `ConnecteamClient.sendChannelMessage` clamps any single message to 500 chars
 * (see connecteam/client.ts), which would silently truncate a roster of any
 * real size mid-sentence. `digestMessages` returns an array instead of one
 * string - the caller sends each chunk as its own channel message - so a long
 * roster is never cut off, only split.
 */
import type { RosterEntry, RosterState } from "./roster.js";

export interface DigestEmployee extends RosterEntry {
  /** Best-effort display name; falls back to the id-only label when absent. */
  name?: string | null;
}

type NeedsAttention = Exclude<RosterState, "ready" | "left_out">;

const STATE_ORDER: readonly NeedsAttention[] = ["waiting_on_employee", "waiting_on_admin", "broken"];

/** Each group's heading, with a marker so the groups stand apart in the channel. */
const STATE_LABEL: Record<NeedsAttention, string> = {
  waiting_on_employee: "🟡 Waiting on employee",
  waiting_on_admin: "🟠 Waiting on admin",
  broken: "🔴 Broken",
};

const MAX_CHUNK = 480;

function who(e: DigestEmployee): string {
  const name = (e.name ?? "").trim();
  return name ? `${name} (${e.ctUserId})` : `Connecteam user ${e.ctUserId}`;
}

/** One or more admin-channel messages, each already within the 500-char clamp. */
export function digestMessages(employees: readonly DigestEmployee[], totalCount: number): string[] {
  const nonReady = employees.filter((e) => e.state !== "ready" && e.state !== "left_out");
  const leftOut = leftOutLines(employees);
  if (nonReady.length === 0) {
    const synced = totalCount - employees.filter((e) => e.state === "left_out").length;
    const singular = synced === 1;
    const clear = `All ${synced} employee${singular ? "" : "s"} ${singular ? "is" : "are"} Complete in Employment Hero - no follow-up needed.`;
    return chunk([clear, ...(leftOut.length ? ["", ...leftOut] : [])]);
  }

  const lines: string[] = [
    `Employment Hero sync status: ${nonReady.length} of ${totalCount} employees need attention.`,
  ];
  for (const state of STATE_ORDER) {
    const group = nonReady.filter((e) => e.state === state);
    if (group.length === 0) continue;
    lines.push("", `${STATE_LABEL[state]} (${group.length}):`);
    for (const e of group) {
      const reason = e.reasons.join("; ") || "see the audit log";
      lines.push(`• ${who(e)} — ${reason}`);
    }
  }
  if (leftOut.length) lines.push("", ...leftOut);
  return chunk(lines);
}

/** People left out of the sync by choice: one count line per reason, not a name each (nothing to act on). */
function leftOutLines(employees: readonly DigestEmployee[]): string[] {
  const counts = new Map<string, number>();
  for (const e of employees) {
    if (e.state !== "left_out") continue;
    const why = e.reasons[0] ?? "the field map";
    counts.set(why, (counts.get(why) ?? 0) + 1);
  }
  return [...counts].map(([why, n]) => `⚪ Left out by choice: ${n} (${why})`);
}

/** Pack lines into messages no longer than {@link MAX_CHUNK}, splitting on line boundaries only. */
function chunk(lines: readonly string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length > MAX_CHUNK && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out.length > 1 ? out.map((c, i) => (i === 0 ? c : `(cont.) ${c}`)) : out;
}
