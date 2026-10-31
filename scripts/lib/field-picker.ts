/**
 * The wizard's field picker (issue #112): for each field the sync needs, what
 * the human can choose from, and how a choice is saved to field-picks.json.
 */
import { compatibleType, resolveField, type FieldDef, type FieldPick, type FieldPicks, type OptionMap } from "./field-resolve.js";
import { liveOptions, typeName } from "./field-check.js";
import { FIELD_SPEC, requiredForSync, type FieldSpec } from "./field-spec.js";

export type Choice = { kind: "use"; field: FieldDef } | { kind: "profile" } | { kind: "create" } | { kind: "skip" };

/** Only fields the sync can read are offered, so an unusable one can't be picked. */
export function pickerChoices(spec: FieldSpec, fields: FieldDef[]): Choice[] {
  const usable = fields.filter((f) => compatibleType(spec, f.type));
  const named = usable.filter((f) => spec.match.test(f.name));
  const others = usable.filter((f) => !named.includes(f));
  return [
    ...[...named, ...others].map((field) => ({ kind: "use" as const, field })),
    ...(spec.profile ? [{ kind: "profile" as const }] : []),
    ...(spec.create ? [{ kind: "create" as const }] : []),
    ...(requiredForSync(spec) ? [] : [{ kind: "skip" as const }]),
  ];
}

export function applyChoice(picks: FieldPicks, spec: FieldSpec, choice: Choice): FieldPicks {
  const pick: FieldPick =
    choice.kind === "use"
      ? { id: choice.field.id }
      : choice.kind === "skip"
        ? { skip: true }
        : choice.kind === "profile"
          ? { profile: true }
          : { create: true };
  return { ...picks, [spec.name]: pick };
}

export interface PickerIo {
  ask(prompt: string): Promise<string>;
  print(...lines: string[]): void;
  /** Colour the output (a terminal only): Employment Hero purple, Connecteam cyan, changes yellow. */
  color?: boolean;
}

