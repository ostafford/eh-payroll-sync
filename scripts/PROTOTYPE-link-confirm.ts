/**
 * PROTOTYPE - throwaway, never merged to main (#222, map #214).
 *
 * Question: what does the link stage's confirm screen look like now that a
 * confirmed pair can carry two extra choices?
 *   - "Link and replace External ID" (#217), confirmed in a prompt naming both values;
 *   - per-detail Keep EH's (pre-selected) / Use Connecteam's, names only (#220).
 *
 * Three structurally different variants, all on FAKE data (no API call,
 * nothing written anywhere):
 *
 *   A  In the row panel: the choices live on the existing full-screen list.
 *      The selected pair's panel grows an "External ID" line and a "Details
 *      that differ" list; r replaces, d steps into the details. The Status
 *      column says what's set. c is the same Save prompt as today, with counts.
 *   B  A settle step after c: the list is unchanged; c opens "N pairs need a
 *      choice before saving" and walks them one card at a time (Pair 2 of 4).
 *      ←→ picks EH's / Connecteam's for the selected detail.
 *   C  A grid after c: one table, a row per pair needing a choice, a column
 *      per detail name (plus External ID). Space flips a cell, a flips the
 *      whole column - "use Connecteam's Postcode for everyone".
 *
 *   npm run prototype:link-confirm -- --variant B
 *   NO_COLOR=1 npm run prototype:link-confirm -- --variant C
 *
 * v switches variant (same data, choices kept). q quits. Not in a terminal,
 * it prints each variant's opening screen.
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
const vis = (s: string) => s.replace(ANSI, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));
const ptr = (on: boolean) => (on ? (color ? p.ct("▶") : ">") : " ");

// ── fake data ───────────────────────────────────────────────────────────────
interface Pair {
  ct: string;
  email: string;
  ctUserId: string;
  eh: string | null;
  ehId: string;
  /** EH's External ID now: null blank, equal to ctUserId when it already matches. */
  extId: string | null;
  /** Details that differ between Connecteam and EH, names only. */
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
/** Each detail by its Connecteam field name (the setup's field names, scripts/lib/field-spec.ts), with the EH field it fills. */
const EH_FIELD: Record<string, string> = {
  Postcode: "residentialPostCode",
  "Phone number": "mobilePhone",
  "Street Address": "residentialStreetAddress",
  Suburb: "residentialSuburb",
  "Emergency Contact Number": "emergencyContact1_ContactNumber",
  "Account Number": "bankAccount1_AccountNumber",
};
/** "Postcode (Connecteam) → residentialPostCode (EH)", padded to line up. */
const fieldPair = (d: string) => `${pad(p.ct(d), 26)} ${p.dim("→")} ${pad(p.eh(EH_FIELD[d] ?? d), 33)}`;
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
/** A replace waiting on y/n, by pair. */
let asking: number | null = null;
let saving = false;
let saved = false;

