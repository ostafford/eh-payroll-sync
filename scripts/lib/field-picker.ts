/**
 * The wizard's field picker (issue #112): for each field the sync needs, what
 * the human can choose from, and how a choice is saved to field-picks.json.
 */
import { compatibleType, resolveField, type FieldDef, type FieldPick, type FieldPicks, type OptionMap } from "./field-resolve.js";
import { liveOptions } from "./field-check.js";
import { FIELD_SPEC, requiredForSync, type FieldSpec } from "./field-spec.js";

export type Choice = { kind: "use"; field: FieldDef } | { kind: "create" } | { kind: "skip" };

/** Only fields the sync can read are offered, so an unusable one can't be picked. */
export function pickerChoices(spec: FieldSpec, fields: FieldDef[]): Choice[] {
  const usable = fields.filter((f) => compatibleType(spec, f.type));
  const named = usable.filter((f) => spec.match.test(f.name));
  const others = usable.filter((f) => !named.includes(f));
  return [
    ...[...named, ...others].map((field) => ({ kind: "use" as const, field })),
    ...(spec.create ? [{ kind: "create" as const }] : []),
    ...(requiredForSync(spec) ? [] : [{ kind: "skip" as const }]),
  ];
}

export function applyChoice(picks: FieldPicks, spec: FieldSpec, choice: Choice): FieldPicks {
  const pick: FieldPick = choice.kind === "use" ? { id: choice.field.id } : choice.kind === "skip" ? { skip: true } : { create: true };
  return { ...picks, [spec.name]: pick };
}

export interface PickerIo {
  ask(prompt: string): Promise<string>;
  print(...lines: string[]): void;
}

/**
 * Shows every automatic match for one confirmation, asks about each field that
 * needs a decision, and returns the picks to save. Fields already picked are
 * not asked again.
 */
export async function runFieldPicker(raw: any[], picks: FieldPicks, io: PickerIo): Promise<FieldPicks> {
  const fields: FieldDef[] = raw.map((x) => ({ id: x?.id, name: String(x?.name ?? ""), type: String(x?.type ?? "") }));
  let out = { ...picks };

  const auto: Array<{ spec: FieldSpec; field: FieldDef }> = [];
  const undecided: Array<{ spec: FieldSpec; why: string }> = [];
  for (const spec of FIELD_SPEC.filter((s) => s.create)) {
    const r = resolveField(spec, fields, out);
    const pick = out[spec.name];
    if (r.status === "skipped" || (pick && "create" in pick)) continue;
    if (r.status === "matched" && compatibleType(spec, r.field.type)) {
      if (!r.picked) auto.push({ spec, field: r.field });
    } else undecided.push({ spec, why: whyAsk(r, spec) });
  }

  // Every match is shown, so a wrong one is caught; one answer accepts them all.
  while (auto.length) {
    io.print("", "Matched automatically:");
    auto.forEach(({ spec, field }, i) => io.print(`  ${String(i + 1).padStart(2)}) ${spec.name.padEnd(38)} -> "${field.name}"`));
    const answer = (await io.ask(`Use all ${auto.length} matches above? [Y / n / number to change] `)).trim().toLowerCase();
    if (answer === "" || answer === "y") {
      for (const { spec, field } of auto) out = applyChoice(out, spec, { kind: "use", field });
      break;
    }
    if (answer === "n") {
      for (const { spec, field } of auto) out = applyChoice(out, spec, await askOne(spec, `matched "${field.name}"`, fields, io, field));
      break;
    }
    const n = Number(answer);
    const one = Number.isInteger(n) ? auto[n - 1] : undefined;
    if (!one) {
      io.print(`  Type y, n, or a number from 1 to ${auto.length}.`);
      continue;
    }
    out = applyChoice(out, one.spec, await askOne(one.spec, `matched "${one.field.name}"`, fields, io, one.field));
    auto.splice(n - 1, 1);
  }

  for (const { spec, why } of undecided) out = applyChoice(out, spec, await askOne(spec, why, fields, io));

  // Then each picked dropdown whose options aren't all values EH takes.
  for (const spec of FIELD_SPEC.filter((s) => s.create && s.ct.options)) {
    const pick = out[spec.name];
    if (!pick || !("id" in pick)) continue;
    const options = await mapOptions(spec, liveOptions(raw.find((x) => x?.id === pick.id)), pick.options ?? {}, io);
    if (options) out = { ...out, [spec.name]: { id: pick.id, options } };
  }
  return out;
}

