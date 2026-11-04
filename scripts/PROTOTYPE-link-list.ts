/**
 * PROTOTYPE - throwaway, never merged to main (#137).
 *
 * Question: what should the wizard's link-list stage look like in a terminal,
 * at any headcount? Three structurally different variants, all on FAKE data
 * (generated names on example.com/.net - no real employee, no API call, nothing
 * written anywhere):
 *
 *   A  Spec as written (#132): summary, paged one-row-per-pair Matched table,
 *      then one card per "needs your choice", then the new-hires count.
 *   B  Choices first, stacked pairs: the ambiguous cards come first (while the
 *      admin is fresh), then Matched as two-line pairs (Connecteam line over EH
 *      line) - never wide, so nothing wraps on a narrow terminal.
 *   D  One table of everyone, like the field check (default; the integrator's
 *      ask after trying A-C): matches ticked, problems marked inline, then
 *      "Check the N now? [Y / number to change a row / done]". Changing a row
 *      opens a picker: likely EH employees first, or type to search all of EH.
 *   C  Chunked by surname: the list in alphabetical chunks of ~20, each mixing
 *      its matched rows and its choices, confirmed one chunk at a time with
 *      "chunk 3 of 9" progress.
 *
 *   npm run prototype:link-list -- --variant A --size 180
 *   npm run prototype:link-list -- --variant B --size 600 --seed 7
 *   NO_COLOR=1 npm run prototype:link-list -- --variant C --size 10
 *
 * `v` at any prompt switches to the next variant (same data, starts over).
 * Not in a terminal, every prompt takes its default (Enter / 0), so the whole
 * screen prints.
 */
import { createInterface } from "node:readline/promises";

// ── args ────────────────────────────────────────────────────────────────────
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const VARIANTS = ["D", "A", "B", "C"] as const;
type Variant = (typeof VARIANTS)[number];
let variant = arg("variant", "D").toUpperCase() as Variant;
const SIZE = Number(arg("size", "180"));
const SEED = Number(arg("seed", "1"));

// ── palette (same codes as field-check / field-picker) ──────────────────────
const tty = process.stdout.isTTY === true;
const on = tty && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
const p = { eh: c("35"), ct: c("36"), change: c("33"), dim: c("2"), bold: c("1"), ok: c("32"), bad: c("31") };
const mark = { ok: on ? p.ok("✓") : "[ok]", warn: on ? p.change("⚠") : "[!] ", no: on ? p.bad("✗") : "[x] " };
const MW = on ? 1 : 4; // width of a mark: "✓" vs "[ok]"
const W = () => process.stdout.columns || 100;
const H = () => process.stdout.rows || 30;
// eslint-disable-next-line no-control-regex
const vis = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));
const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
const clear = () => tty && process.stdout.write("\u001b[2J\u001b[H");

// ── fake data ───────────────────────────────────────────────────────────────
let s = SEED >>> 0;
const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (((s ^ (s >>> 15)) * (s | 1)) >>> 0) / 4294967296);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const FIRST = ["Priya", "James", "Mei", "Oliver", "Aroha", "Liam", "Sofia", "Noah", "Hana", "Lucas", "Amira", "Jack", "Chloe", "Ethan", "Zara", "Mateo", "Isla", "Kai", "Ruby", "Arjun", "Grace", "Tama", "Leah", "Omar", "Ava", "Finn", "Nadia", "Theo", "Maya", "Sami", "Elena", "Hamish", "Yuki", "Ben", "Talia", "Rafael", "Ivy", "Dev", "Lena", "Marcus"];
const LAST = ["Raman", "Nguyen", "Smith", "Wong", "Ngata", "Patel", "Brown", "Rossi", "Kim", "Silva", "Haddad", "Taylor", "Murphy", "Chen", "Ahmed", "Garcia", "Walker", "Tanaka", "Kelly", "Singh", "Martin", "Te Rangi", "Cohen", "Khan", "Lee", "O'Brien", "Novak", "Fraser", "Iyer", "Papadopoulos", "Fitzgerald-Montgomery", "Vu", "Doyle", "Morales", "Ali", "Reid", "Okafor", "Lindqvist", "Sato", "Hughes"];
const LONG_DOMAIN = "regional-operations.example.com.au";

