/**
 * Writes the option mappings chosen in the field picker (#112) into a field
 * map discover kept, by field ID. discover keeps a tuned map rather than
 * replace it, and its diff doesn't compare option maps, so without this a
 * mapping made on a wizard re-run would never reach the sync.
 *
 * Only `map` (fields) and `options` (tax declaration) of an entry already
 * reading the picked field change; everything else in the map is left alone.
 */
import { optionsOf, syncedOptions, type FieldPicks } from "./field-resolve.js";
import { FIELD_SPEC } from "./field-spec.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function applyOptionMaps<T>(fieldMap: T, picks: FieldPicks): { map: T; changed: string[] } {
  const map: any = structuredClone(fieldMap);
  const changed: string[] = [];
  for (const spec of FIELD_SPEC) {
    const pick = picks[spec.name];
    const options = optionsOf(pick);
    if (!options || !pick || !("id" in pick)) continue;
    const want = syncedOptions(options);
    const t = spec.target;

    if (t.kind === "field") {
      const rule = (map.fields ?? []).find((r: any) => r?.eh === t.eh && r?.from?.customFieldId === pick.id);
      if (rule && !same(rule.map, want)) {
        rule.map = want;
        changed.push(spec.name);
      }
    } else if (t.kind === "taxDeclaration") {
      const source = map.rules?.taxDeclaration?.[t.key];
      if (source?.customFieldId === pick.id && !same(source.options, want)) {
        source.options = want;
        changed.push(spec.name);
      }
    }
  }
  return { map, changed };
}
