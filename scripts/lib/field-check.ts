/**
 * The wizard's field check (issue #63): compares a client's Connecteam custom
 * fields with every field the sync needs (./field-spec.ts, plus the award
 * dropdown) and explains each problem in plain language, with the fix.
 * Wording follows docs/connecteam-field-checklist.md ("Field check").
 *
 * Two results in that doc can't be checked here: "Not in the pack" (the API
 * doesn't say which fields a pack includes) and "No answers yet" (that would
 * mean reading employees' answers). The wizard reminds the human instead.
 */
import { AWARD_FIELD_NAME, findAwardField } from "./award-field.js";
import { compatibleType, optionsOf, resolveField, type FieldPicks, type OptionMap } from "./field-resolve.js";
import { FIELD_SPEC, requiredForSync, type FieldSpec, type Group } from "./field-spec.js";

/** "optional": only used if the client has it, never created (#118). */
export type Level = "required" | "recommended" | "optional" | "admin" | "notSynced";

export type CheckResult =
  | { status: "found" }
  | { status: "missing" }
  | { status: "wrongType"; got: string; want: string }
  | { status: "options"; unknown: string[]; absent: string[] }
  | { status: "userEditable" }
  /** More than one of the client's fields could be it: the human picks. */
  | { status: "ambiguous"; candidates: Array<{ id: number; name: string }> }
  /** The field picked earlier no longer exists. */
  | { status: "stalePick"; id: number }
  /** The human chose not to use it (never a required field). */
  | { status: "skipped" }
  /** Picked as "create": create-fields makes it (blocking until it exists, if required). */
  | { status: "toCreate" }
  /** A tax answer that doesn't say Yes or No ("TBC", "N/A") sent as one: a declaration the employee didn't make. */
  | { status: "taxGuess"; guesses: Array<{ option: string; sent: string }> };

export interface CheckRow {
  group: Group | "Award";
  name: string;
  level: Level;
  /** The client's field it matched, if any. */
  field?: { id: number; name: string };
  /** The field came from a saved pick, not a name match. */
  picked?: boolean;
  /** Read from this Connecteam profile field instead (e.g. "First name"). */
  profile?: string;
  result: CheckResult;
  /** A required field missing, of the wrong type, or not yet decided: the wizard can't continue. */
  blocking: boolean;
  /** Options the field should have (for the fix text). */
  options?: string[];
  /** Why a number field won't do (FieldSpec ct.numberNote). */
  numberNote?: string;
}

/** As docs/connecteam-field-checklist.md's key: only the award field is "admin". */
const levelOf = (spec: FieldSpec): Level =>
  spec.target.kind === "none" ? "notSynced" : requiredForSync(spec) ? "required" : spec.create ? "recommended" : "optional";

/** Skipped by the human, or an optional field the client doesn't have: nothing to fix. */
const notUsed = (r: CheckRow): boolean =>
  r.result.status === "skipped" || (r.level === "optional" && r.result.status === "missing");

/**
 * A tax answer sent as Yes or No though it doesn't start with that word ("TBC" or
 * "N/A" as No, "Yes, claim it" as No): EH records a declaration the employee didn't make.
 */
export const taxGuess = (option: string, sent: string): boolean =>
  (sent === "yes" || sent === "no") && !new RegExp(`^\\s*${sent}\\b`, "i").test(option);

export const liveOptions = (f: any): string[] =>
  (f?.dropdownOptions ?? []).filter((o: any) => !o.isDeleted).map((o: any) => String(o.value));

function checkOne(spec: FieldSpec, f: any, optionMap?: OptionMap): CheckResult {
  if (!f) return { status: "missing" };
  if (!compatibleType(spec, f.type)) return { status: "wrongType", got: f.type, want: spec.ct.type };
  if (spec.ct.options && optionMap) {
    // Every live option decided in the picker; a Yes/No question still needs both answers reachable.
    const have = liveOptions(f);
    const unknown = have.filter((o) => !(o in optionMap));
    const reached = have.map((o) => optionMap[o]?.toLowerCase());
    const absent = spec.ct.allOptionsRequired ? spec.ct.options.filter((o) => !reached.includes(o.toLowerCase())) : [];
    if (unknown.length || absent.length) return { status: "options", unknown, absent };
    if (spec.target.kind === "taxDeclaration") {
      const guesses = have.flatMap((option) => {
        const sent = optionMap[option];
        return sent && taxGuess(option, sent) ? [{ option, sent }] : [];
      });
      if (guesses.length) return { status: "taxGuess", guesses };
    }
  } else if (spec.ct.options) {
    // As the sync reads them: Yes/No answers in any case, mapped values exactly.
    const key = spec.target.kind === "taxDeclaration" ? (o: string) => o.trim().toLowerCase() : (o: string) => o;
    const want = spec.ct.options.map(key);
    const have = liveOptions(f);
    const unknown = have.filter((o) => !want.includes(key(o)));
    const absent = spec.ct.allOptionsRequired ? spec.ct.options.filter((o) => !have.map(key).includes(key(o))) : [];
    if (unknown.length || absent.length) return { status: "options", unknown, absent };
  }
  return { status: "found" };
}