type Person = { first: string; last: string; email: string };
type EhRec = Person & { id: number; payrollId?: string; terminated?: boolean };
type Reason = "name differs" | "same email on 2 EH employees" | "name only, email differs" | "already has Payroll ID" | "terminated in EH";
type Row =
  | { kind: "matched"; ct: Person; eh: EhRec }
  | { kind: "choice"; ct: Person; candidates: { eh: EhRec; reason: Reason }[] }
  | { kind: "new"; ct: Person };

function build(size: number) {
  const used = new Set<string>();
  let ehId = 40000;
  const person = (): Person => {
    for (;;) {
      const first = pick(FIRST), last = pick(LAST);
      const local = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "");
      const n = used.has(local) ? `${local}${Math.floor(rnd() * 90 + 10)}` : local;
      if (used.has(n)) continue;
      used.add(n);
      return { first, last, email: `${n}@${rnd() < 0.08 ? LONG_DOMAIN : "example.com"}` };
    }
  };
  const eh = (ps: Person, extra: Partial<EhRec> = {}): EhRec => ({ ...ps, id: ++ehId, ...extra });
  const rows: Row[] = [];
  for (let i = 0; i < size; i++) {
    const ct = person(), r = rnd();
    if (r < 0.8) rows.push({ kind: "matched", ct, eh: eh(ct) });
    else if (r < 0.95) {
      const k = Math.floor(rnd() * 5);
      if (k === 0) rows.push({ kind: "choice", ct, candidates: [{ eh: eh({ ...ct, first: `${ct.first[0]}.` }), reason: "name differs" }] });
      else if (k === 1) rows.push({ kind: "choice", ct, candidates: [{ eh: eh(ct), reason: "same email on 2 EH employees" }, { eh: eh({ ...ct, first: pick(FIRST) }), reason: "same email on 2 EH employees" }] });
      else if (k === 2) rows.push({ kind: "choice", ct, candidates: [{ eh: eh({ ...ct, email: ct.email.replace(/@.*/, "@example.net") }), reason: "name only, email differs" }] });
      else if (k === 3) rows.push({ kind: "choice", ct, candidates: [{ eh: eh(ct, { payrollId: `P${String(Math.floor(rnd() * 9000 + 100)).padStart(4, "0")}` }), reason: "already has Payroll ID" }] });
      else rows.push({ kind: "choice", ct, candidates: [{ eh: eh(ct, { terminated: true }), reason: "terminated in EH" }] });
    } else rows.push({ kind: "new", ct });
  }
  rows.sort((a, b) => `${a.ct.last} ${a.ct.first}`.localeCompare(`${b.ct.last} ${b.ct.first}`));
  // EH-only employees, some of them a near-miss of a new hire (different email), so search can find them.
  const ehOnlyRecs: EhRec[] = [];
  for (const r of rows) if (r.kind === "new" && rnd() < 0.5) ehOnlyRecs.push(eh({ ...r.ct, email: r.ct.email.replace(/@.*/, "@personal.example.net") }));
  while (ehOnlyRecs.length < Math.round(size * 0.08)) ehOnlyRecs.push(eh(person()));
  return { rows, ehOnly: ehOnlyRecs.length, ehOnlyRecs };
}
const data = build(SIZE);
const matched = data.rows.filter((r): r is Extract<Row, { kind: "matched" }> => r.kind === "matched");
const choices = data.rows.filter((r): r is Extract<Row, { kind: "choice" }> => r.kind === "choice");
const newHires = data.rows.filter((r) => r.kind === "new");
const name = (x: Person) => `${x.first} ${x.last}`;

// ── state (rule 5: shown at the end of every run) ───────────────────────────
const dropped = new Set<number>(); // Matched row numbers the admin dropped
const chosen = new Map<number, number>(); // choice index -> candidate (0 = don't link)

