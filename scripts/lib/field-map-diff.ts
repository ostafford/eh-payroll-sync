/**
 * How discover writes its draft next to a field map that already exists, and
 * a readable diff between the two (issue #62).
 *
 * A tuned map holds settings discover never produces (pay-run defaults, the
 * award field, any hand edits), so it is only replaced when it belongs to
 * another account, or is the placeholder `npm install` copies in (#172).
 */
import { PLACEHOLDER_CLIENT } from "./validate-field-map.js";

export type FieldMapWrite =
  | { action: "write" }
  | { action: "draft" }
  | { action: "replace"; previous: { packId: unknown; businessId: unknown } };

const accountOf = (m: any) => ({
  packId: m?.connecteam?.onboardingPackId,
  businessId: m?.employmentHero?.businessId,
});

export function chooseFieldMapWrite(existing: unknown, draft: unknown): FieldMapWrite {
  if (existing === undefined) return { action: "write" };
  // The placeholder is nobody's tuning, even on the account it was built from (the demo one).
  if ((existing as { client?: unknown } | null)?.client === PLACEHOLDER_CLIENT) return { action: "write" };
  const was = accountOf(existing);
  const now = accountOf(draft);
  // Can't tell whose map it is - keep it rather than risk losing tuning.
  if (was.packId === undefined || was.businessId === undefined) return { action: "draft" };
  if (String(was.packId) === String(now.packId) && String(was.businessId) === String(now.businessId)) {
    return { action: "draft" };
  }
  return { action: "replace", previous: was };
}

/** Every Connecteam source the map points at, keyed by what it feeds. */
function sources(m: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of m?.fields ?? []) {
    const from = f?.from ?? {};
    if (from.customFieldId !== undefined) out.set(f.eh, `field ${from.customFieldId}`);
    else if (from.userField !== undefined) out.set(f.eh, `user field "${from.userField}"`);
  }
  for (const [key, v] of Object.entries<any>(m?.rules?.taxDeclaration ?? {})) {
    if (v?.customFieldId !== undefined) out.set(`taxDeclaration.${key}`, `field ${v.customFieldId}`);
  }
  for (const [key, v] of Object.entries<any>(m?.rules?.super ?? {})) {
    if (v !== "TODO" && v !== undefined) out.set(`super.${key}`, `field ${v}`);
  }
  return out;
}

export function diffFieldMaps(existing: unknown, draft: unknown): string[] {
  const mine = sources(existing);
  const theirs = sources(draft);

  let identical = 0;
  const changed: string[] = [];
  const mineOnly: string[] = [];
  const draftOnly: string[] = [];
  for (const [key, src] of mine) {
    const d = theirs.get(key);
    if (d === undefined) mineOnly.push(`- ${key}: only in your map (kept)`);
    else if (d === src) identical++;
    else changed.push(`~ ${key}: your map uses ${src}, the draft found ${d}`);
  }
  for (const [key, src] of theirs) {
    if (!mine.has(key)) draftOnly.push(`+ ${key}: only in the draft (${src})`);
  }

  return [`= ${identical} field${identical === 1 ? "" : "s"} identical`, ...changed, ...mineOnly, ...draftOnly];
}
