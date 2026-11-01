/**
 * The wizard's field picker (issue #112): for each field the sync needs, what
 * the human can choose from, and how a choice is saved to field-picks.json.
 */
import { compatibleType, resolveField, type FieldDef, type FieldPick, type FieldPicks, type OptionMap } from "./field-resolve.js";
import { checkFields, liveOptions, renderFieldCheck, taxGuess, typeName, type CheckRow } from "./field-check.js";
import { FIELD_SPEC, requiredForSync, type FieldSpec } from "./field-spec.js";
import { answerLine } from "../../src/sync/messages.js";

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

/** Not a problem to fix: found, decided (skipped / to be created), or optional and absent. */
const settledRow = (r: CheckRow) =>
  r.group === "Award" ||
  ["found", "skipped", "toCreate"].includes(r.result.status) ||
  (r.level === "optional" && r.result.status === "missing");

/**
 * The combined field check (#112): shows every field the sync needs with the
 * client's Connecteam field and a status, then lets the human fix the problems
 * one by one or change any row by number, redrawing after each. Finishing saves
 * every name match by ID along with the changes, so a re-run asks nothing.
 */
export async function reviewFields(raw: any[], picks: FieldPicks, io: PickerIo): Promise<FieldPicks> {
  const fields: FieldDef[] = raw.map((x) => ({ id: x?.id, name: String(x?.name ?? ""), type: String(x?.type ?? "") }));
  const p = palette(io.color === true);
  let out = { ...picks };
  const changed = new Set<string>();

  /** Which of the sync's other fields each Connecteam field is used for, picked or matched by name. */
  const usedBy = (spec: FieldSpec): Map<number, FieldSpec> => {
    const m = new Map<number, FieldSpec>();
    for (const s of FIELD_SPEC) {
      if (s === spec) continue;
      const r = resolveField(s, fields, out);
      if (r.status === "matched") m.set(r.field.id, s);
    }
    return m;
  };

  // Asks which field to use and saves the answer. The sync's super rule needs
  // all four super fields or none (#117), so skipping one is skipping super.
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
        // A field in use elsewhere moves here. Where it came from then shows as a problem
        // (a field picked for one is never a name match for another), so none feeds two.
        const from = choice.kind === "use" ? used.get(choice.field.id) : undefined;
        if (from && choice.kind === "use") {
          out = Object.fromEntries(Object.entries(out).filter(([name]) => name !== from.name));
          changed.delete(from.name);
          io.print(`  ${p.ct(`"${choice.field.name}"`)} is now used for ${p.eh(spec.name)}; ${p.eh(from.name)} needs another field.`);
        }
        out = applyChoice(out, spec, choice);
        changed.add(spec.name);
        return;
      }
      io.print("", "The sync needs all four super fields or none.");
      const all = (await io.ask("Skip super entirely? Super details are then entered in Employment Hero by hand. [y/N] ")).trim().toLowerCase();
      if (all === "y") {
        for (const s of FIELD_SPEC.filter((x) => x.target.kind === "super")) {
          out = applyChoice(out, s, { kind: "skip" });
          changed.add(s.name);
        }
        return;
      }
    }
  };

  /** A dropdown's options EH doesn't take, or `reask`: ask what each one sends. */
  const fixOptions = async (spec: FieldSpec, reask: string[] = []): Promise<void> => {
    if (!spec.ct.options) return;
    const r = resolveField(spec, fields, out);
    if (r.status !== "matched") return;
    const pick = out[spec.name];
    const same = pick && "id" in pick && pick.id === r.field.id ? pick : undefined;
    const known = Object.fromEntries(Object.entries(same?.options ?? {}).filter(([o]) => !reask.includes(o)));
    const leftOut = (same?.exclude ?? []).filter((o) => !reask.includes(o));
    const mapped = await mapOptions(spec, r.field.name, liveOptions(raw.find((x) => x?.id === r.field.id)), known, leftOut, io);
    if (mapped) {
      out = { ...out, [spec.name]: { id: r.field.id, options: mapped.options, ...(mapped.exclude.length ? { exclude: mapped.exclude } : {}) } };
      changed.add(spec.name);
    }
  };

  /** Fixes one row: options to map are asked about directly; anything else (or a change) picks a field first. */
  const fix = async (spec: FieldSpec, change: boolean): Promise<void> => {
    const r = resolveField(spec, fields, out);
    const row = checkFields(raw, out).find((x) => x.name === spec.name)!;
    if (!change && row.result.status === "options") return fixOptions(spec);
    if (!change && row.result.status === "taxGuess") return fixOptions(spec, row.result.guesses.map((g) => g.option));
    const current = r.status === "matched" ? r.field : undefined;
    await decide(spec, current && change ? `matched "${current.name}"` : whyAsk(r, spec), current);
    await fixOptions(spec);
  };

  for (;;) {
    const rows = checkFields(raw, out);
    io.print("", ...renderFieldCheck(rows, { color: io.color === true, numbered: true, explain: false, changed }).split("\n"));
    const problems = FIELD_SPEC.filter((s) => !settledRow(rows.find((r) => r.name === s.name)!));
    const prompt = problems.length
      ? `Fix the ${problems.length} problem${problems.length === 1 ? "" : "s"} now? [Y / number to change a row / done] `
      : "Everything's in place. Press Enter to finish, or type a number to change a row. ";
    const answer = (await io.ask(prompt)).trim().toLowerCase();

    if (answer === "done" || (!problems.length && (answer === "" || answer === "y"))) break;
    if (answer === "" || answer === "y") {
      for (const spec of problems) {
        // An earlier answer (a move, skipping super) may have settled or changed it.
        if (!settledRow(checkFields(raw, out).find((r) => r.name === spec.name)!)) await fix(spec, false);
      }
      continue;
    }
    const n = Number(answer);
    const spec = Number.isInteger(n) && n >= 1 ? FIELD_SPEC[n - 1] : undefined;
    if (spec) await fix(spec, true);
    else io.print(`  Type ${problems.length ? "y, " : ""}done, or a number from 1 to ${FIELD_SPEC.length}.`);
  }

  // Finishing confirms what's shown: every name match is saved by ID, so a re-run asks nothing.
  for (const spec of FIELD_SPEC) {
    const r = resolveField(spec, fields, out);
    if (r.status === "matched" && !r.picked) out = applyChoice(out, spec, { kind: "use", field: r.field });
  }
  return out;
}

