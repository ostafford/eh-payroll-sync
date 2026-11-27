/**
 * PROTOTYPE - throwaway, never merged to main (#222, map #214).
 *
 * Question: what does the link stage's confirm screen look like now that a
 * confirmed pair can carry two extra choices?
 *   - "Link and replace External ID" (#217), confirmed naming both values;
 *   - per-detail Keep EH's (pre-selected) / Use Connecteam's, names only (#220).
 *
 * Round 2 (the developer's feedback): every choice opens in a bordered pop-up,
 * one option per line, with the screen behind it dimmed; the key legend sits
 * in its own box; fields are named Connecteam field → EH field; IDs are always
 * "EH External ID" / "Connecteam User ID".
 *
 * The three variants differ only in WHEN and WHERE the choices are made:
 *   A  As you go: on today's list, the selected person's panel shows two short
 *      lines (EH External ID, Details); r or d opens the pop-up.
 *   B  After c, one person at a time: c lists who needs a choice, then one
 *      screen per person; Enter on a line opens its pop-up.
 *   C  After c, everyone in one table: a row per person, a column per field;
 *      Space flips a detail cell, a flips the whole column, Space on an
 *      External ID cell opens its pop-up.
 *
 *   npm run prototype:link-confirm -- --variant B
 *   NO_COLOR=1 npm run prototype:link-confirm -- --variant C
 *
 * v switches variant (same data, choices kept). q quits. All FAKE data: no API
 * call, nothing written. Not in a terminal, it prints sample screens.
 */
import { emitKeypressEvents } from "node:readline";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};
const color = !process.env.NO_COLOR && process.stdout.isTTY === true;
const c = (code: string) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
const p = { eh: c("35"), ct: c("36"), change: c("33"), dim: c("2"), bold: c("1"), ok: c("32"), bad: c("31"), inv: c("7") };
const mark = { ok: p.ok(color ? "✓" : "[ok]"), warn: p.change(color ? "⚠" : "[!]"), bad: p.bad(color ? "✗" : "[x]"), none: p.dim(color ? "–" : "[-]") };
const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");
const vis = (s: string) => strip(s).length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));
const ptr = (on: boolean) => (on ? (color ? p.ct("▶") : ">") : " ");
const radio = (on: boolean) => (on ? (color ? p.ct("●") : "(x)") : color ? p.dim("○") : "( )");
const COLS = () => Math.min(120, process.stdout.columns || 110);

// ── boxes ───────────────────────────────────────────────────────────────────
const B = color ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" } : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", ml: "+", mr: "+" };
/** A bordered box: a title, body lines, and an optional footer under a rule. "---" in the body draws a rule. */
function box(title: string, body: string[], footer: string[] = [], minW = 0): string[] {
  const inner = Math.max(minW, vis(title) + 4, ...[...body, ...footer].map((l) => vis(l) + 4));
  const row = (l: string) => `${B.v}  ${pad(l, inner - 4)}  ${B.v}`;
  const rule = `${B.ml}${B.h.repeat(inner)}${B.mr}`;
  const t = title ? ` ${p.bold(title)} ` : "";
  return [
    `${B.tl}${B.h}${t}${B.h.repeat(Math.max(0, inner - 1 - vis(t)))}${B.tr}`,
    ...body.map((l) => (l === "---" ? rule : row(l))),
    ...(footer.length ? [rule, ...footer.map(row)] : []),
    `${B.bl}${B.h.repeat(inner)}${B.br}`,
  ];
}
/** The key legend, boxed, wrapped to the terminal. */
function legend(ks: [string, string][]): string[] {
  const items = ks.map(([k, w]) => `${p.bold(k)} ${p.dim(w)}`);
  const lines: string[] = [];
  let cur = "";
  for (const it of items) {
    if (cur && vis(cur) + 5 + vis(it) > COLS() - 12) {
      lines.push(cur);
      cur = it;
    } else cur = cur ? `${cur}     ${it}` : it;
  }
  if (cur) lines.push(cur);
  return box("Keys", lines, [], COLS() - 8).map((l) => `  ${l}`);
}
/** Lays a pop-up over the screen, centred, with everything behind it dimmed. */
function overlay(screen: string[], pop: string[]): string[] {
  const out = screen.map((l) => p.dim(strip(l)));
  const top = Math.max(2, Math.floor((out.length - pop.length) / 2));
  while (out.length < top + pop.length) out.push("");
  const left = " ".repeat(Math.max(2, Math.floor((COLS() - vis(pop[0]!)) / 2)));
  pop.forEach((l, k) => (out[top + k] = left + l));
  return out;
}

