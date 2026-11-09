/**
 * The Pre-create check (ADR-0010, issue #149). Before every create - no EH
 * record carries this person's Payroll ID yet - look for an EH employee who is
 * already the same person, so a hand-entered record is never merged into or
 * duplicated. Any one key is a hit:
 *
 *   - email (EH's filter compares it case-insensitively, tested in #131);
 *   - TFN, skipped when it is an ATO placeholder (many people share those);
 *   - first name + surname + date of birth, as one filter (names case-insensitive,
 *     tested). A name alone isn't a hit.
 *
 * Up to three filtered `GET /employee/unstructured` calls, one after another
 * and always all of them, so the Existing-match notice lists every candidate.
 * A key the payload doesn't have is skipped. Terminated employees come back
 * from every filter (#141) and count as a hit, flagged from their `status`.
 *
 * The values compared here never leave this module: a candidate carries its EH
 * id and the NAMES of the keys that matched or disagreed, nothing else.
 */
import type { EhPayrollClient, EhResult } from "../eh/client.js";
import type { EhEmployee, EhEmployeePayload } from "../eh/types.js";

export type MatchKey = "email" | "tfn" | "nameDob";

/** One EH employee the Pre-create check found. */
export interface ExistingMatch {
  ehEmployeeId: number;
  terminated: boolean;
  /** Keys whose filter returned this employee, in check order. */
  matched: MatchKey[];
  /** Keys both sides hold that didn't match, in check order. */
  differs: MatchKey[];
  /** EH already holds a Payroll ID for them (ADR-0011: the client can copy it into Connecteam). */
  hasPayrollId?: true;
  /** Found by a Payroll ID copied into Connecteam, with no key agreeing (ADR-0011), not by the check. */
  byPayrollId?: true;
}

const KEY_ORDER: readonly MatchKey[] = ["email", "tfn", "nameDob"];

/**
 * ATO codes quoted in place of a TFN: not quoted, applied for, under 18,
 * pensioner, chose not to quote. Never a person's own number, so never a hit.
 */
export const ATO_PLACEHOLDER_TFNS: ReadonlySet<string> = new Set([
  "000000000",
  "111111111",
  "333333333",
  "444444444",
  "987654321",
]);

/** The three keys as plain values, normalised for comparison; a missing one is null. */
interface Keys {
  email: string | null;
  tfn: string | null;
  nameDob: { firstName: string; surname: string; dob: string } | null;
}

function trimmedText(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
}

function keysOf(record: Record<string, unknown>): Keys {
  const email = trimmedText(record.emailAddress).toLowerCase();
  const tfn = trimmedText(record.taxFileNumber).replace(/\D/g, "");
  const firstName = trimmedText(record.firstName).toLowerCase();
  const surname = trimmedText(record.surname).toLowerCase();
  // We send YYYY-MM-DD; EH returns YYYY-MM-DDT00:00:00.
  const dob = trimmedText(record.dateOfBirth).slice(0, 10);
  return {
    email: email || null,
    tfn: tfn && !ATO_PLACEHOLDER_TFNS.has(tfn) ? tfn : null,
    nameDob: firstName && surname && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? { firstName, surname, dob } : null,
  };
}

/** An OData string literal: single quotes doubled. */
function odataString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** The `$filter` for each key the payload holds, in check order. */
export function preCreateFilters(payload: EhEmployeePayload): Array<{ key: MatchKey; filter: string }> {
  const k = keysOf(payload);
  const out: Array<{ key: MatchKey; filter: string }> = [];
  if (k.email) out.push({ key: "email", filter: `emailAddress eq ${odataString(k.email)}` });
  if (k.tfn) out.push({ key: "tfn", filter: `taxFileNumber eq ${odataString(k.tfn)}` });
  if (k.nameDob) {
    // EH's `eq` ignores case on names, as on email: as-stored, lower- and
    // upper-cased names all found the same employee (rehearsal account, 2026-11-05).
    const first = trimmedText(payload.firstName);
    const last = trimmedText(payload.surname);
    out.push({
      key: "nameDob",
      filter: `firstName eq ${odataString(first)} and surname eq ${odataString(last)} and dateOfBirth eq datetime'${k.nameDob.dob}T00:00:00'`,
    });
  }
  return out;
}

