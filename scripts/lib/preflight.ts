/**
 * The existing-employee preflight: before a first deploy, predicts what the
 * first sync will do to each approved Connecteam person, given the employees
 * already in EH. Pure - the caller fetches both sides.
 *
 * Why: the sync matches EH by Connecteam ID (externalId) only. A person an
 * admin added to EH by hand has none, so the sync creates them, and EH itself
 * then matches on TFN (docs/eh-complete-criteria.md): one TFN match merges,
 * no match makes a new record. A TFN that differs from EH's therefore makes a
 * duplicate, and a TFN two EH records share lands on either one.
 *
 * EH does not merge on an ATO exemption code (eight demo employees share
 * 333333333 as separate records, 2026-10-29), so a person with one is matched
 * on name and email instead: a hand-made EH record for them means a duplicate.
 */

export interface PreflightPerson {
  ctUserId: number;
  name: string;
  email: string | null;
  /** Digits only, as the sync would send it; null when the person has none. */
  tfn: string | null;
}

export interface PreflightEhEmployee {
  id: number;
  name: string;
  email: string | null;
  tfn: string | null;
  externalId: string | null;
}

export type PreflightOutcome =
  | "linked"
  | "new"
  | "merge"
  | "no-tfn"
  | "likely-duplicate"
  | "taken"
  | "ambiguous";

export interface PreflightRow {
  person: PreflightPerson;
  outcome: PreflightOutcome;
  /** EH employee ids involved, for the admin to look up. */
  ehIds: number[];
}

/** ATO TFN exemption codes: many employees share one, and EH doesn't merge on them. */
const EXEMPTION_CODES = new Set(["000000000", "111111111", "333333333", "444444444", "987654321"]);

const BLOCKING: ReadonlySet<PreflightOutcome> = new Set(["likely-duplicate", "taken", "ambiguous"]);

export function isBlocking(outcome: PreflightOutcome): boolean {
  return BLOCKING.has(outcome);
}