/**
 * `raw`: `GET /users/v1/custom-fields` rows (id, name, type, dropdownOptions, isEditableForUsers).
 * `picks`: the human's choices (./field-picks.ts), read before any name match.
 */
export function checkFields(raw: any[], picks: FieldPicks = {}): CheckRow[] {
  const defs = raw.map((x) => ({ id: x?.id, name: String(x?.name ?? ""), type: String(x?.type ?? "") }));
  const rows: CheckRow[] = FIELD_SPEC.map((spec) => {
    const resolved = resolveField(spec, defs, picks);
    const f = resolved.status === "matched" ? raw.find((x) => x?.id === resolved.field.id) : undefined;
    const level = levelOf(spec);
    const result: CheckResult =
      resolved.status === "ambiguous"
        ? { status: "ambiguous", candidates: resolved.candidates.map(({ id, name }) => ({ id, name })) }
        : resolved.status === "stalePick"
          ? { status: "stalePick", id: resolved.id }
          : resolved.status === "skipped"
            ? { status: "skipped" }
            : resolved.status === "profile"
              ? { status: "found" }
              : resolved.status === "none" && picks[spec.name] && "create" in picks[spec.name]!
                ? { status: "toCreate" }
                : checkOne(spec, f, optionsOf(picks[spec.name]));
    return {
      group: spec.group,
      name: spec.name,
      level,
      ...(f ? { field: { id: f.id, name: String(f.name) } } : {}),
      ...(resolved.status === "matched" && resolved.picked ? { picked: true } : {}),
      result,
      // An unmapped option on a required field gets every employee who picks it a Correction (#112).
      blocking:
        level === "required" && ["missing", "wrongType", "ambiguous", "stalePick", "options", "toCreate"].includes(result.status),
      ...(spec.ct.options ? { options: spec.ct.options } : {}),
      ...(spec.ct.numberNote ? { numberNote: spec.ct.numberNote } : {}),
      ...(resolved.status === "profile" && spec.profile ? { profile: spec.profile.label } : {}),
    };
  });

  // The award dropdown: optional (a business may not pay under an award), but
  // it must stay admin-only.
  let award: any;
  let awardResult: CheckResult;
  try {
    award = findAwardField(raw);
    awardResult = !award ? { status: "missing" } : award.isEditableForUsers ? { status: "userEditable" } : { status: "found" };
  } catch {
    award = raw.find((x) => String(x?.name ?? "").trim().toLowerCase() === AWARD_FIELD_NAME.toLowerCase());
    awardResult = { status: "wrongType", got: award?.type, want: "dropdown" };
  }
  rows.push({
    group: "Award",
    name: AWARD_FIELD_NAME,
    level: "admin",
    ...(award ? { field: { id: award.id, name: String(award.name) } } : {}),
    result: awardResult,
    blocking: false,
  });
  return rows;
}

/** "blocking" counts what still needs deciding; a required field waiting on create-fields is in "toCreate". */
export function summarise(rows: CheckRow[]): { ok: number; blocking: number; warnings: number; skipped: number; toCreate: number } {
  const ok = rows.filter((r) => r.result.status === "found").length;
  const skipped = rows.filter(notUsed).length;
  const toCreate = rows.filter((r) => r.result.status === "toCreate").length;
  const blocking = rows.filter((r) => r.blocking && r.result.status !== "toCreate").length;
  return { ok, blocking, warnings: rows.length - ok - skipped - toCreate - blocking, skipped, toCreate };
}

// --- rendering -------------------------------------------------------------

const WIDTH = 100;