const askReplace = (i: number) => {
  if (replace.has(i)) replace.delete(i);
  else if (pairs[i]!.keyAgrees) asking = i;
};
const replacePrompt = (i: number): string[] => {
  const x = pairs[i]!;
  return [
    p.bold(`  Replace ${x.eh}'s External ID in Employment Hero?`),
    "",
    `    EH External ID now:    ${p.eh(x.extId!)}${x.extId === x.ehId ? p.dim("   (this is their EH Employee ID, not a Payroll ID)") : ""}`,
    `    Replace it with:       ${p.ct(x.ctUserId)}${p.dim(`   (${x.ct}'s Connecteam User ID)`)}`,
    "",
    p.dim(`    Happens at approval, and only if EH still holds ${x.extId} then.`),
    "",
    `  ${p.bold("y")} ${p.dim("replace")}     ${p.bold("n")} ${p.dim("keep EH's - they'll be held at approval")}`,
  ];
};

/** What a pair's EH External ID will do, in words, naming both IDs. */
const idLine = (i: number): string => {
  const x = pairs[i]!;
  const ct = `Connecteam User ID ${x.ctUserId}`;
  if (!linkable(x)) return p.dim(`new hire: EH External ID set to their ${ct}`);
  if (x.extId === null) return p.dim(`blank in EH: set to their ${ct}`);
  if (x.extId === x.ctUserId) return p.dim(`already their ${ct}`);
  const what = x.extId === x.ehId ? `${x.extId} (their EH Employee ID)` : x.extId;
  if (replace.has(i)) return p.change(`replace ${x.extId} with their ${ct}`);
  if (!x.keyAgrees) return p.bad(`EH has ${what}: can't replace (no email, TFN or name + DOB match) - held at approval`);
  return p.change(`EH has ${what}, not their ${ct}: held at approval unless replaced`);
};
const sentFromCt = (i: number) => pairs[i]!.diffs.filter((d) => usesCt(i, d));

const summary = (): string[] => {
  const links = pairs.filter(linkable).length;
  const reps = replace.size;
  const held = pairs.filter((x, i) => idDiffers(x) && !replace.has(i)).length;
  const fromCt = new Map<string, number>();
  pairs.forEach((_, i) => sentFromCt(i).forEach((d) => fromCt.set(d, (fromCt.get(d) ?? 0) + 1)));
  const details = [...fromCt].map(([d, n]) => (n > 1 ? `${d} ×${n}` : d)).join(", ");
  const kept = pairs.reduce((n, x, i) => n + x.diffs.length - sentFromCt(i).length, 0);
  return [
    p.bold("  Save these links?"),
    `  ${p.ok(`${links} to link`)} · ${pairs.length - links} new hire`,
    `  ${reps ? p.change(`${reps} External ID replaced`) : p.dim("no External ID replaced")}${held ? ` · ${p.bad(`${held} held at approval: External ID differs`)}` : ""}`,
    `  ${fromCt.size ? p.change(`Sent from Connecteam at link: ${details}`) : p.dim("No details sent from Connecteam")} · ${p.dim(`${kept} kept as EH's`)}`,
    `  ${p.bold("y")} ${p.dim("save")}   ${p.bold("n")} ${p.dim("back")}`,
  ];
};
const stateLine = () =>
  p.dim(
    `  [state] replace={${[...replace].map((i) => i + 1).join(",")}} useCt={${[...useCt]
      .filter(([, s]) => s.size)
      .map(([i, s]) => `${i + 1}:${[...s].join("+")}`)
      .join(" ")}}`,
  );
const keys = (...ks: [string, string][]) => `\n  ${ks.map(([k, w]) => `${p.bold(k)} ${p.dim(w)}`).join("     ")}\n`;

// ── the list every variant starts from (today's screen, cut down) ───────────
const listRows = (cursor: number, status: (i: number) => string): string[] => [
  p.bold(`  #  ${pad("Connecteam user", 16)} ${pad("Employment Hero match", 24)} Status`),
  ...pairs.map((x, i) => {
    const m = !linkable(x) ? mark.none : needsChoice(x) ? mark.warn : mark.ok;
    const name = pad(p.ct(x.ct), 16);
    return `${ptr(i === cursor)} ${i + 1} ${pad(m, color ? 1 : 4)} ${i === cursor ? p.bold(name) : name} ${pad(x.eh ? `${p.eh(x.eh)} ${p.dim(x.ehId)}` : p.dim("(no match)"), 24)} ${status(i)}`;
  }),
];
const header = (variant: string, title: string) => [
  `${p.bold("Link Pre-existing employees")}   ${p.dim(`PROTOTYPE variant ${variant}: ${title}`)}`,
  p.dim("─".repeat(Math.min(100, process.stdout.columns || 100) - 1)),
];

interface Variant {
  name: string;
  render(): string[];
  press(str: string | undefined, key: { name?: string }): void;
}

// ── A: in the row panel ─────────────────────────────────────────────────────
function variantA(): Variant {
  let cursor = 0;
  let inDetails = false;
  let dc = 0;
  const status = (i: number) => {
    const x = pairs[i]!;
    if (!linkable(x)) return p.dim("new hire");
    const bits = [p.dim(x.how)];
    if (idDiffers(x)) bits.push(replace.has(i) ? p.change("replace ID") : p.bad("ID differs"));
    if (x.diffs.length) {
      const n = sentFromCt(i).length;
      bits.push(n ? p.change(`${n}/${x.diffs.length} from CT`) : p.dim(`${x.diffs.length} differ, EH's kept`));
    }
    return bits.join(" · ");
  };
  return {
    name: "In the row panel",
    render() {
      const x = pairs[cursor]!;
      const panel = [`  ${p.bold(`Row ${cursor + 1}`)}  ${p.ct(x.ct)} → ${x.eh ? p.eh(`${x.eh} EH ${x.ehId}`) : p.dim("new hire")}`];
      if (linkable(x)) {
        panel.push(`  ${p.dim("EH External ID")}  ${idLine(cursor)}`);
        if (x.diffs.length) {
          panel.push("", `  ${p.dim("Details that differ")} ${inDetails ? "" : p.dim("(d to choose)")}`);
          x.diffs.forEach((d, k) => {
            const ct = usesCt(cursor, d);
            const cell = `${ct ? "( )" : p.eh("(•)")} Keep EH's   ${ct ? p.ct("(•)") : "( )"} Use Connecteam's`;
            panel.push(`  ${ptr(inDetails && k === dc)} ${fieldPair(d)}  ${cell}`);
          });
          const sent = sentFromCt(cursor);
          if (sent.length) panel.push(p.dim(`    Link notice will say: Sent from Connecteam: ${sent.join(", ")}`));
        } else panel.push(`  ${p.dim("Details")}  ${p.dim("all the same in both")}`);
      }
      const legend = saving
        ? []
        : asking !== null
          ? []
          : inDetails
            ? [keys(["↑↓", "detail"], ["Space", "keep EH's / use Connecteam's"], ["Esc", "back to the list"])]
            : [
                keys(
                  ["↑↓", "move"],
                  ...(idDiffers(x) && x.keyAgrees ? [["r", replace.has(cursor) ? "keep EH's External ID" : "link and replace External ID"] as [string, string]] : []),
                  ...(x.diffs.length ? [["d", "choose details"] as [string, string]] : []),
                  ["c", "confirm"],
                  ["v", "next variant"],
                ),
              ];
      return [
        ...header("A", this.name),
        ...listRows(cursor, status),
        p.dim("─".repeat(60)),
        ...(saving ? summary() : asking !== null ? replacePrompt(asking) : panel),
        ...legend,
        stateLine(),
      ];
    },
    press(str, key) {
      const x = pairs[cursor]!;
      if (inDetails) {
        if (key.name === "escape") inDetails = false;
        else if (key.name === "up") dc = Math.max(0, dc - 1);
        else if (key.name === "down") dc = Math.min(x.diffs.length - 1, dc + 1);
        else if (key.name === "space" || key.name === "left" || key.name === "right") flip(cursor, x.diffs[dc]!);
        return;
      }
      if (key.name === "up") cursor = Math.max(0, cursor - 1);
      else if (key.name === "down") cursor = Math.min(pairs.length - 1, cursor + 1);
      else if (str === "r" && idDiffers(x)) askReplace(cursor);
      else if (str === "d" && x.diffs.length) [inDetails, dc] = [true, 0];
      else if (str === "c") saving = true;
    },
  };
}

// ── B: a settle step after c, one card per pair ─────────────────────────────
function variantB(): Variant {
  let cursor = 0;
  let stage: "list" | "intro" | "cards" = "list";
  let card = 0;
  let line = 0;
  const queue = () => pairs.flatMap((x, i) => (needsChoice(x) ? [i] : []));
  /** A card's selectable lines: the External ID (if it differs), then each detail. */
  const lines = (i: number) => [...(idDiffers(pairs[i]!) ? ["@id"] : []), ...pairs[i]!.diffs];
  return {
    name: "Settle step after c",
    render() {
      if (stage === "list") {
        return [
          ...header("B", this.name),
          ...listRows(cursor, (i) => (linkable(pairs[i]!) ? p.dim(pairs[i]!.how) : p.dim("new hire"))),
          p.dim("─".repeat(60)),
          p.dim("  (Today's list, unchanged: the new choices wait until you press c.)"),
          keys(["↑↓", "move"], ["c", "confirm"], ["v", "next variant"]),
          stateLine(),
        ];
      }
      if (stage === "intro" || saving) {
        const q = queue();
        return [
          ...header("B", this.name),
          ...(saving
            ? summary()
            : [
                p.bold(`  ${q.length} of your ${pairs.filter(linkable).length} links need a choice before saving`),
                ...q.map((i) => {
                  const x = pairs[i]!;
                  const why = [...(idDiffers(x) ? ["External ID differs"] : []), ...(x.diffs.length ? [`${x.diffs.length === 1 ? "1 detail differs" : `${x.diffs.length} details differ`}`] : [])];
                  return `    ${p.ct(x.ct)} → ${p.eh(x.eh!)}   ${p.change(why.join(", "))}`;
                }),
                "",
                p.dim("  Keep EH's is already picked for every detail, so Enter straight through keeps EH as it is."),
                keys(["Enter", "go through them"], ["s", "skip: keep EH's everywhere, save"], ["Esc", "back to the list"]),
              ]),
          stateLine(),
        ];
      }
      const q = queue();
      const i = q[card]!;
      const x = pairs[i]!;
      const ls = lines(i);
      const body: string[] = [
        `  ${p.bold(`Pair ${card + 1} of ${q.length}`)}   ${p.ct(x.ct)} ${p.dim(x.email)}  →  ${p.eh(`${x.eh} EH ${x.ehId}`)}`,
        "",
      ];
      ls.forEach((d, k) => {
        const on = k === line;
        if (d === "@id") {
          const opt = (sel: boolean, s: string) => (sel ? p.inv(` ${s} `) : ` ${s} `);
          const choice = x.keyAgrees
            ? `${opt(!replace.has(i), `Keep ${x.extId} (held)`)} ${opt(replace.has(i), `Replace with ${x.ctUserId}`)}`
            : p.bad(`EH has ${x.extId}: can't replace, no email/TFN/name+DOB match - held`);
          body.push(`  ${ptr(on)} ${p.bold(pad("EH External ID", 63))} ${choice}`);
          body.push("");
        } else {
          if (k === (ls[0] === "@id" ? 1 : 0)) body.push(`    ${p.dim(pad("Details that differ", 26))}   ${p.dim(pad("(Connecteam field → EH field)", 33))}`);
          const ct = usesCt(i, d);
          const opt = (sel: boolean, s: string, col: (s: string) => string) => (sel ? p.inv(col(` ${s} `)) : p.dim(` ${s} `));
          body.push(`  ${ptr(on)} ${fieldPair(d)}  ${opt(!ct, "Keep EH's", p.eh)} ${opt(ct, "Use Connecteam's", p.ct)}`);
        }
      });
      const sent = sentFromCt(i);
      body.push("", p.dim(`  Link notice will say: ${[...(replace.has(i) ? ["External ID replaced"] : []), ...(sent.length ? [`Sent from Connecteam: ${sent.join(", ")}`] : [])].join(". ") || "(just linked)"}`));
      return [
        ...header("B", this.name),
        ...(asking !== null ? replacePrompt(asking) : body),
        ...(asking !== null ? [] : [keys(["↑↓", "line"], ["←→", "choose"], ["Enter", card + 1 < q.length ? "next pair" : "to save"], ["Backspace", "previous pair"])]),
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
      if (stage === "intro") {
        if (key.name === "return") [stage, card, line] = ["cards", 0, 0];
        else if (str === "s") saving = true;
        else if (key.name === "escape") stage = "list";
        return;
      }
      const q = queue();
      const i = q[card]!;
      const ls = lines(i);
      if (key.name === "up") line = Math.max(0, line - 1);
      else if (key.name === "down") line = Math.min(ls.length - 1, line + 1);
      else if (key.name === "left" || key.name === "right" || key.name === "space") {
        const d = ls[line]!;
        if (d === "@id") {
          if ((key.name === "right") !== replace.has(i) || key.name === "space") askReplace(i);
        } else flip(i, d, key.name === "space" ? undefined : key.name === "right");
      } else if (key.name === "return") {
        if (card + 1 < q.length) [card, line] = [card + 1, 0];
        else saving = true;
      } else if (key.name === "backspace") {
        if (card > 0) [card, line] = [card - 1, 0];
        else stage = "intro";
      }
    },
  };
}

// ── C: a grid after c ───────────────────────────────────────────────────────
function variantC(): Variant {
  let stage: "list" | "grid" = "list";
  let cursor = 0;
  let r = 0;
  let col = 0;
  const rowsOf = () => pairs.flatMap((x, i) => (needsChoice(x) ? [i] : []));
  const cols = () => ["External ID", ...[...new Set(pairs.flatMap((x) => x.diffs))]];
  const W = 14;
  const cell = (i: number, name: string): string => {
    const x = pairs[i]!;
    if (name === "External ID") {
      if (!idDiffers(x)) return p.dim("·");
      if (!x.keyAgrees) return p.bad("held, can't");
      return replace.has(i) ? p.change("replace") : p.bad("held");
    }
    if (!x.diffs.includes(name)) return p.dim("·");
    return usesCt(i, name) ? p.ct("Connecteam's") : p.eh("EH's");
  };
  return {
    name: "Grid after c",
    render() {
      if (stage === "list") {
        return [
          ...header("C", this.name),
          ...listRows(cursor, (i) => (linkable(pairs[i]!) ? p.dim(pairs[i]!.how) : p.dim("new hire"))),
          p.dim("─".repeat(60)),
          p.dim("  (Today's list, unchanged: the grid opens when you press c.)"),
          keys(["↑↓", "move"], ["c", "confirm"], ["v", "next variant"]),
          stateLine(),
        ];
      }
      const rs = rowsOf();
      const cs = cols();
      const head = `  ${pad("", 2)}${pad(p.bold("Connecteam → EH"), 26)}${cs.map((h, k) => pad(k === col ? p.bold(p.ct(h.slice(0, W - 1))) : p.bold(h.slice(0, W - 1)), W)).join("")}`;
      const grid = rs.map((i, k) => {
        const x = pairs[i]!;
        const cells = cs.map((h, j) => {
          const v = pad(cell(i, h), W - 1);
          return (k === r && j === col ? (color ? p.inv(v) : `[${v.replace(ANSI, "").trim()}]`.padEnd(W - 1)) : v) + " ";
        });
        return `  ${ptr(k === r)} ${pad(`${p.ct(x.ct.split(" ")[0]!)} → ${p.eh(x.eh!)}`, 24)}${cells.join("")}`;
      });
      const i = rs[r]!;
      const sent = sentFromCt(i);
      const foot = [
        `  ${p.dim("Selected:")} ${p.ct(pairs[i]!.ct)} · ${p.dim("EH External ID")} ${idLine(i)}`,
        cs[col] === "External ID" ? "" : `  ${p.dim("Column:")} ${fieldPair(cs[col]!)}`,
        p.dim(`  Link notice will say: ${[...(replace.has(i) ? ["External ID replaced"] : []), ...(sent.length ? [`Sent from Connecteam: ${sent.join(", ")}`] : [])].join(". ") || "(just linked)"}`),
      ];
      return [
        ...header("C", this.name),
        p.bold(`  Before you save: ${rs.length} pairs differ from EH.`) + p.dim("  · = the same in both, nothing to choose. EH's is picked to start."),
        "",
        head,
        ...grid,
        "",
        ...(saving ? summary() : asking !== null ? replacePrompt(asking) : [...foot, keys(["↑↓←→", "move"], ["Space", "flip"], ...(cs[col] === "External ID" ? [] : [["a", `flip ${cs[col]} for everyone`] as [string, string]]), ["Enter", "save"], ["Esc", "back to the list"])]),
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
      if (key.name === "up") r = Math.max(0, r - 1);
      else if (key.name === "down") r = Math.min(rs.length - 1, r + 1);
      else if (key.name === "left") col = Math.max(0, col - 1);
      else if (key.name === "right") col = Math.min(cs.length - 1, col + 1);
      else if (key.name === "space") {
        const i = rs[r]!;
        if (cs[col] === "External ID") {
          if (idDiffers(pairs[i]!)) askReplace(i);
        } else if (pairs[i]!.diffs.includes(cs[col]!)) flip(i, cs[col]!);
      } else if (str === "a" && cs[col] !== "External ID") {
        const holders = rs.filter((i) => pairs[i]!.diffs.includes(cs[col]!));
        const to = !holders.every((i) => usesCt(i, cs[col]!));
        holders.forEach((i) => flip(i, cs[col]!, to));
      } else if (key.name === "return") saving = true;
      else if (key.name === "escape") stage = "list";
    },
  };
}

// ── driver ──────────────────────────────────────────────────────────────────
const order = ["A", "B", "C"];
const make: Record<string, () => Variant> = { A: variantA, B: variantB, C: variantC };
let which = order.includes(arg("variant", "A").toUpperCase()) ? arg("variant", "A").toUpperCase() : "A";
let v = make[which]!();

if (!process.stdin.isTTY) {
  // A on a pair with both choices; B and C on the screen c opens (B's first card too).
  const steps: Record<string, [string | undefined, { name?: string }][]> = {
    A: [[undefined, { name: "down" }], [undefined, { name: "down" }], [undefined, { name: "down" }], [undefined, { name: "down" }]],
    B: [["c", {}], [undefined, { name: "return" }]],
    C: [["c", {}]],
  };
  for (const k of order) {
    const x = make[k]!();
    if (k === "B") {
      x.press("c", {});
      console.log(x.render().join("\n") + "\n");
      x.press(undefined, { name: "return" });
    } else for (const [s, key] of steps[k]!) x.press(s, key);
    console.log(x.render().join("\n") + "\n");
  }
  process.exit(0);
}
const draw = () => process.stdout.write("\u001b[H\u001b[2J" + (saved ? [...header(which, v.name), p.ok("  Saved (not really: prototype)."), stateLine(), keys(["v", "next variant"], ["q", "quit"])] : v.render()).join("\n"));
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
  if ((key.ctrl && key.name === "c") || (str === "q" && asking === null)) return quit();
  if (str === "v" && asking === null) {
    which = order[(order.indexOf(which) + 1) % order.length]!;
    v = make[which]!();
    [saving, saved] = [false, false];
  } else if (asking !== null) {
    if (str === "y") replace.add(asking);
    if (str === "y" || str === "n" || key.name === "escape") asking = null;
  } else if (saving) {
    if (str === "y") [saving, saved] = [false, true];
    else if (str === "n" || key.name === "escape") saving = false;
  } else if (!saved) v.press(str, key);
  draw();
});
process.stdout.on("resize", draw);
draw();