/** Which side each name is on, told apart by colour as well as by the column headings. */
interface Palette {
  eh(s: string): string;
  ct(s: string): string;
  change(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

const palette = (on: boolean): Palette => {
  const c = (code: string) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { eh: c("35"), ct: c("36"), change: c("33"), dim: c("2"), bold: c("1") };
};

/**
 * Shows every automatic match for one confirmation, asks about each field that
 * needs a decision, and returns the picks to save. Fields already picked are
 * not asked again.
 */
export async function runFieldPicker(raw: any[], picks: FieldPicks, io: PickerIo): Promise<FieldPicks> {
  const fields: FieldDef[] = raw.map((x) => ({ id: x?.id, name: String(x?.name ?? ""), type: String(x?.type ?? "") }));
  const p = palette(io.color === true);
  let out = { ...picks };

  const auto: Array<{ spec: FieldSpec; field: FieldDef }> = [];
  const undecided: Array<{ spec: FieldSpec; why: string }> = [];
  for (const spec of FIELD_SPEC) {
    const r = resolveField(spec, fields, out);
    const pick = out[spec.name];
    if (r.status === "skipped" || r.status === "profile" || (pick && "create" in pick)) continue;
    if (r.status === "matched" && compatibleType(spec, r.field.type)) {
      if (!r.picked) auto.push({ spec, field: r.field });
    } else undecided.push({ spec, why: whyAsk(r, spec) });
  }

  // The table's rows never change, so a row's number always means the same field.
  const table = auto.map((a) => a.spec);
  const changed = new Set<FieldSpec>(); // decided from the table, not as matched
  const moved = new Set<FieldSpec>(); // its field went to another; asked below
  const settled = new Set<FieldSpec>(); // decided in this run

  const skipped = (spec: FieldSpec) => {
    const pick = out[spec.name];
    return !!pick && "skip" in pick;
  };
  /** Which of the sync's other fields each Connecteam field is used for: picked, or still in "use all". */
  const usedBy = (spec: FieldSpec): Map<number, FieldSpec> => {
    const m = new Map<number, FieldSpec>();
    for (const s of FIELD_SPEC) {
      const p = out[s.name];
      if (s !== spec && p && "id" in p) m.set(p.id, s);
    }
    for (const a of auto) if (a.spec !== spec) m.set(a.field.id, a.spec);
    return m;
  };

  // Asks about one field and saves the answer. The sync's super rule needs all
  // four super fields or none (#117), so skipping one is skipping super.
  const decide = async (spec: FieldSpec, why: string, suggested?: FieldDef): Promise<void> => {
    for (;;) {
      const used = usedBy(spec);
      const choice = await askOne(spec, why, fields, used, io, suggested);
      if (choice.kind === "profile" && spec.profile) {
        const ok = await io.ask(
          `The ATO needs the legal name. Are this client's profile ${spec.profile.plural} their legal names? [y/N] `,
        );
        if (ok.trim().toLowerCase() !== "y") continue;
      }
      if (choice.kind !== "skip" || spec.target.kind !== "super") {
        // A field in use elsewhere moves here; the field it came from is asked again, so none feeds two.
        const from = choice.kind === "use" ? used.get(choice.field.id) : undefined;
        if (from && choice.kind === "use") {
          const i = auto.findIndex((a) => a.spec === from);
          if (i !== -1) auto.splice(i, 1);
          else out = Object.fromEntries(Object.entries(out).filter(([name]) => name !== from.name));
          settled.delete(from);
          changed.delete(from);
          if (table.includes(from)) moved.add(from);
          undecided.push({ spec: from, why: `its field "${choice.field.name}" is now used for ${spec.name}` });
          io.print(`  ${p.ct(`"${choice.field.name}"`)} is now used for ${p.eh(spec.name)}; ${p.eh(from.name)} is asked about again below.`);
        }
        out = applyChoice(out, spec, choice);
        settled.add(spec);
        moved.delete(spec);
        return;
      }
      io.print("", "The sync needs all four super fields or none.");
      const all = (await io.ask("Skip super entirely? Super details are then entered in Employment Hero by hand. [y/N] ")).trim().toLowerCase();
      if (all === "y") {
        for (const s of FIELD_SPEC.filter((x) => x.target.kind === "super")) out = applyChoice(out, s, { kind: "skip" });
        return;
      }
    }
  };

  const fieldName = (id: number) => fields.find((f) => f.id === id)?.name ?? `field ${id}`;
  /** One table row: what the sync needs, and the client's field for it (or what happened to it). */
  const tableRow = (spec: FieldSpec, i: number): string => {
    const pending = auto.find((a) => a.spec === spec);
    const pick = out[spec.name];
    const yours = pending
      ? p.ct(`"${pending.field.name}"`)
      : moved.has(spec)
        ? `${p.dim("(asked below)".padEnd(30))}  ${p.change("← moved")}`
        : `${
            pick && "id" in pick
              ? p.ct(`"${fieldName(pick.id)}"`.padEnd(30))
              : pick && "profile" in pick && spec.profile
                ? p.ct(`profile "${spec.profile.label}"`.padEnd(30))
                : p.dim((pick && "skip" in pick ? "(skipped)" : "(new field to create)").padEnd(30))
          }  ${p.change("← changed")}`;
    return `  ${String(i + 1).padStart(2)}) ${p.eh(spec.name.padEnd(38))} ${yours}`;
  };

  // Every match is shown, so a wrong one is caught; one answer accepts the rest.
  // Rows stay put: a change shows in its row, never by dropping it.
  while (auto.length) {
    io.print("", "Matched automatically:");
    io.print(`      ${p.bold(p.eh("Employment Hero needs".padEnd(38)))} ${p.bold(p.ct("Your Connecteam field"))}`);
    io.print(`      ${p.dim("─".repeat(38))} ${p.dim("─".repeat(30))}`);
    table.forEach((spec, i) => io.print(tableRow(spec, i)));
    const prompt = changed.size
      ? `Use the ${auto.length} automatic matches? Your ${changed.size} change${changed.size === 1 ? " is" : "s are"} kept.`
      : `Use all ${auto.length} matches above?`;
    const answer = (await io.ask(`${prompt} [Y / n / number to change] `)).trim().toLowerCase();
    if (answer === "" || answer === "y") {
      for (const { spec, field } of auto) out = applyChoice(out, spec, { kind: "use", field });
      break;
    }
    if (answer === "n") {
      // Taken off the table as each is asked, so the rest still show as in use.
      while (auto.length) {
        const { spec, field } = auto.shift()!;
        if (!skipped(spec)) await decide(spec, `matched "${field.name}"`, field);
      }
      break;
    }
    const n = Number(answer);
    const spec = Number.isInteger(n) && n >= 1 ? table[n - 1] : undefined;
    if (!spec) {
      io.print(`  Type y, n, or a number from 1 to ${table.length}.`);
      continue;
    }
    const i = auto.findIndex((a) => a.spec === spec);
    const pending = i !== -1 ? auto.splice(i, 1)[0] : undefined;
    const pick = out[spec.name];
    const current = pending?.field ?? (pick && "id" in pick ? fields.find((f) => f.id === pick.id) : undefined);
    await decide(spec, current ? `matched "${current.name}"` : moved.has(spec) ? "its field was moved to another" : "you changed it", current);
    changed.add(spec);
    // Skipping super takes its other fields out of "use all".
    for (const a of [...auto]) if (skipped(a.spec)) {
      auto.splice(auto.indexOf(a), 1);
      changed.add(a.spec);
    }
  }

  for (const { spec, why } of undecided) if (!skipped(spec) && !settled.has(spec)) await decide(spec, why);

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

  const p = palette(io.color === true);
  io.print("", `${p.eh(spec.name)}: some of your Connecteam options aren't values Employment Hero takes. Choose what each one sends:`);
  values.forEach((v, i) => io.print(`  ${String(i + 1).padStart(2)}) ${p.eh(v.label)}`));
  io.print(`  ${String(values.length + 1).padStart(2)}) ${NOT_SYNCED}`);
  for (const o of todo) {
    for (;;) {
      const n = Number((await io.ask(`${p.eh(spec.name)}: ${p.ct(`"${o}"`)} -> `)).trim());
      if (Number.isInteger(n) && n >= 1 && n <= values.length + 1) {
        options[o] = n <= values.length ? values[n - 1]!.value : null;
        break;
      }
      io.print(`  Type a number from 1 to ${values.length + 1}.`);
    }
  }
  return options;
}

/**
 * Every field of a usable type is listed, so the right one is never hidden:
 * `suggested` (the automatic match) first, then free fields, then fields in use
 * elsewhere (`used`), labelled with what for. Fields of other types are counted.
 */
async function askOne(
  spec: FieldSpec,
  why: string,
  fields: FieldDef[],
  used: Map<number, FieldSpec>,
  io: PickerIo,
  suggested?: FieldDef,
): Promise<Choice> {
  const p = palette(io.color === true);
  const all = pickerChoices(spec, fields);
  const isSuggested = (c: Choice) => c.kind === "use" && c.field.id === suggested?.id;
  const inUse = (c: Choice) => c.kind === "use" && used.has(c.field.id);
  const choices = [
    ...all.filter(isSuggested),
    ...all.filter((c) => !isSuggested(c) && c.kind === "use" && !inUse(c)),
    ...all.filter((c) => !isSuggested(c) && inUse(c)),
    ...all.filter((c) => c.kind !== "use"),
  ];
  io.print("", `${p.eh(spec.name)} (${requiredForSync(spec) ? "required" : "optional"}): ${why}`);
  if (spec.about) io.print(`  ${spec.about}`);
  choices.forEach((c, i) => {
    const elsewhere = c.kind === "use" ? used.get(c.field.id) : undefined;
    io.print(`  ${String(i + 1).padStart(2)}) ${choiceLabel(spec, c, p)}${elsewhere ? ` - currently used for ${p.eh(elsewhere.name)}` : ""}`);
  });
  const hidden = fields.filter((f) => !compatibleType(spec, f.type));
  if (hidden.length) {
    const types = [...new Set(hidden.map((f) => typeName(f.type)))].join(", ");
    io.print(p.dim(`  ${hidden.length} other field${hidden.length === 1 ? " isn't" : "s aren't"} listed: ${types} fields can't hold this value.`));
  }
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

function choiceLabel(spec: FieldSpec, c: Choice, p: Palette): string {
  if (c.kind === "use") return `Use ${p.ct(`"${c.field.name}"`)} (${typeName(c.field.type)})`;
  if (c.kind === "profile" && spec.profile) {
    return `Use profile ${p.ct(`"${spec.profile.label}"`)} (Connecteam profile - may be a preferred name, not the legal one)`;
  }
  if (c.kind === "create") return `Create a new ${p.ct(`"${spec.name}"`)} field in Connecteam`;
  return "Skip: the sync won't use this field";
}