function explain(r: CheckRow): { why: string; fix: string } {
  const res = r.result;
  if (r.group === "Award") {
    if (res.status === "missing") {
      return {
        why: "Without it, award employees land in EH as Incomplete. Not needed if the business doesn't pay under an award.",
        fix: "Run the Award classifications stage (npm run provision-classification-field).",
      };
    }
    if (res.status === "userEditable") {
      return {
        why: "An employee could pick their own pay classification.",
        fix: `In Connecteam, set "${r.field?.name}" so employees can't edit it (admins only).`,
      };
    }
  }
  switch (res.status) {
    case "missing":
      return {
        why:
          r.level === "required"
            ? "The sync can't create the employee in EH without it: every employee gets a Correction message."
            : r.level === "notSynced"
              ? "Without it, a 3rd failed correction can't be copied to the employee's manager."
              : "The EH record will have a gap a payroll admin fills in by hand.",
        fix: "Create it with npm run create-fields (the wizard offers this next), then add it to the onboarding pack.",
      };
    case "wrongType":
      return {
        why:
          `"${r.field?.name}" is a ${typeName(res.got)} field; the sync needs a ${typeName(res.want)} field, so the value can't be converted.` +
          (res.got === "number" && r.numberNote ? ` ${r.numberNote}` : ""),
        fix:
          `Connecteam can't change a field's type. Create a new ${typeName(res.want)} field, add it to the pack, ` +
          `then delete or rename "${r.field?.name}" so it no longer matches.`,
      };
    case "options": {
      const parts: string[] = [];
      if (res.unknown.length) parts.push(`rename ${res.unknown.map((o) => `"${o}"`).join(", ")} to one of: ${r.options?.join(", ")}`);
      if (res.absent.length) parts.push(`add the option(s) ${res.absent.map((o) => `"${o}"`).join(", ")}`);
      return {
        why: "EH only accepts these exact values, so any other option gets the employee a Correction message.",
        fix: `Map each option in this check (npm run field-check, in a terminal). Or in Connecteam, ${parts.join("; and ")}.`,
      };
    }
    case "taxGuess": {
      const said = (sent: string) => res.guesses.filter((g) => g.sent === sent).map((g) => `"${g.option}"`);
      const parts = ["yes", "no"].flatMap((sent) => {
        const opts = said(sent);
        return opts.length ? [`${opts.join(" and ")} ${opts.length === 1 ? "is" : "are"} sent as "${sent === "yes" ? "Yes" : "No"}"`] : [];
      });
      return {
        why: `${parts.join("; ")}, so EH records a declaration the employee didn't make, and tax is withheld on it.`,
        fix: 'Change the row in this check (npm run field-check, in a terminal) and choose "Not synced", so the employee is asked instead.',
      };
    }
    case "ambiguous":
      return {
        why: `More than one of your fields could be it (${res.candidates.map((c) => `"${c.name}"`).join(", ")}), so the sync won't guess.`,
        fix: "Pick which one in this check (npm run field-check, in a terminal).",
      };
    case "stalePick":
      return {
        why: `The field picked for this earlier (id ${res.id}) no longer exists in Connecteam.`,
        fix: "Pick another in this check (npm run field-check, in a terminal).",
      };
    default:
      return { why: "", fix: "" };
  }
}

/** Connecteam's API type names, as its UI shows them. */
export const typeName = (t: string): string =>
  ({ str: "text", dropdown: "dropdown", date: "date", birthday: "birthday", location: "location", directManager: "direct manager", number: "number" })[t] ?? t;

function wrap(text: string, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && indent.length + line.length + 1 + word.length > WIDTH) {
      out.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out;
}

export interface RenderOptions {
  color: boolean;
  /** Number the fields that can be changed (the interactive check). */
  numbered?: boolean;
  /** Add Why / Fix lines under each problem (check-only). Default true. */
  explain?: boolean;
  /** Rows changed in this run, by name: marked "changed". */
  changed?: ReadonlySet<string>;
}

const EH_W = 37;
const CT_W = 28;

/**
 * The combined field check's table: what Employment Hero needs, the client's
 * Connecteam field for it, and a status, grouped by area. Employment Hero names
 * are purple, Connecteam fields cyan, changes yellow (when `color`).
 */