// ── prompts ─────────────────────────────────────────────────────────────────
const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
class SwitchVariant extends Error {}
async function ask(q: string, dflt = ""): Promise<string> {
  if (!rl) {
    console.log(`${q}${p.dim(`(auto: ${dflt || "Enter"})`)}`);
    return dflt;
  }
  const a = (await rl.question(q)).trim();
  if (a.toLowerCase() === "v") throw new SwitchVariant();
  return a;
}
const parseNums = (a: string, max: number) => {
  const out = new Set<number>();
  for (const part of a.split(/[\s,]+/).filter(Boolean)) {
    const [x, y] = part.split("-").map(Number);
    for (let n = x; n <= (y || x); n++) if (n >= 1 && n <= max) out.add(n);
  }
  return out;
};

// ── shared pieces ───────────────────────────────────────────────────────────
function summary() {
  const t = SIZE;
  return [
    p.bold("Link Pre-existing employees") + p.dim(`   prototype · variant ${variant} · fake data`),
    "",
    `${t} Connecteam users not yet synced:  ` +
      `${p.ok(`${matched.length} matched`)} · ${p.change(`${choices.length} need your choice`)} · ${newHires.length} new hires`,
    p.dim(`${data.ehOnly} Employment Hero employees have no Connecteam match - ignored.`),
  ];
}

/** One-row Matched table: names both sides, the shared email once, EH id. Emails never cut. */
function matchedTable(from: number, to: number): string[] {
  const numW = String(matched.length).length + 2;
  const emailW = Math.max(5, ...matched.map((m) => m.ct.email.length));
  const idW = 8;
  const fixed = numW + 3 + emailW + idW + 4;
  const nameW = Math.max(10, Math.min(24, Math.floor((W() - fixed) / 2)));
  const head =
    " ".repeat(numW + 1 + MW) +
    p.bold(p.ct(pad("Connecteam user", nameW))) + " " +
    p.bold(p.eh(pad(cut(nameW >= 24 ? "Employment Hero employee" : "EH employee", nameW), nameW))) + " " +
    p.bold(pad("Email (same on both)", emailW)) + " " + p.bold(p.eh("EH id"));
  const lines = [head, " ".repeat(numW + 1 + MW) + p.dim("─".repeat(Math.max(10, Math.min(W() - numW - 4, nameW * 2 + emailW + idW + 3))))];
  for (let i = from; i < to; i++) {
    const m = matched[i], n = i + 1, gone = dropped.has(n);
    const row =
      `${String(n).padStart(numW - 2)}) ${gone ? mark.no : mark.ok} ` +
      p.ct(pad(cut(name(m.ct), nameW), nameW)) + " " +
      p.eh(pad(cut(name(m.eh), nameW), nameW)) + " " +
      pad(m.ct.email, emailW) + " " + p.eh(String(m.eh.id)) +
      (gone ? " " + p.change("← dropped") : "");
    lines.push(row);
  }
  return lines;
}

/** Two-line stacked pair (variant B): never wider than a name + an email. */
function stackedPair(i: number): string[] {
  const m = matched[i], n = i + 1, gone = dropped.has(n);
  const numW = String(matched.length).length + 2;
  const nameW = 24;
  return [
    `${String(n).padStart(numW - 2)}) ${gone ? mark.no : mark.ok} ${p.ct(pad("Connecteam", 16))}${p.ct(pad(cut(name(m.ct), nameW), nameW))} ${m.ct.email}` +
      (gone ? " " + p.change("← dropped") : ""),
    `${" ".repeat(numW + 1 + MW)}${p.eh(pad("Employment Hero", 16))}${p.eh(pad(cut(name(m.eh), nameW), nameW))} ${p.dim(`EH ${m.eh.id}`)}`,
  ];
}

