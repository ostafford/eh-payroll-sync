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

export type Level = "required" | "recommended" | "admin" | "notSynced";

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
  | { status: "skipped" };

export interface CheckRow {
  group: Group | "Award";
  name: string;
  level: Level;
  /** The client's field it matched, if any. */
  field?: { id: number; name: string };
  result: CheckResult;
  /** A required field missing, of the wrong type, or not yet decided: the wizard can't continue. */
  blocking: boolean;
  /** Options the field should have (for the fix text). */
  options?: string[];
}

/** As docs/connecteam-field-checklist.md's key: only the award field is "admin". */
const levelOf = (spec: FieldSpec): Level =>
  spec.target.kind === "none" ? "notSynced" : requiredForSync(spec) ? "required" : "recommended";

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
  const rows: CheckRow[] = FIELD_SPEC.filter((s) => s.create).map((spec) => {
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
            : checkOne(spec, f, optionsOf(picks[spec.name]));
    return {
      group: spec.group,
      name: spec.name,
      level,
      ...(f ? { field: { id: f.id, name: String(f.name) } } : {}),
      result,
      // An unmapped option on a required field gets every employee who picks it a Correction (#112).
      blocking: level === "required" && ["missing", "wrongType", "ambiguous", "stalePick", "options"].includes(result.status),
      ...(spec.ct.options ? { options: spec.ct.options } : {}),
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

export function summarise(rows: CheckRow[]): { ok: number; blocking: number; warnings: number; skipped: number } {
  const ok = rows.filter((r) => r.result.status === "found").length;
  const skipped = rows.filter((r) => r.result.status === "skipped").length;
  const blocking = rows.filter((r) => r.blocking).length;
  return { ok, blocking, warnings: rows.length - ok - skipped - blocking, skipped };
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
        why: `"${r.field?.name}" is a ${typeName(res.got)} field; the sync needs a ${typeName(res.want)} field, so the value can't be converted.`,
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
        fix: `Map each option with npm run pick-fields (the wizard runs it before this check). Or in Connecteam, ${parts.join("; and ")}.`,
      };
    }
    case "ambiguous":
      return {
        why: `More than one of your fields could be it (${res.candidates.map((c) => `"${c.name}"`).join(", ")}), so the sync won't guess.`,
        fix: "Pick which one with npm run pick-fields (the wizard runs it before this check).",
      };
    case "stalePick":
      return {
        why: `The field picked for this earlier (id ${res.id}) no longer exists in Connecteam.`,
        fix: "Pick another with npm run pick-fields (the wizard runs it before this check).",
      };
    default:
      return { why: "", fix: "" };
  }
}

/** Connecteam's API type names, as its UI shows them. */
const typeName = (t: string): string =>
  ({ str: "text", dropdown: "dropdown", date: "date", birthday: "birthday", location: "location", directManager: "direct manager", number: "number" })[t] ?? t;

const LABEL: Record<CheckResult["status"], string> = {
  found: "found",
  missing: "missing",
  wrongType: "wrong type",
  options: "options don't match",
  userEditable: "editable by employees",
  ambiguous: "more than one match",
  stalePick: "picked field deleted",
  skipped: "skipped",
};
const LEVEL: Record<Level, string> = { required: "required", recommended: "recommended", admin: "admin-only", notSynced: "not synced" };

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

export function renderFieldCheck(rows: CheckRow[], opts: { color: boolean }): string {
  const c = (code: string, s: string) => (opts.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const quiet = (r: CheckRow) => r.result.status === "found" || r.result.status === "skipped";
  const mark = (r: CheckRow) =>
    r.result.status === "found"
      ? c("32", opts.color ? "✓" : "[ok]")
      : r.result.status === "skipped"
        ? c("2", opts.color ? "–" : "[-]")
        : r.blocking
        ? c("31", opts.color ? "✗" : "[x]")
        : c("33", opts.color ? "⚠" : "[!]");

  const lines: string[] = [];
  let group = "";
  for (const r of rows) {
    if (r.group !== group) {
      group = r.group;
      lines.push("", c("1", group));
    }
    const matched = r.field && r.field.name.trim() !== r.name ? c("2", ` (your field: "${r.field.name}")`) : "";
    const status =
      r.result.status === "found"
        ? ""
        : `  ${r.blocking ? c("31", LABEL[r.result.status]) : c(r.result.status === "skipped" ? "2" : "33", LABEL[r.result.status])}`;
    lines.push(`  ${mark(r)} ${r.name.padEnd(38)} ${c("2", LEVEL[r.level].padEnd(11))}${status}${matched}`);
    if (!quiet(r)) {
      const { why, fix } = explain(r);
      lines.push(...wrap(`Why: ${why}`, "        "), ...wrap(`Fix: ${fix}`, "        "));
    }
  }

  const s = summarise(rows);
  lines.push(
    "",
    `${c("32", `${s.ok} ok`)} · ${c(s.blocking ? "31" : "32", `${s.blocking} required missing or wrong`)} · ` +
      c(s.warnings ? "33" : "32", `${s.warnings} warning${s.warnings === 1 ? "" : "s"}`) +
      (s.skipped ? c("2", ` · ${s.skipped} skipped`) : ""),
  );
  return lines.map((l) => l.trimEnd()).join("\n");
}