// ── fake data ───────────────────────────────────────────────────────────────
interface Pair {
  ct: string;
  email: string;
  ctUserId: string;
  eh: string | null;
  ehId: string;
  /** EH's External ID now: null blank, equal to ctUserId when it already matches. */
  extId: string | null;
  /** Details that differ between Connecteam and EH, by Connecteam field name. */
  diffs: string[];
  /** A Pre-create check key agrees (email, TFN, or name + DOB). */
  keyAgrees: boolean;
  how: string;
}
const pairs: Pair[] = [
  { ct: "Avery Lin", email: "avery.lin@example.com", ctUserId: "9081201", eh: "Avery Lin", ehId: "300101", extId: null, diffs: [], keyAgrees: true, how: "matched by email" },
  { ct: "Blake Okoro", email: "blake.o@example.com", ctUserId: "9081202", eh: "Blake Okoro", ehId: "300102", extId: "300102", diffs: ["Postcode"], keyAgrees: true, how: "matched by email" },
  { ct: "Casey Duarte", email: "casey.d@example.com", ctUserId: "9081203", eh: "Casey Duarte", ehId: "300103", extId: null, diffs: ["Postcode", "Phone number"], keyAgrees: true, how: "matched by email" },
  { ct: "Devon Marsh", email: "devon.m@example.com", ctUserId: "9081204", eh: "Devon Marsh", ehId: "300104", extId: "9081204", diffs: [], keyAgrees: true, how: "matched by email" },
  { ct: "Emery Novak", email: "emery.n@example.com", ctUserId: "9081205", eh: "Emery Novak", ehId: "300105", extId: "300105", diffs: ["Street Address", "Suburb", "Emergency Contact Number"], keyAgrees: true, how: "matched by email" },
  { ct: "Finley Rowe", email: "finley.r@example.com", ctUserId: "9081206", eh: "Finn Rowe", ehId: "300106", extId: "PR-0042", diffs: ["Phone number"], keyAgrees: false, how: "you picked (name differs)" },
  { ct: "Harper Quinn", email: "harper.q@example.com", ctUserId: "9081207", eh: "Harper Quinn", ehId: "300107", extId: null, diffs: ["Postcode", "Account Number"], keyAgrees: true, how: "matched by email" },
  { ct: "Jordan Ash", email: "jordan.a@example.net", ctUserId: "9081208", eh: null, ehId: "", extId: null, diffs: [], keyAgrees: false, how: "new hire" },
];
/** Each detail by its Connecteam field name (the setup's names, scripts/lib/field-spec.ts), with the EH field it fills. */
const EH_FIELD: Record<string, string> = {
  Postcode: "residentialPostCode",
  "Phone number": "mobilePhone",
  "Street Address": "residentialStreetAddress",
  Suburb: "residentialSuburb",
  "Emergency Contact Number": "emergencyContact1_ContactNumber",
  "Account Number": "bankAccount1_AccountNumber",
};
const linkable = (x: Pair) => x.eh !== null;
const idDiffers = (x: Pair) => linkable(x) && x.extId !== null && x.extId !== x.ctUserId;
const needsChoice = (x: Pair) => idDiffers(x) || x.diffs.length > 0;

// ── shared state: survives a variant switch ─────────────────────────────────
const replace = new Set<number>();
/** Details marked Use Connecteam's, by pair. Absent = Keep EH's (pre-selected). */
const useCt = new Map<number, Set<string>>();
const usesCt = (i: number, d: string) => useCt.get(i)?.has(d) ?? false;
const flip = (i: number, d: string, to?: boolean) => {
  const s = useCt.get(i) ?? new Set<string>();
  if (to ?? !s.has(d)) s.add(d);
  else s.delete(d);
  useCt.set(i, s);
};
const sentFromCt = (i: number) => pairs[i]!.diffs.filter((d) => usesCt(i, d));

// ── pop-ups (shared by every variant) ───────────────────────────────────────
/**
 * One Edit pop-up per person (round 3: the developer's ask, one place to edit,
 * on e), with two bordered sections: EH External ID, then Details. ↑↓ walks
 * every option in both; nothing is kept until Enter.
 */