function card(ci: number, label: string): string[] {
  const r = choices[ci];
  const lines = [
    p.bold(`Needs your choice  ${label}`),
    "",
    `  ${p.ct("Connecteam user")}`,
    `    ${p.ct(name(r.ct))}   ${r.ct.email}`,
    "",
    `  ${p.eh(r.candidates.length > 1 ? "Employment Hero candidates" : "Employment Hero candidate")}`,
  ];
  r.candidates.forEach(({ eh, reason }, k) => {
    const nm = name(eh) !== name(r.ct) ? p.change(name(eh)) : p.eh(name(eh));
    const em = eh.email !== r.ct.email ? p.change(eh.email) : eh.email;
    const extra = eh.payrollId ? `   ${p.change(`Payroll ID ${eh.payrollId}`)}` : "";
    const status = eh.terminated ? p.change("Terminated") : p.dim("Active");
    lines.push(`    ${k + 1}) ${nm}   ${em}   ${p.eh(`EH ${eh.id}`)}   ${status}${extra}`);
    lines.push(`       ${mark.warn} ${reason}`);
  });
  lines.push(`    0) Don't link ${p.dim("- they'll be checked again when you approve them")}`);
  return lines;
}

async function askCard(ci: number, label: string) {
  clear();
  console.log(card(ci, label).join("\n") + "\n");
  const max = choices[ci].candidates.length;
  for (;;) {
    const a = await ask(`  Choose ${max === 1 ? "1" : `1–${max}`} to link, 0 don't link: `, "0");
    const n = Number(a);
    if (a !== "" && Number.isInteger(n) && n >= 0 && n <= max) return chosen.set(ci, n);
    console.log(p.change("  Type a number from the list."));
  }
}

async function confirmMatched(render: (from: number, to: number) => string[], perPage: number) {
  for (;;) {
    for (let from = 0; from < matched.length; from += perPage) {
      const to = Math.min(matched.length, from + perPage);
      clear();
      console.log([p.bold(`Matched  ${p.dim(`rows ${from + 1}–${to} of ${matched.length}`)}`), "", ...render(from, to), ""].join("\n"));
      if (to < matched.length) await ask(p.dim("  Enter for more · v next variant "));
    }
    const a = await ask(
      `  ${p.bold("Enter")} to confirm all ${matched.length - dropped.size}, or numbers to drop (e.g. 4 17 30-32), ${p.bold("r")} to review again: `,
    );
    if (a === "") return;
    if (a.toLowerCase() === "r") continue;
    const ns = parseNums(a, matched.length);
    for (const n of ns) (dropped.has(n) ? dropped.delete(n) : dropped.add(n));
    console.log(p.change(`  ${dropped.size} dropped - they'll be checked again when you approve them.`));
  }
}

async function showNewHires() {
  clear();
  console.log([p.bold("New hires"), "", `${newHires.length} Connecteam users have no Employment Hero match. They'll sync as new employees on approval.`, ""].join("\n"));
  if ((await ask(`  ${p.bold("l")} to list them, Enter to continue: `)).toLowerCase() === "l") {
    console.log(newHires.map((r) => `    ${p.ct(name(r.ct))}   ${r.ct.email}`).join("\n") + "\n");
    await ask(p.dim("  Enter to continue "));
  }
}

function finalState() {
  const links = matched.length - dropped.size + [...chosen.values()].filter((n) => n > 0).length;
  const skipped = dropped.size + [...chosen.values()].filter((n) => n === 0).length;
  clear();
  console.log(
    [
      p.bold("Done") + p.dim("   (prototype: nothing written)"),
      "",
      `  ${mark.ok} ${links} pending links would be saved`,
      `  ${mark.warn} ${skipped} not linked - checked again on approval`,
      `  ${newHires.length} new hires · ${data.ehOnly} EH-only ignored`,
      "",
      p.dim(`  dropped rows: ${[...dropped].sort((a, b) => a - b).join(" ") || "none"}`),
      p.dim(`  choices: ${[...chosen].map(([ci, n]) => `${name(choices[ci].ct)}→${n || "don't link"}`).join(", ") || "none"}`),
    ].join("\n"),
  );
}

// ── variants ────────────────────────────────────────────────────────────────
async function variantA() {
  clear();
  console.log(summary().join("\n") + "\n");
  await ask(p.dim("  Enter to start "));
  await confirmMatched(matchedTable, Math.max(5, H() - 8));
  for (let i = 0; i < choices.length; i++) await askCard(i, p.dim(`${i + 1} of ${choices.length}`));
  await showNewHires();
}