/** Whether both sides agree on one key, or null when either side doesn't hold it. */
export function isTerminated(row: { status?: unknown }): boolean {
  return typeof row.status === "string" && row.status.toLowerCase() === "terminated";
}

function sameKey(key: MatchKey, ours: Keys, theirs: Keys): boolean | null {
  if (key === "nameDob") {
    const a = ours.nameDob;
    const b = theirs.nameDob;
    if (a === null || b === null) return null;
    return a.firstName === b.firstName && a.surname === b.surname && a.dob === b.dob;
  }
  const a = ours[key];
  const b = theirs[key];
  return a === null || b === null ? null : a === b;
}

/**
 * Which of the three keys this payload and an EH record agree or disagree on
 * (ADR-0011): a Payroll ID copied into Connecteam links someone only when at
 * least one agrees. A key either side lacks is in neither list.
 */
export function compareKeys(payload: EhEmployeePayload, record: Record<string, unknown>): { agree: MatchKey[]; differs: MatchKey[] } {
  const ours = keysOf(payload);
  const theirs = keysOf(record);
  return {
    agree: KEY_ORDER.filter((k) => sameKey(k, ours, theirs) === true),
    differs: KEY_ORDER.filter((k) => sameKey(k, ours, theirs) === false),
  };
}

/**
 * Every EH employee that could already be this person, or `[]` when the create
 * is clear. A failed lookup is returned as is, so the job retries (a 429 from
 * a burst of creates is retryable, like any other).
 */
export async function runPreCreateCheck(
  eh: Pick<EhPayrollClient, "findEmployees">,
  payload: EhEmployeePayload,
): Promise<EhResult<ExistingMatch[]>> {
  const found = new Map<number, { row: EhEmployee; matched: Set<MatchKey> }>();
  for (const { key, filter } of preCreateFilters(payload)) {
    const res = await eh.findEmployees(filter);
    if (res.outcome !== "ok") return res;
    for (const row of res.data) {
      const hit = found.get(row.id) ?? { row, matched: new Set<MatchKey>() };
      hit.matched.add(key);
      found.set(row.id, hit);
    }
  }

  const ours = keysOf(payload);
  const matches = [...found.values()].map(({ row, matched }): ExistingMatch => {
    const theirs = keysOf(row);
    return {
      ehEmployeeId: row.id,
      terminated: isTerminated(row),
      matched: KEY_ORDER.filter((k) => matched.has(k)),
      differs: KEY_ORDER.filter((k) => !matched.has(k) && sameKey(k, ours, theirs) === false),
      ...(trimmedText(row.externalId) ? { hasPayrollId: true as const } : {}),
    };
  });
  return { outcome: "ok", data: matches.sort((a, b) => a.ehEmployeeId - b.ehEmployeeId) };
}

const DETAIL_PREFIX = "existing_match: ";
const DETAIL_SEP = " | ";

/**
 * The `sync_log` detail for a Held employee: EH ids and key names only, e.g.
 * `existing_match: EH 40213 (email, nameDob; tfn differs) | EH 40377 terminated (tfn)`.
 */
export function existingMatchDetail(matches: readonly ExistingMatch[]): string {
  const parts = matches.map((m) => {
    const differs = m.differs.length ? `; ${m.differs.join(", ")} differs` : "";
    const matched = m.byPayrollId ? ["Payroll ID", ...m.matched] : m.matched;
    return `EH ${m.ehEmployeeId}${m.terminated ? " terminated" : ""} (${matched.join(", ")}${differs})`;
  });
  return `${DETAIL_PREFIX}${parts.join(DETAIL_SEP)}`;
}

/**
 * The EH ids an {@link existingMatchDetail} names, for the roster: the reverse
 * of the format above, kept beside it. Anything else gives `[]`.
 */
export function heldCandidateIds(detail: string | null): string[] {
  if (!detail?.startsWith(DETAIL_PREFIX)) return [];
  return detail
    .slice(DETAIL_PREFIX.length)
    .split(DETAIL_SEP)
    .flatMap((part) => /^EH (\d+)\b/.exec(part)?.[1] ?? []);
}