type Item = { t: "id"; replace: boolean } | { t: "detail"; d: string };
type Popup = { kind: "edit"; i: number; at: number; rep: boolean; draft: Set<string> } | { kind: "save" };
let popup: Popup | null = null;
let saved = false;

const canReplace = (x: Pair) => idDiffers(x) && x.keyAgrees;
const items = (i: number): Item[] => {
  const x = pairs[i]!;
  return [...(canReplace(x) ? [{ t: "id", replace: false } as Item, { t: "id", replace: true } as Item] : []), ...x.diffs.map((d) => ({ t: "detail", d }) as Item)];
};
const canEdit = (i: number) => items(i).length > 0;
const openEdit = (i: number) => {
  if (canEdit(i)) popup = { kind: "edit", i, at: 0, rep: replace.has(i), draft: new Set(useCt.get(i) ?? []) };
};
const keyHint = (...ks: [string, string][]) => ks.map(([k, w]) => `${p.bold(k)} ${p.dim(w)}`).join("     ");

/** Both sections share one width, so they line up inside the pop-up. */
const SECTION_W = 60;
function renderEdit(pu: Extract<Popup, { kind: "edit" }>): string[] {
  const x = pairs[pu.i]!;
  const its = items(pu.i);
  const on = (k: number) => k === pu.at;
  const lbl = (s: string) => p.dim(pad(s, 22));

  // EH External ID section
  const idBody: string[] = [`${lbl("EH External ID")}${x.extId === null ? p.dim("(blank)") : p.eh(x.extId)}${x.extId !== null && x.extId === x.ehId ? p.change("   ⚠ this is their EH Employee ID") : ""}`, `${lbl("Connecteam User ID")}${p.ct(x.ctUserId)}`, ""];
  if (!idDiffers(x)) idBody.push(p.ok(x.extId === null ? "✓ Blank in EH: it'll be set to their Connecteam User ID." : "✓ They match. Nothing to choose."));
  else if (!x.keyAgrees) idBody.push(p.bad("They don't match, and it can't be replaced:"), p.dim("no email, TFN or name + date of birth match."), p.dim("They'll be held at approval. Fix the EH record by hand."));
  else {
    idBody.push(p.dim("They don't match. Pick one:"), "");
    const opt = (k: number, chosen: boolean, title: string, why: string[]) => [`${ptr(on(k))} ${radio(chosen)}  ${on(k) ? p.bold(title) : title}`, ...why.map((w) => `        ${p.dim(w)}`), ""];
    idBody.push(
      ...opt(0, !pu.rep, `Keep EH's External ID (${x.extId})`, ["Nothing changes in EH. They're held at approval."]),
      ...opt(1, pu.rep, `Replace it with the Connecteam User ID (${x.ctUserId})`, [`Overwritten at approval, only if EH still holds ${x.extId}.`]),
    );
    idBody.pop();
  }

  // Details section
  const detBody: string[] = [];
  if (!x.diffs.length) detBody.push(p.ok("✓ All the same in both. Nothing to choose."));
  else {
    detBody.push(p.dim("These differ between Connecteam and EH. Values aren't shown."), "");
    x.diffs.forEach((d) => {
      const k = its.findIndex((it) => it.t === "detail" && it.d === d);
      const ct = pu.draft.has(d);
      detBody.push(
        `${ptr(on(k))} ${on(k) ? p.bold(d) : d}`,
        `      ${p.dim(pad("Connecteam field", 18))}${p.ct(d)}`,
        `      ${p.dim(pad("EH field", 18))}${p.eh(EH_FIELD[d] ?? d)}`,
        `      ${radio(!ct)} ${!ct ? p.bold("Keep EH's") : "Keep EH's"}        ${radio(ct)} ${ct ? p.bold("Use Connecteam's") : "Use Connecteam's"}`,
        "",
      );
    });
    detBody.pop();
  }

  // Both sections one width, so they line up.
  const secW = Math.max(SECTION_W, ...[...idBody, ...detBody].map((l) => vis(l) + 4));
  const sent = x.diffs.filter((d) => pu.draft.has(d));
  const notice = [...(pu.rep ? ["EH External ID replaced"] : []), ...(sent.length ? [`Sent from Connecteam: ${sent.join(", ")}`] : [])].join(". ");
  return box(
    `Edit · ${x.ct}`,
    [
      `${lbl("Connecteam user")}${p.ct(x.ct)}  ${p.dim(x.email)}`,
      `${lbl("Employment Hero")}${p.eh(x.eh!)}  ${p.dim(`EH Employee ID ${x.ehId}`)}`,
      "",
      ...box("1  EH External ID", idBody, [], secW),
      "",
      ...box(`2  Details${x.diffs.length ? ` (${x.diffs.length === 1 ? "1 differs" : `${x.diffs.length} differ`})` : ""}`, detBody, [], secW),
      "",
      p.dim(`Link notice will say: ${notice || "(just linked)"}`),
    ],
    [keyHint(["↑↓", "move"], ["←→ / Space", "choose"], ["Enter", "save"], ["Esc", "cancel"])],
  );
}