async function variantB() {
  clear();
  console.log(summary().join("\n") + "\n" + p.dim(`  The ${choices.length} that need your choice come first.`) + "\n");
  await ask(p.dim("  Enter to start "));
  for (let i = 0; i < choices.length; i++) await askCard(i, p.dim(`${i + 1} of ${choices.length}`));
  await confirmMatched((from, to) => {
    const out: string[] = [];
    for (let i = from; i < to; i++) out.push(...stackedPair(i));
    return out;
  }, Math.max(3, Math.floor((H() - 6) / 2)));
  await showNewHires();
}

async function variantC() {
  const CHUNK = 20;
  const chunks: Row[][] = [];
  for (let i = 0; i < data.rows.length; i += CHUNK) chunks.push(data.rows.slice(i, i + CHUNK));
  clear();
  console.log(summary().join("\n") + "\n" + p.dim(`  In ${chunks.length} chunks of up to ${CHUNK}, A to Z by surname.`) + "\n");
  await ask(p.dim("  Enter to start "));
  for (let k = 0; k < chunks.length; k++) {
    const ch = chunks[k];
    const range = `${ch[0].ct.last} – ${ch[ch.length - 1].ct.last}`;
    for (const r of ch) if (r.kind === "choice") await askCard(choices.indexOf(r), p.dim(`chunk ${k + 1} of ${chunks.length} · ${range}`));
    for (;;) {
      clear();
      const lines = [p.bold(`Chunk ${k + 1} of ${chunks.length}`) + p.dim(`  ${range}`), ""];
      for (const r of ch) {
        if (r.kind === "matched") {
          const n = matched.indexOf(r) + 1, gone = dropped.has(n);
          lines.push(`  ${String(n).padStart(4)}) ${gone ? mark.no : mark.ok} ${p.ct(pad(cut(name(r.ct), 24), 24))} ${r.ct.email}  ${p.eh(`→ EH ${r.eh.id}`)}${gone ? " " + p.change("← dropped") : ""}`);
        } else if (r.kind === "choice") {
          const n = chosen.get(choices.indexOf(r)) ?? 0;
          lines.push(`        ${mark.warn} ${p.ct(pad(cut(name(r.ct), 24), 24))} ${r.ct.email}  ${n ? p.change(`→ EH ${r.candidates[n - 1].eh.id} (you chose)`) : p.dim("not linked")}`);
        } else lines.push(`        ${pad(p.dim("·"), MW)} ${p.ct(pad(cut(name(r.ct), 24), 24))} ${r.ct.email}  ${p.dim("new hire")}`);
      }
      console.log(lines.join("\n") + "\n");
      const a = await ask(`  ${p.bold("Enter")} to confirm this chunk, or numbers to drop: `);
      if (a === "") break;
      for (const n of parseNums(a, matched.length)) (dropped.has(n) ? dropped.delete(n) : dropped.add(n));
    }
  }
}

// ── variant D: one table of everyone, like the field check ──────────────────
// Each row is one Connecteam user. `choice` undefined = untouched (the proposal
// stands), null = "don't link", an EhRec = linked by the admin.
type DRow = { ct: Person; proposed?: EhRec; candidates: { eh: EhRec; reason: Reason }[]; choice?: EhRec | null; note?: string };
const dRows: DRow[] = data.rows.map((r) =>
  r.kind === "matched"
    ? { ct: r.ct, proposed: r.eh, candidates: [] }
    : r.kind === "choice"
      ? { ct: r.ct, candidates: r.candidates }
      : { ct: r.ct, candidates: [] },
);
const allEh: EhRec[] = [...matched.map((m) => m.eh), ...choices.flatMap((x) => x.candidates.map((k) => k.eh)), ...data.ehOnlyRecs];
const linkOf = (r: DRow) => (r.choice !== undefined ? r.choice : r.proposed);
const unsettled = (r: DRow) => r.choice === undefined && !r.proposed && r.candidates.length > 0;
const linkedRow = (eh: EhRec) => dRows.findIndex((r) => linkOf(r)?.id === eh.id);