const NOT_SYNCED = "Not synced: the employee gets a Correction message";

/** What the sync can send for this field: EH's values, or Yes/No for a tax question. */
function ehValues(spec: FieldSpec): Array<{ value: string; label: string }> {
  const t = spec.target;
  if (t.kind === "taxDeclaration") return [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];
  const values = t.kind === "field" && t.map ? [...new Set(Object.values(t.map))] : (spec.ct.options ?? []);
  // EH stores only Male / Female and leaves any other gender blank (docs/field-mapping.md).
  return values.map((value) => ({ value, label: value === "Indeterminate" ? "Indeterminate (EH leaves it blank)" : value }));
}

/** An option that already is one of EH's values (or the demo's own wording) needs no question. */
function autoOption(spec: FieldSpec, option: string): string | undefined {
  const t = spec.target;
  if (t.kind === "taxDeclaration") return ["yes", "no"].find((v) => v === option.trim().toLowerCase());
  if (t.kind === "field" && t.map) return t.map[option];
  return spec.ct.options?.includes(option) ? option : undefined;
}

/**
 * Asks about each live option not yet decided. Returns the full option map to
 * save, or undefined when nothing needed asking (the default mapping holds).
 */
async function mapOptions(spec: FieldSpec, live: string[], known: OptionMap, io: PickerIo): Promise<OptionMap | undefined> {
  const todo = live.filter((o) => !(o in known) && autoOption(spec, o) === undefined);
  if (!todo.length) return undefined;

  const values = ehValues(spec);
  const options: OptionMap = { ...known };
  for (const o of live) if (!(o in options) && !todo.includes(o)) options[o] = autoOption(spec, o)!;

  io.print("", `${spec.name}: some of your options aren't values Employment Hero takes. Choose what each one sends:`);
  values.forEach((v, i) => io.print(`  ${String(i + 1).padStart(2)}) ${v.label}`));
  io.print(`  ${String(values.length + 1).padStart(2)}) ${NOT_SYNCED}`);
  for (const o of todo) {
    for (;;) {
      const n = Number((await io.ask(`${spec.name}: "${o}" -> `)).trim());
      if (Number.isInteger(n) && n >= 1 && n <= values.length + 1) {
        options[o] = n <= values.length ? values[n - 1]!.value : null;
        break;
      }
      io.print(`  Type a number from 1 to ${values.length + 1}.`);
    }
  }
  return options;
}

/** `suggested` (the automatic match) is listed first. */
async function askOne(spec: FieldSpec, why: string, fields: FieldDef[], io: PickerIo, suggested?: FieldDef): Promise<Choice> {
  const all = pickerChoices(spec, fields);
  const isSuggested = (c: Choice) => c.kind === "use" && c.field.id === suggested?.id;
  const choices = [...all.filter(isSuggested), ...all.filter((c) => !isSuggested(c))];
  io.print("", `${spec.name} (${requiredForSync(spec) ? "required" : "optional"}): ${why}`);
  choices.forEach((c, i) => io.print(`  ${String(i + 1).padStart(2)}) ${choiceLabel(spec, c)}`));
  for (;;) {
    const n = Number((await io.ask(`Pick 1-${choices.length} for ${spec.name}: `)).trim());
    const choice = Number.isInteger(n) ? choices[n - 1] : undefined;
    if (choice) return choice;
    io.print(`  Type a number from 1 to ${choices.length}.`);
  }
}

function whyAsk(r: ReturnType<typeof resolveField>, spec: FieldSpec): string {
  switch (r.status) {
    case "ambiguous":
      return `more than one of your fields could be it (${r.candidates.map((c) => `"${c.name}"`).join(", ")})`;
    case "stalePick":
      return `the field picked earlier (id ${r.id}) was deleted`;
    case "matched":
      return `"${r.field.name}" is a ${r.field.type} field; the sync needs ${spec.ct.type}`;
    default:
      return "no field found under a name the check recognises";
  }
}

function choiceLabel(spec: FieldSpec, c: Choice): string {
  if (c.kind === "use") return `Use "${c.field.name}" (${c.field.type})`;
  if (c.kind === "create") return `Create a new "${spec.name}" field`;
  return "Skip: the sync won't use this field";
}
