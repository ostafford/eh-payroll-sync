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
  | { status: "stalePick"; id: number };

/** Types that carry the same value shape (both arrive as "DD/MM/YYYY"). */
export const COMPATIBLE: Record<string, string[]> = { birthday: ["birthday", "date"], date: ["date", "birthday"] };

export const compatibleType = (spec: FieldSpec, type: string): boolean =>
  (COMPATIBLE[spec.ct.type] ?? [spec.ct.type]).includes(type);

/** A field the client has retired but not deleted, e.g. "Postcode (OLD)". */
const RETIRED = /\(old\)|\bold\b|deprecated/i;

/** Narrows to the fields `keep` accepts, unless that would leave none. */
const prefer = (fields: FieldDef[], keep: (f: FieldDef) => boolean): FieldDef[] => {
  const kept = fields.filter(keep);
  return kept.length ? kept : fields;
};

/** The human's choices, by FieldSpec name (clients/<client>/field-picks.json). */
export type FieldPicks = Record<string, { id: number }>;

export function resolveField(spec: FieldSpec, fields: FieldDef[], picks: FieldPicks = {}): Resolution {
  const pick = picks[spec.name];
  if (pick) {
    const field = fields.find((f) => f.id === pick.id);
    return field ? { status: "matched", field, picked: true } : { status: "stalePick", id: pick.id };
  }

  const named = fields.filter((f) => spec.match.test(f.name));
  const typed = prefer(named, (f) => compatibleType(spec, f.type));
  const current = prefer(typed, (f) => !RETIRED.test(f.name));
  const [only, ...more] = current;
  if (!only) return { status: "none" };
  if (more.length) return { status: "ambiguous", candidates: current };
  return { status: "matched", field: only, picked: false };
}