function dTable(from: number, to: number): string[] {
  const numW = String(dRows.length).length + 2;
  const nameW = 22;
  const emailW = Math.max(5, ...dRows.map((r) => r.ct.email.length));
  const lines = [
    " ".repeat(numW + 1 + MW) + p.bold(p.ct(pad("Connecteam user", nameW + 1 + emailW))) + "   " + p.bold(p.eh(pad("Employment Hero employee", nameW + 10))) + p.bold("Status"),
    " ".repeat(numW + 1 + MW) + p.dim("─".repeat(Math.max(10, Math.min(W() - numW - 2 - MW, nameW * 2 + emailW + 34)))),
  ];
  for (let i = from; i < to; i++) {
    const r = dRows[i], link = linkOf(r);
    let m: string, ehCol: string, status: string;
    if (r.choice === null) [m, ehCol, status] = [pad(p.dim("–"), MW), p.dim("(won't link)"), p.change(r.note ?? "changed")];
    else if (r.choice) [m, ehCol, status] = [mark.ok, p.eh(`${cut(name(r.choice), nameW)}`) + p.dim(` ${r.choice.id}`), p.change(r.note ?? "changed")];
    else if (link) [m, ehCol, status] = [mark.ok, p.eh(cut(name(link), nameW)) + p.dim(` ${link.id}`), p.dim("matched by email")];
    else if (r.candidates.length > 1) [m, ehCol, status] = [mark.warn, p.dim(`(${r.candidates.length} EH employees match)`), p.change("pick one")];
    else if (r.candidates.length === 1) {
      const k = r.candidates[0];
      [m, ehCol, status] = [mark.warn, p.change(`${cut(name(k.eh), nameW)} ?`) + p.dim(` ${k.eh.id}`), p.change(k.reason)];
    } else [m, ehCol, status] = [pad(p.dim("–"), MW), p.dim("(no match: new hire)"), p.dim("new hire")];
    lines.push(`${String(i + 1).padStart(numW - 2)}) ${m} ${p.ct(pad(cut(name(r.ct), nameW), nameW))} ${pad(r.ct.email, emailW)} → ${pad(ehCol, nameW + 7)} ${status}`);
  }
  return lines;
}

function dCounts() {
  const linked = dRows.filter((r) => linkOf(r)).length;
  const toCheck = dRows.filter(unsettled).length;
  const newH = dRows.length - linked - toCheck;
  return { linked, toCheck, newH, text: `${p.ok(`${linked} to link`)} · ${p.change(`${toCheck} to check`)} · ${newH} new hires / not linked` };
}