export function renderFieldCheck(rows: CheckRow[], opts: RenderOptions): string {
  const c = (code: string, s: string) => (opts.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const eh = (s: string) => c("35", s);
  const ct = (s: string) => c("36", s);
  const dim = (s: string) => c("2", s);
  const fit = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));

  const markOf = (r: CheckRow): string =>
    r.result.status === "found"
      ? c("32", opts.color ? "✓" : "[ok]")
      : notUsed(r)
        ? c("2", opts.color ? "–" : "[-]")
        : r.blocking && r.result.status !== "toCreate"
          ? c("31", opts.color ? "✗" : "[x]")
          : c("33", opts.color ? "⚠" : "[!]");
  const markW = opts.color ? 2 : 5;
  const numW = opts.numbered ? 6 : 2;

  const yours = (r: CheckRow): string => {
    const res = r.result;
    if (r.profile) return ct(fit(`profile "${r.profile}"`, CT_W));
    if (res.status === "skipped") return dim(fit("(skipped)", CT_W));
    if (res.status === "toCreate") return dim(fit("(new field to create)", CT_W));
    if (res.status === "ambiguous") return dim(fit(`(${res.candidates.length} fields match)`, CT_W));
    if (res.status === "stalePick") return dim(fit("(deleted)", CT_W));
    if (r.field) return ct(fit(`"${r.field.name}"`, CT_W));
    return dim(fit("(none found)", CT_W));
  };

  const statusOf = (r: CheckRow): string => {
    const res = r.result;
    if (opts.changed?.has(r.name) && ["found", "skipped", "toCreate"].includes(res.status)) return c("33", "changed");
    switch (res.status) {
      case "found":
        return r.profile ? "profile name" : r.picked ? "confirmed" : "matched by name";
      case "missing":
        return notUsed(r) ? dim("not used") : c(r.blocking ? "31" : "33", "missing");
      case "skipped":
        return dim("skipped");
      case "toCreate":
        return c("33", "to be created");
      case "wrongType":
        return c(r.blocking ? "31" : "33", `wrong type (${typeName(res.got)})`);
      case "options": {
        const text = res.unknown.length
          ? `${res.unknown.length} option${res.unknown.length === 1 ? "" : "s"} to map`
          : `no ${res.absent.map((o) => `"${o}"`).join("/")} option`;
        return c(r.blocking ? "31" : "33", text);
      }
      case "ambiguous":
        return c(r.blocking ? "31" : "33", "more than one match");
      case "stalePick":
        return c(r.blocking ? "31" : "33", "picked field deleted");
      case "userEditable":
        return c("33", "editable by employees");
      case "taxGuess":
        return c("33", `${res.guesses.length} answer${res.guesses.length === 1 ? "" : "s"} to check`);
    }
  };

  const indent = " ".repeat(numW + markW);
  const lines: string[] = [
    `${indent}${c("1", eh("Employment Hero needs".padEnd(EH_W)))} ${c("1", ct("Your Connecteam field".padEnd(CT_W)))} ${c("1", "Status")}`,
    `${indent}${dim("─".repeat(EH_W))} ${dim("─".repeat(CT_W))} ${dim("─".repeat(20))}`,
  ];
  let group = "";
  let n = 0;
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push("", c("1", group));
    }
    const num = opts.numbered && r.group !== "Award" ? `${String(++n).padStart(4)}) ` : " ".repeat(numW);
    const mark = `${markOf(r)}${" ".repeat(Math.max(1, markW - (opts.color ? 1 : 4)))}`;
    lines.push(`${num}${mark}${eh(r.name.padEnd(EH_W))} ${yours(r)} ${statusOf(r)}`);
    if (opts.explain !== false && r.result.status !== "found" && !notUsed(r) && r.result.status !== "toCreate") {
      const { why, fix } = explain(r);
      lines.push(...wrap(`Why: ${why}`, "        "), ...wrap(`Fix: ${fix}`, "        "));
    }
  }

  const s = summarise(rows);
  lines.push(
    "",
    `${c("32", `${s.ok} ok`)} · ${c(s.blocking ? "31" : "32", `${s.blocking} required to fix`)} · ` +
      c(s.warnings ? "33" : "32", `${s.warnings} to check`) +
      (s.toCreate ? c("33", ` · ${s.toCreate} to create`) : "") +
      (s.skipped ? c("2", ` · ${s.skipped} not used`) : ""),
  );
  return lines.map((l) => l.trimEnd()).join("\n");
}
