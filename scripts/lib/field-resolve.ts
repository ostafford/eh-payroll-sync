/**
 * Which of a client's Connecteam custom fields feeds each field the sync needs
 * (issue #112). Shared by field-check, create-fields and discover, so all three
 * agree on the field.
 */
import type { FieldSpec } from "./field-spec.js";

export interface FieldDef {
  id: number;
  name: string;
  type: string;
}

export type Resolution =
  | { status: "matched"; field: FieldDef; picked: boolean }
  | { status: "none" }
  /** More than one field could be it: a human picks (never the first by API order). */
  | { status: "ambiguous"; candidates: FieldDef[] }
  /** The picked field no longer exists (deleted): a human picks again. */
  | { status: "stalePick"; id: number }
  /** The human chose not to use this field (recommended and not-synced fields only). */
  | { status: "skipped" }
  /** Read from the Connecteam profile (FieldSpec `profile`), confirmed by the human. */
  | { status: "profile" };

/** Types that carry the same value shape (both arrive as "DD/MM/YYYY"). */
export const COMPATIBLE: Record<string, string[]> = { birthday: ["birthday", "date"], date: ["date", "birthday"] };

export const compatibleType = (spec: FieldSpec, type: string): boolean =>
  [...(COMPATIBLE[spec.ct.type] ?? [spec.ct.type]), ...(spec.ct.alsoAccepts ?? [])].includes(type);

/** A field the client has retired but not deleted, e.g. "Postcode (OLD)". */
const RETIRED = /\(old\)|\bold\b|deprecated/i;

/** Narrows to the fields `keep` accepts, unless that would leave none. */
const prefer = (fields: FieldDef[], keep: (f: FieldDef) => boolean): FieldDef[] => {
  const kept = fields.filter(keep);
  return kept.length ? kept : fields;
};

/**
 * One field's choice: a Connecteam field ID, not used at all, or to be made by
 * create-fields (which then saves the new field's ID in its place).
 */
export type FieldPick =
  | {
      id: number;
      options?: OptionMap;
      /** Answers that leave the employee out of the sync entirely (rules.exclude); each is also `null` in `options`. */
      exclude?: string[];
    }
  | { skip: true }
  | { create: true }
  | { profile: true };

/**
 * A dropdown's options, as the client named them, to what the sync sends (#112):
 * an EH value, "yes"/"no" for a tax question, or null for "not synced: the
 * employee gets a Correction message".
 */
export type OptionMap = Record<string, string | null>;

/** The options the sync sends on: "not synced" ones are left out, so the sync raises a Correction. */
export const syncedOptions = (options: OptionMap): Record<string, string> =>
  Object.fromEntries(Object.entries(options).filter((e): e is [string, string] => e[1] !== null));

/** A pick's option map, if it has one. */
export const optionsOf = (pick: FieldPick | undefined): OptionMap | undefined => (pick && "id" in pick ? pick.options : undefined);

/** The human's choices, by FieldSpec name (clients/<client>/field-picks.json). */
export type FieldPicks = Record<string, FieldPick>;

export function resolveField(spec: FieldSpec, fields: FieldDef[], picks: FieldPicks = {}): Resolution {
  const pick = picks[spec.name];
  if (pick && "skip" in pick) return { status: "skipped" };
  if (pick && "profile" in pick) return spec.profile ? { status: "profile" } : { status: "none" };
  // Not made yet: no name match stands in for it, so create-fields makes it.
  if (pick && "create" in pick) return { status: "none" };
  if (pick) {
    const field = fields.find((f) => f.id === pick.id);
    return field ? { status: "matched", field, picked: true } : { status: "stalePick", id: pick.id };
  }

  // A field picked for another of the sync's fields isn't a candidate here, so none feeds two.
  const taken = new Set(Object.entries(picks).flatMap(([name, p]) => (name !== spec.name && "id" in p ? [p.id] : [])));
  const named = fields.filter((f) => spec.match.test(f.name) && !taken.has(f.id));
  const typed = prefer(named, (f) => compatibleType(spec, f.type));
  const current = prefer(typed, (f) => !RETIRED.test(f.name));
  const [only, ...more] = current;
  if (!only) return { status: "none" };
  if (more.length) return { status: "ambiguous", candidates: current };
  return { status: "matched", field: only, picked: false };
}