/** The picker: likely EH employees first, then search all of EH by name or email. */
async function dPick(i: number) {
  const r = dRows[i];
  const show = (list: EhRec[], why: (e: EhRec) => string) =>
    list.forEach((e, k) => {
      const nm = name(e) !== name(r.ct) ? p.change(name(e)) : p.eh(name(e));
      const em = e.email !== r.ct.email ? p.change(e.email) : e.email;
      const st = e.terminated ? p.change("Terminated") : p.dim("Active");
      const pid = e.payrollId ? `  ${p.change(`Payroll ID ${e.payrollId}`)}` : "";
      const other = linkedRow(e);
      const taken = other >= 0 && other !== i ? `  ${p.dim(`linked to row ${other + 1}`)}` : "";
      console.log(`    ${k + 1}) ${nm}   ${em}   ${p.eh(`EH ${e.id}`)}   ${st}${pid}${taken}${why(e) ? `\n       ${mark.warn} ${why(e)}` : ""}`);
    });
  let list: EhRec[] = r.proposed ? [r.proposed] : r.candidates.map((k) => k.eh);
  let heading = list.length ? "Likely" : "No likely match";
  for (;;) {
    clear();
    console.log(`${p.bold(`Row ${i + 1}`)}   ${p.ct(name(r.ct))}   ${r.ct.email}\n`);
    console.log(`  ${p.eh(heading)}`);
    show(list, (e) => r.candidates.find((k) => k.eh.id === e.id)?.reason ?? "");
    console.log(`    0) Don't link ${p.dim("- they'll be checked again when you approve them")}\n`);
    const a = await ask(`  Number to choose, or type part of a name or email to search all ${allEh.length} Employment Hero employees (Enter keeps it as is): `);
    if (a === "") return;
    const n = Number(a);
    if (a === "0") return void ((r.choice = null), (r.note = "won't link"));
    if (Number.isInteger(n) && n >= 1 && n <= list.length) {
      const e = list[n - 1], other = linkedRow(e);
      if (other >= 0 && other !== i) {
        const y = await ask(`  ${p.eh(`EH ${e.id}`)} is linked to row ${other + 1} (${p.ct(name(dRows[other].ct))}). Move it here? [y/N] `, "n");
        if (y.toLowerCase() !== "y") continue;
        dRows[other].choice = null;
        dRows[other].note = `moved to row ${i + 1}`;
      }
      r.choice = e;
      r.note = "changed";
      return;
    }
    const q = a.toLowerCase();
    const hits = allEh.filter((e) => name(e).toLowerCase().includes(q) || e.email.toLowerCase().includes(q)).slice(0, 10);
    list = hits;
    heading = hits.length ? `Search "${a}": ${hits.length === 10 ? "first 10" : hits.length} found` : `Search "${a}": nothing found, try fewer letters`;
  }
}

async function variantD() {
  const perPage = Math.max(5, H() - 7);
  for (;;) {
    for (let from = 0; ; from += perPage) {
      const to = Math.min(dRows.length, from + perPage);
      clear();
      console.log([summary()[0], "", ...dTable(from, to), "", dCounts().text + p.dim(`   rows ${from + 1}–${to} of ${dRows.length}`), ""].join("\n"));
      const { toCheck } = dCounts();
      const more = to < dRows.length;
      const a = (
        await ask(
          (toCheck ? `Check the ${toCheck} now? [Y / number to change a row / ` : "Everything's in place. [Enter to finish / number to change a row / ") +
            (more ? "Enter for more / " : "") + "done] ",
          more ? "" : toCheck ? "done" : "",
        )
      ).toLowerCase();
      if (a === "done" || (!more && !toCheck && a === "")) return;
      if (a === "" && more) continue;
      if (a === "y" || a === "") {
        for (let i = 0; i < dRows.length; i++) if (unsettled(dRows[i])) await dPick(i);
        break;
      }
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= dRows.length) {
        await dPick(n - 1);
        from -= perPage; // redraw this page
      }
      if (to >= dRows.length) break;
    }
  }
}

function dFinal() {
  const { linked, toCheck, newH } = dCounts();
  clear();
  console.log(
    [
      p.bold("Done") + p.dim("   (prototype: nothing written)"),
      "",
      `  ${mark.ok} ${linked} pending links would be saved`,
      `  ${mark.warn} ${toCheck} left unchecked - not linked, checked again on approval`,
      `  ${newH} new hires / won't link · ${data.ehOnly} EH-only ignored`,
      "",
      p.dim(`  changed rows: ${dRows.flatMap((r, i) => (r.choice !== undefined ? [`${i + 1}${r.choice ? `→EH ${r.choice.id}` : "→don't link"}`] : [])).join(", ") || "none"}`),
    ].join("\n"),
  );
}

// ── run, `v` restarts on the next variant ───────────────────────────────────
for (;;) {
  dropped.clear();
  chosen.clear();
  for (const r of dRows) (r.choice = undefined), (r.note = undefined);
  try {
    await { A: variantA, B: variantB, C: variantC, D: variantD }[variant]();
    if (variant === "D") dFinal();
    else finalState();
    break;
  } catch (e) {
    if (!(e instanceof SwitchVariant)) throw e;
    variant = VARIANTS[(VARIANTS.indexOf(variant) + 1) % VARIANTS.length];
  }
}
rl?.close();