function renderPopup(pu: Popup): string[] {
  if (pu.kind === "edit") return renderEdit(pu);
  const links = pairs.filter(linkable).length;
  const held = pairs.filter((x, i) => idDiffers(x) && !replace.has(i)).length;
  const fromCt = new Map<string, number>();
  pairs.forEach((_, i) => sentFromCt(i).forEach((d) => fromCt.set(d, (fromCt.get(d) ?? 0) + 1)));
  const kept = pairs.reduce((n, x, i) => n + x.diffs.length - sentFromCt(i).length, 0);
  const lbl = (s: string) => p.dim(pad(s, 30));
  return box(
    "Save these links?",
    [
      `${lbl("To link")}${p.ok(String(links))}`,
      `${lbl("New hires")}${pairs.length - links}`,
      "---",
      `${lbl("EH External ID replaced")}${replace.size ? p.change(String(replace.size)) : "0"}`,
      `${lbl("Held at approval")}${held ? p.bad(`${held}  (EH External ID doesn't match)`) : "0"}`,
      "---",
      `${lbl("Sent from Connecteam at link")}${fromCt.size ? p.change([...fromCt].map(([d, n]) => (n > 1 ? `${d} ×${n}` : d)).join(", ")) : "nothing"}`,
      `${lbl("Kept as EH's")}${kept} detail${kept === 1 ? "" : "s"}`,
    ],
    [keyHint(["y", "save"], ["n", "back"])],
  );
}

/** A key while a pop-up is open. */
function popupKey(str: string | undefined, key: { name?: string }): void {
  const pu = popup!;
  if (pu.kind === "save") {
    if (str === "y") [popup, saved] = [null, true];
    else if (str === "n" || key.name === "escape") popup = null;
    return;
  }
  if (key.name === "escape") return void (popup = null);
  const its = items(pu.i);
  const it = its[pu.at]!;
  if (key.name === "up") pu.at = Math.max(0, pu.at - 1);
  else if (key.name === "down") pu.at = Math.min(its.length - 1, pu.at + 1);
  else if (key.name === "return") {
    if (pu.rep) replace.add(pu.i);
    else replace.delete(pu.i);
    useCt.set(pu.i, pu.draft);
    popup = null;
  } else if (it.t === "id" && (key.name === "space" || key.name === "left" || key.name === "right")) pu.rep = it.replace;
  else if (it.t === "detail") {
    if (key.name === "left") pu.draft.delete(it.d);
    else if (key.name === "right") pu.draft.add(it.d);
    else if (key.name === "space") {
      if (pu.draft.has(it.d)) pu.draft.delete(it.d);
      else pu.draft.add(it.d);
    }
  }
}

// ── short status words, shared ──────────────────────────────────────────────
const idShort = (i: number): string => {
  const x = pairs[i]!;
  if (!linkable(x)) return p.dim("new hire");
  if (x.extId === null) return p.dim("blank in EH, will be set");
  if (x.extId === x.ctUserId) return p.ok("matches");
  if (replace.has(i)) return p.change("will be replaced");
  if (!x.keyAgrees) return p.bad("doesn't match, can't replace");
  return p.bad("doesn't match");
};
const detailsShort = (i: number): string => {
  const x = pairs[i]!;
  if (!x.diffs.length) return p.dim("all the same");
  const n = sentFromCt(i).length;
  return p.change(n ? `${x.diffs.length} differ · ${n} from Connecteam` : `${x.diffs.length} differ · all EH's kept`);
};
const stateLine = () =>
  p.dim(
    `  [state] replace={${[...replace].map((i) => i + 1).join(",")}} useCt={${[...useCt]
      .filter(([, s]) => s.size)
      .map(([i, s]) => `${i + 1}:${[...s].join("+")}`)
      .join(" ")}}`,
  );

// ── the list every variant starts from (today's screen, cut down) ───────────
const listRows = (cursor: number, status: (i: number) => string): string[] => [
  p.bold(`    #  ${" ".repeat(color ? 1 : 4)} ${pad("Connecteam user", 16)} ${pad("Employment Hero match", 24)} Status`),
  ...pairs.map((x, i) => {
    const m = !linkable(x) ? mark.none : needsChoice(x) ? mark.warn : mark.ok;
    const name = pad(p.ct(x.ct), 16);
    return `  ${ptr(i === cursor)} ${i + 1}  ${pad(m, color ? 1 : 4)} ${i === cursor ? p.bold(name) : name} ${pad(x.eh ? `${p.eh(x.eh)} ${p.dim(x.ehId)}` : p.dim("(no match)"), 24)} ${status(i)}`;
  }),
];
const header = (variant: string, title: string) => [`  ${p.bold("Link Pre-existing employees")}     ${p.dim(`PROTOTYPE variant ${variant}: ${title}`)}`, ""];
/** The two short lines for one person; `at` marks the line under the cursor. */
const twoLines = (i: number, at: number | null, hints: boolean): string[] => [
  `${ptr(at === 0)} ${pad(p.dim("EH External ID"), 18)} ${pad(idShort(i), 34)} ${hints && canEdit(i) ? p.dim("e to edit both") : ""}`,
  `${ptr(at === 1)} ${pad(p.dim("Details"), 18)} ${pad(detailsShort(i), 34)}`,
];
const boxed = (title: string, body: string[]) => box(title, body, [], COLS() - 8).map((l) => `  ${l}`);

interface Variant {
  name: string;
  render(): string[];
  press(str: string | undefined, key: { name?: string }): void;
}
/** Today's list before c, for B and C. */
const plainList = (variant: string, name: string, cursor: number, note: string) => [
  ...header(variant, name),
  ...listRows(cursor, (i) => p.dim(pairs[i]!.how)),
  "",
  p.dim(`    ${note}`),
  "",
  ...legend([["↑↓", "move"], ["c", "confirm"], ["v", "next variant"], ["q", "quit"]]),
  stateLine(),
];

// ── A: as you go ────────────────────────────────────────────────────────────
function variantA(): Variant {
  let cursor = 0;
  return {
    name: "As you go, on the list",
    render() {
      const x = pairs[cursor]!;
      const ks: [string, string][] = [["↑↓", "move"]];
      if (canEdit(cursor)) ks.push(["e", "edit EH External ID and details"]);
      ks.push(["c", "confirm"], ["v", "next variant"], ["q", "quit"]);
      return [
        ...header("A", this.name),
        ...listRows(cursor, (i) => (linkable(pairs[i]!) ? `${idShort(i)}${pairs[i]!.diffs.length ? p.dim(" · ") + detailsShort(i) : ""}` : p.dim("new hire"))),
        "",
        ...boxed(`Row ${cursor + 1} · ${x.ct} → ${x.eh ?? "new hire"}`, linkable(x) ? twoLines(cursor, null, true) : [p.dim("No Employment Hero match: syncs as a new hire.")]),
        "",
        ...legend(ks),
        stateLine(),
      ];
    },
    press(str, key) {
      if (key.name === "up") cursor = Math.max(0, cursor - 1);
      else if (key.name === "down") cursor = Math.min(pairs.length - 1, cursor + 1);
      else if (str === "e") openEdit(cursor);
      else if (str === "c") popup = { kind: "save" };
    },
  };
}

// ── B: after c, one person at a time ────────────────────────────────────────
function variantB(): Variant {
  let cursor = 0;
  let stage: "list" | "intro" | "cards" = "list";
  let card = 0;
  let line: 0 | 1 = 0;
  const queue = () => pairs.flatMap((x, i) => (needsChoice(x) ? [i] : []));
  const firstLine = (i: number): 0 | 1 => (idDiffers(pairs[i]!) ? 0 : 1);
  return {
    name: "After c, one person at a time",
    render() {
      if (stage === "list") return plainList("B", this.name, cursor, "Today's list, unchanged: the new choices wait until you press c.");
      const q = queue();
      if (stage === "intro") {
        return [
          ...header("B", this.name),
          ...boxed(`${q.length} of your ${pairs.filter(linkable).length} links need a choice`, [
            ...q.flatMap((i) => [`${p.ct(pairs[i]!.ct)} → ${p.eh(pairs[i]!.eh!)}`, `     ${pad(p.dim("EH External ID"), 18)}${idShort(i)}`, `     ${pad(p.dim("Details"), 18)}${detailsShort(i)}`, ""]),
            p.dim("Keep EH's is already picked everywhere, so going straight through changes nothing."),
          ]),
          "",
          ...legend([["Enter", "go through them"], ["s", "skip: keep EH's everywhere"], ["Esc", "back to the list"]]),
          stateLine(),
        ];
      }
      const i = q[card]!;
      const x = pairs[i]!;
      return [
        ...header("B", this.name),
        ...boxed(`Person ${card + 1} of ${q.length}`, [
          `${pad(p.dim("Connecteam user"), 20)}${p.ct(x.ct)}  ${p.dim(x.email)}`,
          `${pad(p.dim("Employment Hero"), 20)}${p.eh(x.eh!)}  ${p.dim(`EH Employee ID ${x.ehId}`)}`,
          "---",
          ...twoLines(i, line, false),
        ]),
        "",
        ...legend([["↑↓", "line"], ["Enter", "open"], ["n", card + 1 < q.length ? "next person" : "to save"], ["b", "previous person"]]),
        stateLine(),
      ];
    },
    press(str, key) {
      if (stage === "list") {
        if (key.name === "up") cursor = Math.max(0, cursor - 1);
        else if (key.name === "down") cursor = Math.min(pairs.length - 1, cursor + 1);
        else if (str === "c") stage = "intro";
        return;
      }
      const q = queue();
      if (stage === "intro") {
        if (key.name === "return") [stage, card, line] = ["cards", 0, firstLine(q[0]!)];
        else if (str === "s") popup = { kind: "save" };
        else if (key.name === "escape") stage = "list";
        return;
      }
      const i = q[card]!;
      if (key.name === "up" && idDiffers(pairs[i]!)) line = 0;
      else if (key.name === "down" && pairs[i]!.diffs.length) line = 1;
      else if (key.name === "return") {
        openEdit(i);
      } else if (str === "n") {
        if (card + 1 < q.length) [card, line] = [card + 1, firstLine(q[card + 1]!)];
        else popup = { kind: "save" };
      } else if (str === "b") {
        if (card > 0) [card, line] = [card - 1, firstLine(q[card - 1]!)];
        else stage = "intro";
      }
    },
  };
}

// ── C: after c, everyone in one table ───────────────────────────────────────
function variantC(): Variant {
  let stage: "list" | "grid" = "list";
  let cursor = 0;
  let r = 0;
  let col = 0;
  const ID = "EH External ID";
  const rowsOf = () => pairs.flatMap((x, i) => (needsChoice(x) ? [i] : []));
  const cols = () => [ID, ...new Set(pairs.flatMap((x) => x.diffs))];
  const W = 16;
  const cell = (i: number, name: string): string => {
    const x = pairs[i]!;
    if (name === ID) {
      if (!idDiffers(x)) return p.dim("·");
      if (!x.keyAgrees) return p.bad("can't replace");
      return replace.has(i) ? p.change("replace") : p.bad("doesn't match");
    }
    if (!x.diffs.includes(name)) return p.dim("·");
    return usesCt(i, name) ? p.ct("Connecteam's") : p.eh("EH's");
  };
  return {
    name: "After c, everyone in one table",
    render() {
      if (stage === "list") return plainList("C", this.name, cursor, "Today's list, unchanged: the table opens when you press c.");
      const rs = rowsOf();
      const cs = cols();
      const short = (h: string) => (h.length > W - 2 ? `${h.slice(0, W - 3)}…` : h);
      const head = `      ${pad(p.bold("Person"), 16)}${cs.map((h, k) => pad(k === col ? p.bold(p.ct(short(h))) : p.bold(short(h)), W)).join("")}`;
      const grid = rs.map((i, k) => {
        const cells = cs.map((h, j) => {
          const v = pad(cell(i, h), W - 2);
          return (k === r && j === col ? (color ? p.inv(v) : `[${strip(v).trim()}]`.padEnd(W - 2)) : v) + "  ";
        });
        return `    ${ptr(k === r)} ${pad(p.ct(pairs[i]!.ct), 16)}${cells.join("")}`;
      });
      const i = rs[r]!;
      const h = cs[col]!;
      const who = `${pad(p.dim("Person"), 20)}${p.ct(pairs[i]!.ct)} → ${p.eh(pairs[i]!.eh!)}`;
      const sel =
        h === ID
          ? [who, `${pad(p.dim("EH External ID"), 20)}${idShort(i)}`]
          : [who, `${pad(p.dim("Connecteam field"), 20)}${p.ct(h)}`, `${pad(p.dim("EH field"), 20)}${p.eh(EH_FIELD[h] ?? h)}`];
      const ks: [string, string][] = [["↑↓←→", "move"], ["Space", h === ID ? "open" : "flip"]];
      if (h !== ID) ks.push(["a", `flip ${h} for everyone`]);
      ks.push(["Enter", "save"], ["Esc", "back to the list"]);
      return [
        ...header("C", this.name),
        `    ${p.bold(`Before you save: ${rs.length} people differ from Employment Hero`)}`,
        p.dim("    · = the same in both, nothing to choose.  EH's is picked to start."),
        "",
        head,
        ...grid,
        "",
        ...boxed("Selected", sel),
        "",
        ...legend(ks),
        stateLine(),
      ];
    },
    press(str, key) {
      if (stage === "list") {
        if (key.name === "up") cursor = Math.max(0, cursor - 1);
        else if (key.name === "down") cursor = Math.min(pairs.length - 1, cursor + 1);
        else if (str === "c") stage = "grid";
        return;
      }
      const rs = rowsOf();
      const cs = cols();
      const i = rs[r]!;
      const h = cs[col]!;
      if (key.name === "up") r = Math.max(0, r - 1);
      else if (key.name === "down") r = Math.min(rs.length - 1, r + 1);
      else if (key.name === "left") col = Math.max(0, col - 1);
      else if (key.name === "right") col = Math.min(cs.length - 1, col + 1);
      else if (key.name === "space") {
        if (h === ID) {
          openEdit(i);
        } else if (pairs[i]!.diffs.includes(h)) flip(i, h);
      } else if (str === "a" && h !== ID) {
        const holders = rs.filter((j) => pairs[j]!.diffs.includes(h));
        const to = !holders.every((j) => usesCt(j, h));
        holders.forEach((j) => flip(j, h, to));
      } else if (key.name === "return") popup = { kind: "save" };
      else if (key.name === "escape") stage = "list";
    },
  };
}

// ── driver ──────────────────────────────────────────────────────────────────
const order = ["A", "B", "C"];
const make: Record<string, () => Variant> = { A: variantA, B: variantB, C: variantC };
let which = order.includes(arg("variant", "A").toUpperCase()) ? arg("variant", "A").toUpperCase() : "A";
let v = make[which]!();
const frame = () => {
  if (saved) return [...header(which, v.name), p.ok("    Saved (not really: prototype)."), "", ...legend([["v", "next variant"], ["q", "quit"]]), stateLine()];
  const base = v.render();
  return popup ? overlay(base, renderPopup(popup)) : base;
};

if (!process.stdin.isTTY) {
  // Sample screens: A on a person with both choices, each pop-up over it, B's person screen, C's table.
  const a = variantA();
  for (let k = 0; k < 4; k++) a.press(undefined, { name: "down" });
  console.log(a.render().join("\n") + "\n");
  for (const pu of [() => openEdit(4), () => openEdit(1), () => (popup = { kind: "save" })]) {
    pu();
    console.log(overlay(a.render(), renderPopup(popup!)).join("\n") + "\n");
  }
  popup = null;
  const b = variantB();
  b.press("c", {});
  b.press(undefined, { name: "return" });
  console.log(b.render().join("\n") + "\n");
  const cc = variantC();
  cc.press("c", {});
  console.log(cc.render().join("\n") + "\n");
  process.exit(0);
}
const draw = () => process.stdout.write("\u001b[H\u001b[2J" + frame().join("\n"));
const quit = () => {
  process.stdout.write("\u001b[?25h\u001b[?1049l");
  console.log(`Prototype closed on variant ${which}.`);
  console.log(stateLine());
  process.exit(0);
};
process.stdout.write("\u001b[?1049h\u001b[?25l");
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
  if (key.ctrl && key.name === "c") return quit();
  if (popup) popupKey(str, key);
  else if (str === "q") return quit();
  else if (str === "v") {
    which = order[(order.indexOf(which) + 1) % order.length]!;
    v = make[which]!();
    saved = false;
  } else if (!saved) v.press(str, key);
  draw();
});
process.stdout.on("resize", draw);
draw();