function norm(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function classifyPerson(person: PreflightPerson, eh: readonly PreflightEhEmployee[]): PreflightRow {
  const linked = eh.filter((e) => e.externalId === String(person.ctUserId));
  if (linked.length > 0) return { person, outcome: "linked", ehIds: linked.map((e) => e.id) };

  if (!person.tfn) return { person, outcome: "no-tfn", ehIds: [] };

  const sameTfn = EXEMPTION_CODES.has(person.tfn) ? [] : eh.filter((e) => e.tfn === person.tfn);
  if (sameTfn.length > 1) return { person, outcome: "ambiguous", ehIds: sameTfn.map((e) => e.id) };
  if (sameTfn.length === 1) {
    const [match] = sameTfn as [PreflightEhEmployee];
    // EH would merge into a record the sync already links to someone else.
    if (match.externalId !== null && match.externalId !== "") return { person, outcome: "taken", ehIds: [match.id] };
    return { person, outcome: "merge", ehIds: [match.id] };
  }

  const lookalikes = eh.filter(
    (e) => (person.email && norm(e.email) === norm(person.email)) || norm(e.name) === norm(person.name),
  );
  if (lookalikes.length > 0) return { person, outcome: "likely-duplicate", ehIds: lookalikes.map((e) => e.id) };

  return { person, outcome: "new", ehIds: [] };
}

export function classifyAll(
  people: readonly PreflightPerson[],
  eh: readonly PreflightEhEmployee[],
): PreflightRow[] {
  return people.map((p) => classifyPerson(p, eh));
}

/** EH employees that already share a real TFN with another - fix before go-live. */
export function duplicateTfnGroups(eh: readonly PreflightEhEmployee[]): PreflightEhEmployee[][] {
  const byTfn = new Map<string, PreflightEhEmployee[]>();
  for (const e of eh) {
    if (!e.tfn || EXEMPTION_CODES.has(e.tfn)) continue;
    byTfn.set(e.tfn, [...(byTfn.get(e.tfn) ?? []), e]);
  }
  return [...byTfn.values()].filter((g) => g.length > 1);
}

/** EH employees that already share an email - usually one person entered twice. */
export function duplicateEmailGroups(eh: readonly PreflightEhEmployee[]): PreflightEhEmployee[][] {
  const byEmail = new Map<string, PreflightEhEmployee[]>();
  for (const e of eh) {
    const k = norm(e.email);
    if (!k) continue;
    byEmail.set(k, [...(byEmail.get(k) ?? []), e]);
  }
  return [...byEmail.values()].filter((g) => g.length > 1);
}

const LABEL: Record<PreflightOutcome, { mark: string; title: string; action: string }> = {
  linked: { mark: "✅", title: "Already linked", action: "None. EH already has their Connecteam ID; the sync updates that record." },
  new: { mark: "✅", title: "New to EH", action: "None. The sync creates them." },
  merge: { mark: "🔗", title: "Will merge", action: "None if the TFN is right. EH merges the sync into this existing record." },
  "no-tfn": { mark: "ℹ️ ", title: "No TFN in Connecteam", action: "None now. The sync won't write; they get a message asking for their TFN." },
  "likely-duplicate": {
    mark: "⚠️ ",
    title: "Likely duplicate",
    action:
      "Same name or email in EH, but EH won't match them by TFN (it differs, or is an exemption code). Delete the hand-made EH record, or ask the integrator to link it, or the sync makes a second record.",
  },
  taken: {
    mark: "⛔",
    title: "TFN belongs to someone else",
    action: "The EH record with this TFN is already linked to another Connecteam person. Fix the TFN, or untangle the two records in EH.",
  },
  ambiguous: {
    mark: "⛔",
    title: "TFN on more than one EH record",
    action: "EH could merge into either. Remove the duplicate in EH first.",
  },
};

const ORDER: PreflightOutcome[] = ["ambiguous", "taken", "likely-duplicate", "no-tfn", "merge", "new", "linked"];

export function renderPreflight(rows: readonly PreflightRow[], eh: readonly PreflightEhEmployee[]): string {
  const out: string[] = [];
  const dupes = duplicateTfnGroups(eh);
  const emailDupes = duplicateEmailGroups(eh);
  out.push(`Checked ${rows.length} approved Connecteam ${rows.length === 1 ? "person" : "people"} against ${eh.length} EH employees.`);
  out.push("");

  for (const outcome of ORDER) {
    const group = rows.filter((r) => r.outcome === outcome);
    if (group.length === 0) continue;
    const l = LABEL[outcome];
    out.push(`${l.mark} ${l.title} (${group.length})`);
    out.push(`   ${l.action}`);
    for (const r of group) {
      const ids = r.ehIds.length > 0 ? ` -> EH ${r.ehIds.join(", ")}` : "";
      out.push(`   - ${r.person.name} (Connecteam ${r.person.ctUserId})${ids}`);
    }
    out.push("");
  }

  if (dupes.length > 0) {
    out.push(`⛔ EH employees sharing a TFN (${dupes.length} group${dupes.length === 1 ? "" : "s"})`);
    out.push("   Remove the duplicate record in EH before go-live.");
    for (const g of dupes) out.push(`   - ${g.map((e) => `${e.name} (EH ${e.id})`).join(" / ")}`);
    out.push("");
  }

  if (emailDupes.length > 0) {
    out.push(`⚠️  EH employees sharing an email (${emailDupes.length} group${emailDupes.length === 1 ? "" : "s"})`);
    out.push("   Usually one person entered twice. Remove the extra record in EH before go-live.");
    for (const g of emailDupes) out.push(`   - ${g.map((e) => `${e.name} (EH ${e.id})`).join(" / ")}`);
    out.push("");
  }

  const blocking = rows.filter((r) => isBlocking(r.outcome)).length + dupes.length + emailDupes.length;
  out.push(
    blocking === 0
      ? "✓ Nothing to fix. Safe to deploy."
      : `✗ ${blocking} thing${blocking === 1 ? "" : "s"} to fix before deploying. Re-run this check after fixing.`,
  );
  return out.join("\n");
}

export function hasBlocking(rows: readonly PreflightRow[], eh: readonly PreflightEhEmployee[]): boolean {
  return rows.some((r) => isBlocking(r.outcome)) || duplicateTfnGroups(eh).length > 0 || duplicateEmailGroups(eh).length > 0;
}