const NOT_SYNCED = "Not synced: the employee gets a Correction message";
const LEAVE_OUT = "Leave these employees out (no EH record, no message)";

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
/**
 * Asks about each live option not yet decided: an EH value, "Not synced" (the
 * employee is asked to change it, and shown here what they'll be sent), or, for
 * a field that allows it, leaving those employees out of the sync. Returns the
 * full map to save, or undefined when nothing needed asking.
 */
async function mapOptions(
  spec: FieldSpec,
  question: string,
  live: string[],
  known: OptionMap,
  leftOut: string[],
  io: PickerIo,
): Promise<{ options: OptionMap; exclude: string[] } | undefined> {
  const todo = live.filter((o) => !(o in known) && autoOption(spec, o) === undefined);
  if (!todo.length) return undefined;

  const values = ehValues(spec);
  const options: OptionMap = { ...known };
  const exclude = [...leftOut];
  for (const o of live) if (!(o in options) && !todo.includes(o)) options[o] = autoOption(spec, o)!;
  const notSynced = values.length + 1;
  const leaveOut = spec.ct.canLeaveOut ? values.length + 2 : undefined;
  const last = leaveOut ?? notSynced;

  const p = palette(io.color === true);
  io.print("", `${p.eh(spec.name)}: some of your Connecteam options aren't values Employment Hero takes. Choose what each one sends:`);
  values.forEach((v, i) => io.print(`  ${String(i + 1).padStart(2)}) ${p.eh(v.label)}`));
  io.print(`  ${String(notSynced).padStart(2)}) ${NOT_SYNCED}`);
  if (leaveOut) io.print(`  ${String(leaveOut).padStart(2)}) ${LEAVE_OUT}`);
  for (const o of todo) {
    for (;;) {
      const n = Number((await io.ask(`${p.eh(spec.name)}: ${p.ct(`"${o}"`)} -> `)).trim());
      if (!Number.isInteger(n) || n < 1 || n > last) {
        io.print(`  Type a number from 1 to ${last}.`);
        continue;
      }
      if (n === leaveOut) {
        options[o] = null;
        if (!exclude.includes(o)) exclude.push(o);
        io.print(`  Employees who answer ${p.ct(`"${o}"`)} won't be synced or messaged; the status digest counts them.`);
        break;
      }
      const sent = n <= values.length ? values[n - 1]!.value : null;
      if (sent === null) {
        // Show exactly what those employees will be sent, from the sync's own wording.
        const line = answerLine({ question, value: o, kind: spec.target.kind === "taxDeclaration" ? "yesNo" : "option" });
        io.print(`  Employees who answer ${p.ct(`"${o}"`)} won't be synced. They'll be sent:`, `    "${line}"`, "  and their record waits until they change it.");
        if ((await io.ask(`Keep "Not synced" for "${o}"? [Y/n] `)).trim().toLowerCase() === "n") continue;
      }
      // A tax answer that doesn't say Yes or No, sent as one, is a declaration the employee didn't make.
      if (spec.target.kind === "taxDeclaration" && sent && taxGuess(o, sent)) {
        const as = sent === "yes" ? "Yes" : "No";
        io.print(
          `  ${p.change(`"${o}" doesn't say Yes or No.`)} Sending it as ${as} tells Employment Hero the employee declared ${as},` +
            ` and tax is withheld on that. "Not synced" asks them instead.`,
        );
        if ((await io.ask(`Send "${o}" as ${as} anyway? [y/N] `)).trim().toLowerCase() !== "y") continue;
      }
      options[o] = sent;
      const i = exclude.indexOf(o);
      if (i !== -1) exclude.splice(i, 1);
      break;
    }
  }
  return { options, exclude };
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
