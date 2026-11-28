/**
 * The link stage's full-screen list (#154, variant E of #137): the state the
 * keys change and the frame drawn from it. Pure - the script owns the terminal
 * (raw mode, the alternate screen) and feeds keys in.
 */
import { ansiParts, palette, stripAnsi, visibleWidth, wrap, type Palette } from "./terminal-text.js";
import type { LinkDecision } from "./link-changes.js";
import type { DifferingDetail } from "./link-details.js";
import { payrollIdKey } from "./preflight.js";
import type { ChoiceReason, LinkCandidate, LinkCtUser, LinkEhEmployee, LinkList, LinkListInput, LinkRow, PackStatus } from "./link-list.js";

export interface LinkScreenPeople {
  ct: ReadonlyMap<number, LinkCtUser>;
  eh: ReadonlyMap<string, LinkEhEmployee>;
}

/** The people the screen shows, by id, from the link list's input. */
export function linkScreenPeople(input: Pick<LinkListInput, "ctUsers" | "ehEmployees">): LinkScreenPeople {
  return {
    ct: new Map(input.ctUsers.map((u) => [u.ctUserId, u])),
    eh: new Map(input.ehEmployees.map((e) => [e.id, e])),
  };
}

/** The terminal the frame is drawn for. */
export interface LinkScreenSize {
  columns: number;
  rows: number;
  color: boolean;
  /** The terminal's background, when it says (COLORFGBG): the highlight bar is black only on a light one. */
  background?: "light" | "dark";
}

/** What the screen can ask beyond the list itself. */
export interface LinkScreenOptions {
  /**
   * The details that differ between a Connecteam user's mapped pack and an EH
   * employee's record, by name (#225). Without it, no details are compared.
   */
  details?(ctUserId: number, ehEmployeeId: string): readonly DifferingDetail[];
}

/** A keypress as readline's `keypress` event gives it. */
export interface LinkKey {
  name?: string;
  ctrl?: boolean;
}

/** The reasons that stop a link outright: the EH employee is someone else's, or gone. */
const UNLINKABLE: readonly ChoiceReason[] = ["linkedElsewhere", "goneFromEh"];
/** A candidate the admin can link. */
const linkable = (c: LinkCandidate) => !c.reasons.some((x) => UNLINKABLE.includes(x));

/** A link saved on an earlier run that can no longer be made: its EH employee is someone else's, or gone. */
const savedButUnlinkable = (r: LinkRow) => r.kind === "onLinkList" && r.candidates.some((c) => !linkable(c));

/**
 * The link a row has before the admin touches it: its match, or what an
 * earlier run saved - unless that can no longer be made, when it comes off.
 */
function proposed(r: LinkRow): LinkDecision {
  if (r.kind === "matched" || (r.kind === "onLinkList" && !savedButUnlinkable(r))) {
    return { ctUserId: r.ctUserId, onList: true, ehEmployeeId: r.suggestion };
  }
  return { ctUserId: r.ctUserId, onList: false };
}

/** What a row's number keys pick, in order: null is "New hire, not this person". */
function choicesOf(r: LinkRow): (LinkCandidate | null)[] {
  return [...r.candidates.filter(linkable), ...(r.newHireChoice ? [null] : [])];
}

const SEARCH_HITS = 8;
/** Rows PgUp / PgDn move. */
const PAGE = 10;
/** The list's email column: up to 34, down to 12 to leave room for Status (the panel shows emails in full). */
const EMAIL_W = { max: 34, min: 12 };
const PACK_W = 20;

/** Most urgent first: approved syncs at the next sweep, ready for review is next. */
const PACK_URGENCY: readonly PackStatus[] = ["approvedNotSynced", "readyForReview", "inProgress", "notAssigned"];

const PACK_LABEL: Record<PackStatus, string> = {
  notAssigned: "Not assigned",
  inProgress: "In progress",
  readyForReview: "Ready for review",
  approvedNotSynced: "Approved, not synced",
};

const REASON: Record<ChoiceReason, string> = {
  nameDiffers: "name differs",
  sameEmailSeveral: "same email on several records",
  nameOnly: "same name only",
  hasPayrollId: "already has a Payroll ID",
  terminated: "terminated in EH",
  linkedElsewhere: "linked to someone else",
  goneFromEh: "no longer in EH",
  payrollIdShared: "Payroll ID shared in Connecteam",
};

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

/** A line cut to `w` visible characters, colour codes kept intact and closed. */
function fit(s: string, w: number): string {
  if (visibleWidth(s) <= w) return s;
  let out = "";
  let seen = 0;
  for (const part of ansiParts(s)) {
    if (part.startsWith("\u001b")) out += part;
    else {
      out += part.slice(0, Math.max(0, w - 1 - seen));
      seen += part.length;
      if (seen >= w - 1) break;
    }
  }
  return `${out}…${s.includes("\u001b") ? "\u001b[0m" : ""}`;
}

const fullName = (first: string, last: string) => `${first} ${last}`.trim();

/** The day a pair was confirmed, as the admin's terminal reads it: "10 Nov 2026". */
const confirmedOn = (ms: number) => new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** A pop-up's line: text, or text drawn as the full-width highlight bar. */
type Body = string | { text: string; bar: boolean };

/**
 * The highlight bar (#222): a fixed bar with bright white bold text, the
 * marks on it kept in their meaning colours. Black on a light terminal (the
 * developer's pick), grey on a dark one or one that doesn't say. Without
 * colour, the ▶ / > pointer is the cue.
 */
const BAR = { light: "\u001b[1;97;40m", dark: "\u001b[1;97;100m" } as const;
const BAR_MARKS: Record<string, string> = { "▶": "96", "●": "96", "○": "37", "✓": "92", "⚠": "93", "✗": "91" };
/**
 * `s` as the highlight bar, `w` wide. A black bar can't be seen on a dark
 * terminal, and most terminals don't say which they are, so it's grey
 * (which reads on either) unless the terminal reports a light background.
 */
function highlight(s: string, w: number, size: Pick<LinkScreenSize, "color" | "background">): string {
  if (!size.color) return pad(s, w);
  const text = pad(stripAnsi(s), w).replace(/[▶●○✓⚠✗]/g, (m) => `\u001b[${BAR_MARKS[m]}m${m}\u001b[97m`);
  return `${BAR[size.background === "light" ? "light" : "dark"]}${text}\u001b[0m`;
}

/** A bordered box: a title on the top edge, the body, and an optional footer under a rule. */
function box(p: Palette, size: Pick<LinkScreenSize, "color" | "background">, title: string, body: readonly Body[], footer: readonly string[] = [], minW = 0): string[] {
  const B = size.color
    ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", ml: "+", mr: "+" };
  const textOf = (l: Body) => (typeof l === "string" ? l : l.text);
  const inner = Math.max(minW, visibleWidth(title) + 4, ...[...body, ...footer].map((l) => visibleWidth(textOf(l)) + 4));
  const line = (l: Body) =>
    typeof l !== "string" && l.bar ? `${FOCUS}${B.v} ${highlight(` ${l.text}`, inner - 2, size)} ${B.v}` : `${B.v}  ${pad(textOf(l), inner - 4)}  ${B.v}`;
  const t = ` ${p.bold(title)} `;
  return [
    `${B.tl}${B.h}${t}${B.h.repeat(Math.max(0, inner - 1 - visibleWidth(t)))}${B.tr}`,
    ...body.map(line),
    ...(footer.length ? [`${B.ml}${B.h.repeat(inner)}${B.mr}`, ...footer.map(line)] : []),
    `${B.bl}${B.h.repeat(inner)}${B.br}`,
  ];
}

/**
 * Marks the line the highlight bar is on, so a tall pop-up scrolls to keep it
 * in view. A no-op colour code, so it has no width; taken out before drawing.
 */
const FOCUS = "\u001b[29m";

/**
 * A pop-up cut to the terminal's height: its title edge and its last
 * `footer` lines (the keys) stay, and the lines between scroll to keep the
 * bar in view, with "↑ n more" / "↓ n more" where lines are hidden.
 */
function scrolled(pop: readonly string[], rows: number, footer: number, size: LinkScreenSize): string[] {
  if (pop.length <= rows) return [...pop];
  const p = palette(size.color);
  const v = size.color ? "│" : "|";
  const inner = visibleWidth(pop[0]!) - 2;
  const more = (s: string) => `${v}  ${pad(p.dim(s), inner - 4)}  ${v}`;
  const middle = pop.slice(1, pop.length - footer);
  const h = Math.max(1, rows - 1 - footer);
  const focus = Math.max(0, middle.findIndex((l) => l.includes(FOCUS)));
  const start = Math.max(0, Math.min(middle.length - h, focus - Math.floor(h / 2)));
  const shown = middle.slice(start, start + h);
  if (start > 0) shown[0] = more(`↑ ${start + 1} more`);
  const below = middle.length - (start + h);
  if (below > 0) shown[shown.length - 1] = more(`↓ ${below + 1} more`);
  return [pop[0]!, ...shown, ...pop.slice(pop.length - footer)];
}

/** A pop-up laid over the screen, centred, with everything behind it dimmed. */
function overlay(screen: readonly string[], tall: readonly string[], size: LinkScreenSize, footer = 3): string[] {
  const p = palette(size.color);
  const pop = scrolled(tall, size.rows, footer, size).map((l) => l.split(FOCUS).join(""));
  const out = screen.map((l) => p.dim(stripAnsi(l)));
  while (out.length < size.rows) out.push("");
  const top = Math.max(0, Math.floor((size.rows - pop.length) / 2));
  const left = " ".repeat(Math.max(0, Math.floor((size.columns - visibleWidth(pop[0] ?? "")) / 2)));
  pop.forEach((l, k) => {
    if (top + k < out.length) out[top + k] = fit(left + l, size.columns);
  });
  return out.slice(0, size.rows);
}

export function createLinkScreen(list: LinkList, people: LinkScreenPeople, options: LinkScreenOptions = {}) {
  const { rows } = list;
  /** What the admin chose, by row index; a row not here keeps its proposal. */
  const chosen = new Map<number, LinkDecision>();
  /** Rows whose link the admin moved to another row, with what `u` on that row puts back. */
  const movedTo = new Map<number, { to: number; ehEmployeeId: string; was: LinkDecision | undefined; wasInReview: boolean }>();
  /** An EH employee linked to another row, waiting on a second Enter to move here. */
  let pendingMove: string | null = null;
  let cursor = 0;
  /** The first list row on screen. */
  let top = 0;
  let showAll = false;
  let confirming = false;
  let searching = false;
  let query = "";
  let hits: string[] = [];
  let hit = 0;

  let byPack = false;

  /** The Edit pop-up (#225): the row it's for and the option under the bar. */
  let editing: { i: number; at: number } | null = null;
  /** Units picked Use Connecteam's, by row. */
  const picks = new Map<number, Set<string>>();
  /** Rows with a pick made in the Edit pop-up this run: their Baseline is taken again. */
  const edited = new Set<number>();
  /** Rows whose Edit pop-up was opened: reviewed. */
  const opened = new Set<number>();

  const visible = () => {
    const v = showAll ? rows.map((_, i) => i) : [...review].sort((a, b) => a - b);
    return byPack ? v.sort((a, b) => PACK_URGENCY.indexOf(rows[a]!.pack) - PACK_URGENCY.indexOf(rows[b]!.pack) || a - b) : v;
  };
  const nextUnreviewed = () => {
    const v = visible();
    for (let k = 1; k <= v.length; k++) {
      const j = (cursor + k) % v.length;
      if (!isReviewed(v[j]!)) return j;
    }
    return Math.min(cursor + 1, v.length - 1);
  };
  /** The link a row will save: the admin's choice, else off once its link moved to another row, else its proposal. */
  const linkDecision = (i: number): LinkDecision =>
    chosen.get(i) ?? (movedTo.has(i) ? { ctUserId: rows[i]!.ctUserId, onList: false } : proposed(rows[i]!));
  /** What a row will save: its link, with the Edit pop-up's picks once any were made. */
  const decision = (i: number): LinkDecision => {
    const d = linkDecision(i);
    if (!d.onList || d.ehEmployeeId === null || !edited.has(i)) return d;
    return { ...d, details: { useConnecteam: sentFromConnecteam(i).map((x) => x.unit) } };
  };
  /** The EH employee row i will be linked to, or null. */
  const linkedEh = (i: number): string | null => {
    const d = linkDecision(i);
    return d.onList ? d.ehEmployeeId : null;
  };
  /** Row i's differing details picked Use Connecteam's, in the order they're listed. */
  const sentFromConnecteam = (i: number): readonly DifferingDetail[] => detailsOf(i).filter((d) => picks.get(i)?.has(d.unit));
  /** The details that differ for row i and the EH employee it's linked to. */
  const detailsOf = (i: number): readonly DifferingDetail[] => {
    const eh = linkedEh(i);
    return eh === null || !options.details ? [] : options.details(rows[i]!.ctUserId, eh);
  };
  /** EH's External ID on that EH employee against row i's Payroll ID, as EH compares them. */
  const externalIdOf = (i: number, ehEmployeeId: string): "blank" | "matches" | "differs" => {
    const theirs = people.eh.get(ehEmployeeId)?.externalId?.trim() ?? "";
    if (!theirs) return "blank";
    const ours = people.ct.get(rows[i]!.ctUserId)?.payrollId ?? String(rows[i]!.ctUserId);
    return payrollIdKey(theirs) === payrollIdKey(ours.trim()) ? "matches" : "differs";
  };
  /** A pair whose details differ and whose choices weren't made with a Baseline yet. */
  const detailsUnchosen = (i: number) => detailsOf(i).length > 0 && rows[i]!.saved?.hasBaseline !== true;
  /**
   * Exactly the rows needing a decision (#224): not linked yet, a saved link
   * the link step would refuse, an External ID that doesn't match, or details
   * that differ with no choice made.
   */
  const needsReview = (i: number): boolean => {
    const r = rows[i]!;
    if (r.kind === "choice" || r.kind === "held" || r.kind === "taken") return true;
    if (r.kind === "onLinkList" && (savedButUnlinkable(r) || r.wouldBlock !== undefined)) return true;
    const eh = linkedEh(i);
    return eh !== null && (externalIdOf(i, eh) === "differs" || detailsUnchosen(i));
  };
  const review = new Set(rows.flatMap((_, i) => (needsReview(i) ? [i] : [])));
  /** Seen this run: a link chosen, or the Edit pop-up opened. */
  const isReviewed = (i: number) => chosen.has(i) || opened.has(i);
  const reviewed = () => [...review].filter(isReviewed).length;

  /** A row whose pair can be edited: it's linked to an EH employee it can be linked to. */
  const canEdit = (i: number) => linkedEh(i) !== null && !savedButUnlinkable(rows[i]!);
  /** The Edit pop-up's options, top to bottom: Keep EH's, then Use Connecteam's, for each differing detail. */
  const editOptions = (i: number) => detailsOf(i).flatMap((d) => [{ unit: d.unit, use: false }, { unit: d.unit, use: true }]);
  const openEdit = (i: number) => {
    editing = { i, at: 0 };
    opened.add(i);
  };
  /** A key while the Edit pop-up is open: ↑↓ move, Enter picks, Esc or Backspace goes back with the picks kept. */
  const editKey = (key: LinkKey) => {
    const e = editing!;
    const options = editOptions(e.i);
    if (key.name === "escape" || key.name === "backspace") editing = null;
    else if (key.name === "up") e.at = Math.max(0, e.at - 1);
    else if (key.name === "down") e.at = Math.max(0, Math.min(options.length - 1, e.at + 1));
    else if (key.name === "return") {
      const o = options[e.at];
      if (!o) return;
      const set = picks.get(e.i) ?? new Set<string>();
      if (o.use) set.add(o.unit);
      else set.delete(o.unit);
      picks.set(e.i, set);
      edited.add(e.i);
    }
  };
  /** The row an EH employee is linked to now, or -1. */
  const linkedRow = (ehEmployeeId: string) =>
    rows.findIndex((_, i) => {
      const d = decision(i);
      return d.onList && d.ehEmployeeId === ehEmployeeId;
    });
  /** An EH employee who belongs to a Connecteam user other than row i's: never linkable. */
  const ownedElsewhere = (i: number, ehEmployeeId: string) => {
    const owner = list.ehOwners.get(ehEmployeeId);
    return owner !== undefined && owner !== rows[i]!.ctUserId;
  };
  /** Links row i, or asks first when the EH employee is linked to another row. False until it's done. */
  const link = (i: number, ehEmployeeId: string | null): boolean => {
    if (ehEmployeeId !== null && ownedElsewhere(i, ehEmployeeId)) return false;
    const other = ehEmployeeId === null ? -1 : linkedRow(ehEmployeeId);
    if (ehEmployeeId !== null && other >= 0 && other !== i) {
      if (pendingMove !== ehEmployeeId) {
        pendingMove = ehEmployeeId;
        return false;
      }
      movedTo.set(other, { to: i, ehEmployeeId, was: chosen.get(other), wasInReview: review.has(other) });
      chosen.delete(other);
      review.add(other);
    }
    pendingMove = null;
    chosen.set(i, { ctUserId: rows[i]!.ctUserId, onList: true, ehEmployeeId });
    if (!showAll) cursor = nextUnreviewed();
    // The pair's next step: its choices, when it has any (#225).
    if (ehEmployeeId !== null && detailsOf(i).length) openEdit(i);
    return true;
  };

  /**
   * Puts row i back the way it was, giving back any link that was moved here -
   * unless it has since moved on, so no EH employee is ever linked twice.
   */
  const undo = (i: number) => {
    chosen.delete(i);
    for (const [from, m] of movedTo) {
      if (m.to !== i || linkedRow(m.ehEmployeeId) >= 0) continue;
      movedTo.delete(from);
      if (m.was) chosen.set(from, m.was);
      if (!m.wasInReview) review.delete(from);
    }
  };

  /** The selected row's number keys and Enter: link the choice they pick. */
  const choose = (i: number, str: string | undefined, key: LinkKey) => {
    const choices = choicesOf(rows[i]!);
    const n = key.name === "return" ? (choices.length === 1 ? 0 : -1) : str && /^[1-9]$/.test(str) ? Number(str) - 1 : -1;
    const c = choices[n];
    if (c !== undefined) link(i, c?.ehEmployeeId ?? null);
  };

  /** EH employees whose name or email holds the query, at least two characters of it. */
  const search = (i: number): string[] => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const u = people.ct.get(rows[i]!.ctUserId);
    const own = u ? fullName(u.firstName, u.lastName).toLowerCase() : "";
    // Closest first: this person's name, then anyone not linked to another row.
    const rank = (e: LinkEhEmployee) => {
      const other = linkedRow(e.id);
      const taken = (other >= 0 && other !== i) || ownedElsewhere(i, e.id);
      return (fullName(e.firstName, e.surname).toLowerCase() === own ? 0 : 2) + (taken ? 1 : 0);
    };
    return [...people.eh.values()]
      .filter((e) => fullName(e.firstName, e.surname).toLowerCase().includes(q) || (e.email ?? "").toLowerCase().includes(q))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, SEARCH_HITS)
      .map((e) => e.id);
  };
  const searchKey = (i: number, str: string | undefined, key: LinkKey) => {
    if (key.name === "escape") searching = false;
    else if (key.name === "up") hit = Math.max(0, hit - 1);
    else if (key.name === "down") hit = Math.min(hits.length - 1, hit + 1);
    else if (key.name === "return") {
      const id = hits[hit];
      if (id !== undefined && link(i, id)) searching = false;
    } else {
      if (key.name === "backspace") query = query.slice(0, -1);
      else if (str && str.length === 1 && str >= " ") query += str;
      hits = search(i);
      hit = 0;
    }
  };

  /** The list's columns, sized for the terminal and the rows shown: its headings and one line per row. */
  const columns = (size: LinkScreenSize, shown: readonly number[]) => {
    const p = palette(size.color);
    const numW = String(rows.length).length;
    const nameW = Math.max(10, Math.min(22, Math.floor((size.columns - 90) / 2)));
    const ehName = (id: string) => {
      const e = people.eh.get(id);
      return e ? fullName(e.firstName, e.surname) : `EH ${id}`;
    };

    /** What a linked pair's Status adds (#225): a link that would block, the External ID, the details. */
    const linkNotes = (i: number, ehEmployeeId: string): string[] => {
      const notes: string[] = [];
      const r = rows[i]!;
      if (r.wouldBlock === "payroll-id-elsewhere") notes.push(p.bad("link will be blocked: Payroll ID on another EH employee"));
      if (externalIdOf(i, ehEmployeeId) === "differs") notes.push(p.bad("EH External ID doesn't match · held at approval"));
      if (detailsUnchosen(i) || (edited.has(i) && detailsOf(i).length)) {
        const n = detailsOf(i).length;
        const k = sentFromConnecteam(i).length;
        notes.push(p.change(`${n} detail${n === 1 ? " differs" : "s differ"} · ${k ? `${k} from Connecteam` : "all EH's kept"}`));
      }
      return notes;
    };

    /** The mark, Employment Hero column and status for one row. */
    const cells = (i: number): [string, string, string] => {
      const r = rows[i]!;
      const d = decision(i);
      const mine = chosen.get(i);
      const linked = (id: string, status: string): [string, string, string] => [
        p.mark.ok,
        `${p.eh(cut(ehName(id), nameW))} ${p.dim(id)}`,
        status,
      ];
      if (mine && !mine.onList) return [p.mark.none, p.dim("(won't link)"), p.change("won't link")];
      if (mine?.onList) {
        if (mine.ehEmployeeId === null) return [p.mark.none, p.dim("(none)"), p.change("new hire, not this person")];
        return linked(mine.ehEmployeeId, [p.change("linked"), ...linkNotes(i, mine.ehEmployeeId)].join(p.dim(" · ")));
      }
      const moved = movedTo.get(i);
      if (moved !== undefined) {
        // Wherever it is now: it may have moved on since.
        const holder = linkedRow(moved.ehEmployeeId);
        return [p.mark.warn, p.dim("(none)"), p.change(`match moved to row ${(holder >= 0 ? holder : moved.to) + 1}`)];
      }
      if (r.kind === "taken") return [p.mark.bad, p.dim("(none)"), p.bad("Can't link: already linked to someone else")];
      if (r.kind === "alreadySynced") return linked(r.suggestion!, p.dim("already matched by Payroll ID"));
      if (r.kind === "newHire") return [p.mark.none, p.dim("(no match)"), p.dim("new hire")];
      const problem = r.candidates.flatMap((c) => c.reasons);
      // A pair linked by its match or an earlier run: its Status is what it still needs, if anything.
      if (d.onList && d.ehEmployeeId !== null && (r.kind === "matched" || r.kind === "onLinkList")) {
        const notes = linkNotes(i, d.ehEmployeeId);
        const terminated = problem.includes("terminated") ? [p.dim(REASON.terminated)] : [];
        const [mark, ehCol] = linked(d.ehEmployeeId, "");
        if (notes.length) return [p.mark.warn, ehCol, notes.join(p.dim(" · "))];
        return [mark, ehCol, [p.dim(r.kind === "matched" ? "matched by email" : "on the Link list"), ...terminated].join(p.dim(" · "))];
      }
      if (d.onList && !problem.length) {
        if (d.ehEmployeeId === null) return [p.mark.none, p.dim("(none)"), p.dim("new hire, not this person")];
        return linked(d.ehEmployeeId, p.dim(r.kind === "matched" ? "matched by email" : "on the Link list"));
      }
      const several = r.candidates.length > 1;
      const ehCol = several ? p.dim(`(${r.candidates.length} EH employees)`) : r.candidates[0] ? p.change(`${cut(ehName(r.candidates[0].ehEmployeeId), nameW)} ?`) : p.dim("(none)");
      if (savedButUnlinkable(r)) {
        const why = [...new Set(problem.filter((x) => UNLINKABLE.includes(x)))].map((x) => REASON[x]);
        return [p.mark.warn, ehCol, p.change(`saved link will be removed: ${why.join(", ")}`)];
      }
      if (r.kind === "held") {
        const what = several ? `${r.candidates.length} EH employees` : r.candidates[0] ? `EH ${r.candidates[0].ehEmployeeId}` : "EH";
        return [p.mark.warn, ehCol, p.change(`held on approval: matches ${what}`)];
      }
      return [p.mark.warn, ehCol, p.change(several ? "pick one" : [...new Set(problem)].map((x) => REASON[x]).join(", "))];
    };
    const packCell = (pk: PackStatus) =>
      pad(pk === "readyForReview" ? p.change(PACK_LABEL[pk]) : pk === "approvedNotSynced" ? p.bad(PACK_LABEL[pk]) : p.dim(PACK_LABEL[pk]), PACK_W);
    const statusW = Math.max(6, ...shown.map((i) => visibleWidth(cells(i)[2])));
    const fixedW = 2 + numW + 1 + p.markWidth + 1 + nameW + 1 + 3 + nameW + 7 + 1 + PACK_W + 1;
    const emailW = Math.max(EMAIL_W.min, Math.min(EMAIL_W.max, size.columns - fixedW - statusW));
    const heading = (label: string, w: number, colour: (s: string) => string = (x) => x) => p.bold(colour(pad(cut(label, w), w)));
    const headings = [
      `  ${"#".padStart(numW)} ${" ".repeat(p.markWidth)} ${heading("Connecteam user", nameW, p.ct)} ${heading("Connecteam email", emailW, p.ct)}   ${heading("Employment Hero match", nameW + 7, p.eh)} ${heading("Pack", PACK_W)} ${p.bold("Status")}`,
    ];
    const line = (i: number, selected: boolean) => {
      const u = people.ct.get(rows[i]!.ctUserId);
      const [m, ehCol, status] = cells(i);
      const name = p.ct(pad(cut(u ? fullName(u.firstName, u.lastName) : `Connecteam ${rows[i]!.ctUserId}`, nameW), nameW));
      const ptr = selected ? (size.color ? p.ct("▶") : ">") : " ";
      return `${ptr} ${String(i + 1).padStart(numW)} ${pad(m, p.markWidth)} ${selected ? p.bold(name) : name} ${pad(cut(u?.email ?? "", emailW), emailW)} → ${pad(ehCol, nameW + 7)} ${packCell(rows[i]!.pack)} ${status}`;
    };
    return { p, headings, line };
  };

  /** The Edit pop-up for one pair (#225, #222 variant A): who, then 1 EH External ID and 2 Details. */
  const editPopup = (e: { i: number; at: number }, p: Palette, size: LinkScreenSize): string[] => {
    const r = rows[e.i]!;
    const ehId = linkedEh(e.i)!;
    const u = people.ct.get(r.ctUserId);
    const eh = people.eh.get(ehId);
    const label = (s: string) => p.dim(pad(s, 20));
    const ptr = (on: boolean) => (on ? (size.color ? p.ct("▶") : ">") : " ");
    const radio = (on: boolean) => (size.color ? (on ? p.ct("●") : p.dim("○")) : on ? "(x)" : "( )");

    const payrollId = u?.payrollId.trim() ?? String(r.ctUserId);
    const idName = payrollId === String(r.ctUserId) ? "Connecteam User ID" : "Connecteam Payroll ID";
    const theirs = eh?.externalId?.trim() || null;
    const idState = externalIdOf(e.i, ehId);
    const idBody = [
      `${label("EH External ID")}${theirs === null ? p.dim("(blank)") : p.eh(theirs)}${theirs !== null && theirs === ehId ? `   ${p.mark.warn} ${p.change("this is their EH Employee ID")}` : ""}`,
      `${label(idName)}${p.ct(payrollId)}`,
      "",
      idState === "blank"
        ? `${p.mark.ok} ${p.ok(`Blank in EH: it'll be set to their ${idName}.`)}`
        : idState === "matches"
          ? `${p.mark.ok} ${p.ok("They match. Nothing to choose.")}`
          : `${p.mark.bad} ${p.bad("They don't match: they're held at approval.")}`,
    ];

    const details = detailsOf(e.i);
    const options = editOptions(e.i);
    const detailBody: Body[] = [];
    // A stored Baseline is kept unless a pick here takes it again (#224).
    const at = r.saved?.hasBaseline && r.saved.confirmedAt !== undefined ? confirmedOn(r.saved.confirmedAt) : null;
    if (at) {
      detailBody.push(
        `${p.mark.warn} ${p.change(`Confirmed ${at}: changes since then are sent at the link.`)}`,
        p.change(`  A pick here takes the Baseline again: changes since ${at} are decided here, not sent.`),
        "",
      );
    }
    if (!details.length) detailBody.push(`${p.mark.ok} ${p.ok("All the same in both. Nothing to choose.")}`);
    else {
      detailBody.push(p.dim("These differ between Connecteam and EH. Values aren't shown."));
      for (const d of details) {
        const named = d.fields.length === 1 && d.fields[0] === d.label ? d.label : `${d.label} (${d.fields.join(", ")})`;
        detailBody.push("", p.bold(named));
        const useCt = picks.get(e.i)?.has(d.unit) ?? false;
        for (const use of [false, true]) {
          const k = options.findIndex((o) => o.unit === d.unit && o.use === use);
          const on = k === e.at;
          const picked = use === useCt;
          const text = use ? "Use Connecteam's" : "Keep EH's";
          detailBody.push({ text: `  ${ptr(on)} ${radio(picked)} ${picked ? p.bold(text) : text}`, bar: on });
        }
      }
    }

    const sent = sentFromConnecteam(e.i);
    const n = details.length;
    const sectionW = Math.max(56, ...[...idBody, ...detailBody].map((l) => visibleWidth(typeof l === "string" ? l : l.text) + 4));
    return box(
      p,
      size,
      `Edit · ${u ? fullName(u.firstName, u.lastName) : `Connecteam ${r.ctUserId}`}`,
      [
        `${label("Connecteam user")}${p.ct(u ? fullName(u.firstName, u.lastName) : "")}  ${p.dim(u?.email ?? "(no email)")}`,
        `${label("Employment Hero")}${p.eh(eh ? fullName(eh.firstName, eh.surname) : "")}  ${p.dim(`EH Employee ID ${ehId}`)}`,
        "",
        ...box(p, size, "1  EH External ID", idBody, [], sectionW),
        "",
        ...box(p, size, `2  Details${n ? ` (${n === 1 ? "1 differs" : `${n} differ`})` : ""}`, detailBody, [], sectionW),
        "",
        p.dim(`Link notice will say: ${sent.length ? `Sent from Connecteam: ${sent.map((d) => d.label).join(", ")}` : "(just linked)"}`),
      ],
      [`${p.bold("↑↓")} ${p.dim("move")}     ${p.bold("Enter")} ${p.dim("pick")}     ${p.bold("Esc / Backspace")} ${p.dim("done, back to the list")}`],
    );
  };

  /**
   * The "Save these links?" pop-up (#222 item 8): what the save does, in
   * counts. Held people are counted, not blocking: leaving them held is a
   * choice the Edit pop-up shows.
   */
  const savePopup = (p: Palette, size: LinkScreenSize): string[] => {
    const all = rows.map((_, i) => i);
    const ds = all.map(decision);
    const linked = all.filter((i) => linkedEh(i) !== null);
    const toLink = linked.length;
    const wont = all.filter((i) => chosen.get(i)?.onList === false).length;
    const newHires = all.filter((i) => {
      const d = ds[i]!;
      return d.onList ? d.ehEmployeeId === null : rows[i]!.kind === "newHire" && !chosen.has(i);
    }).length;
    /** Still the pair an earlier run saved, with nothing picked this run. */
    const asSaved = (i: number) => rows[i]!.saved !== undefined && linkedEh(i) === rows[i]!.suggestion && !edited.has(i);
    const reconfirmed = linked.filter((i) => asSaved(i) && !rows[i]!.saved!.hasBaseline).length;
    const held = linked.filter((i) => externalIdOf(i, linkedEh(i)!) === "differs" || (asSaved(i) && rows[i]!.wouldBlock === "payroll-id-elsewhere")).length;
    // Choices are made now for every pair whose Baseline this save takes: all but a stored one kept.
    const choosing = linked.filter((i) => !(asSaved(i) && rows[i]!.saved!.hasBaseline));
    const sent = new Map<string, number>();
    for (const i of choosing) for (const d of sentFromConnecteam(i)) sent.set(d.label, (sent.get(d.label) ?? 0) + 1);
    const kept = choosing.reduce((n, i) => n + detailsOf(i).length - sentFromConnecteam(i).length, 0);
    // Not reviewed: a saved link that's still possible stays as it was; anyone else is left unlinked.
    const unreviewed = [...review].filter((i) => !isReviewed(i));
    const keptAsSaved = unreviewed.filter((i) => ds[i]!.onList).length;
    const left = unreviewed.length - keptAsSaved;

    const label = (s: string) => p.dim(pad(s, 30));
    const count = (n: number, colour: (s: string) => string) => (n ? colour(String(n)) : "0");
    return box(
      p,
      size,
      "Save these links?",
      [
        `${label("To link")}${p.ok(String(toLink))}`,
        `${label("New hires")}${newHires}`,
        ...(wont ? [`${label("Won't link")}${p.change(String(wont))}`] : []),
        `${label("Re-confirmed")}${reconfirmed}${reconfirmed ? p.dim("  (saved before Baselines: one is taken now)") : ""}`,
        "",
        `${label("Held at approval")}${count(held, p.bad)}${held ? p.dim("  (EH External ID doesn't match, or the link would be blocked)") : ""}`,
        "",
        `${label("Sent from Connecteam at link")}${sent.size ? p.change([...sent].map(([d, n]) => (n > 1 ? `${d} ×${n}` : d)).join(", ")) : "nothing"}`,
        `${label("Kept as EH's")}${kept} detail${kept === 1 ? "" : "s"}`,
        "",
        ...(keptAsSaved ? [`${label("Not reviewed, kept as saved")}${p.change(String(keptAsSaved))}`] : []),
        ...(left ? [`${label("Not reviewed, left unlinked")}${p.change(String(left))}  ${p.dim("(checked again on approval)")}`] : []),
        ...(unreviewed.length ? [] : [p.ok("Everything reviewed")]),
      ],
      [`${p.bold("y")} ${p.dim("save")}     ${p.bold("Esc / Backspace / n")} ${p.dim("back")}`],
    );
  };

  return {
    /** One keypress, as readline gives it: "save" or "cancel" ends the screen. */
    press(str: string | undefined, key: LinkKey): "save" | "cancel" | null {
      if (key.ctrl && key.name === "c") return "cancel";
      if (editing) {
        editKey(key);
        return null;
      }
      // Only pressing the same Enter (or number) again confirms a move; anything else drops it.
      if (key.name !== "return" && !(str && /^[1-9]$/.test(str))) pendingMove = null;
      if (confirming) {
        if (str === "y") return "save";
        if (str === "n" || key.name === "escape" || key.name === "backspace") confirming = false;
        return null;
      }
      const v = visible();
      const i = v[cursor];
      if (searching && i !== undefined) searchKey(i, str, key);
      else if (key.name === "up") cursor = Math.max(0, cursor - 1);
      else if (key.name === "down") cursor = Math.min(v.length - 1, cursor + 1);
      else if (key.name === "pageup") cursor = Math.max(0, cursor - PAGE);
      else if (key.name === "pagedown") cursor = Math.max(0, Math.min(v.length - 1, cursor + PAGE));
      else if (key.name === "tab" || str === "s") {
        if (str === "s") byPack = !byPack;
        else showAll = !showAll;
        cursor = Math.max(0, i === undefined ? 0 : visible().indexOf(i));
      } else if (str === "c") confirming = true;
      else if (i === undefined) return null;
      else if (str === "x") {
        chosen.set(i, { ctUserId: rows[i]!.ctUserId, onList: false });
        if (!showAll) cursor = nextUnreviewed();
      } else if (str === "u") undo(i);
      else if (str === "/") [searching, query, hits, hit] = [true, "", [], 0];
      else if ((str === "e" || key.name === "return") && canEdit(i)) openEdit(i);
      else choose(i, str, key);
      // An undo can take a row out of To review: keep the cursor on the list.
      cursor = Math.max(0, Math.min(cursor, visible().length - 1));
      return null;
    },
    /** Everyone, as a plain table: for printing off a terminal. */
    table(size: Omit<LinkScreenSize, "rows">): string[] {
      const all = rows.map((_, i) => i);
      const { headings, line } = columns({ ...size, rows: 0 }, all);
      return [...headings, ...all.map((i) => line(i, false))];
    },
    /** The whole frame, one string per terminal line. */
    render(size: LinkScreenSize): string[] {
      const { p, headings, line } = columns(size, visible());
      const v = visible();

      /** A linked pair's two status lines (#222 item 1): its EH External ID, and its details. */
      const pairLines = (i: number, ehEmployeeId: string): string[] => {
        const id = externalIdOf(i, ehEmployeeId);
        const idText =
          id === "blank" ? p.dim("blank in EH, will be set") : id === "matches" ? p.ok("matches") : p.bad("doesn't match · held at approval");
        const n = detailsOf(i).length;
        const k = sentFromConnecteam(i).length;
        const r = rows[i]!;
        const stored = r.saved?.hasBaseline && linkedEh(i) === r.suggestion && !edited.has(i);
        const detailText = !n
          ? p.dim("all the same")
          : stored
            ? p.dim(`${n} differ${n === 1 ? "s" : ""} · chosen when confirmed`)
            : p.change(`${n} differ${n === 1 ? "s" : ""} · ${k ? `${k} from Connecteam` : "all EH's kept"}`);
        return [`    ${p.dim(pad("EH External ID", 16))}${idText}`, `    ${p.dim(pad("Details", 16))}${detailText}`];
      };

      /** The selected person and what they can be linked to. */
      const panel = (): string[] => {
        const i = v[cursor];
        if (i === undefined) return [p.ok("  Nothing to review.")];
        const r = rows[i]!;
        const u = people.ct.get(r.ctUserId);
        const uName = u ? fullName(u.firstName, u.lastName) : "";
        const out = [`  ${p.bold(`Row ${i + 1}`)}  ${p.ct(uName || `Connecteam ${r.ctUserId}`)}  ${u?.email ?? p.dim("(no email)")}`];
        // Shown as fields of their own, so not repeated as reasons.
        const asFields = new Set<ChoiceReason>(["terminated", "hasPayrollId", "linkedElsewhere", "payrollIdShared"]);
        const ehLine = (id: string, lead: string, reasons: readonly ChoiceReason[] = []) => {
          const e = people.eh.get(id);
          if (!e) return `${lead}${p.eh(`EH ${id}`)}  ${p.change("no longer in EH")}`;
          const name = fullName(e.firstName, e.surname);
          const parts = [
            name.toLowerCase() === uName.toLowerCase() ? p.eh(name) : p.change(name),
            (e.email ?? "").toLowerCase() === (u?.email ?? "").toLowerCase() ? (e.email ?? "") : p.change(e.email ?? "(no email)"),
            p.eh(`EH ${e.id}`),
            e.status && /terminated/i.test(e.status) ? p.change("Terminated") : p.dim(e.status ?? "Active"),
          ];
          if (e.externalId) parts.push(p.change(`Payroll ID ${e.externalId}`));
          const other = linkedRow(id);
          if (other >= 0 && other !== i) parts.push(p.dim(`linked to row ${other + 1}`));
          else if (ownedElsewhere(i, id) && !reasons.includes("linkedElsewhere")) parts.push(p.bad("linked to someone else"));
          const why = reasons.filter((x) => !asFields.has(x)).map((x) => REASON[x]);
          if (why.length) parts.push(`${p.mark.warn} ${why.join(", ")}`);
          return `${lead}${parts.join("  ")}`;
        };
        if (searching) {
          const found = hits.length ? `${hits.length === SEARCH_HITS ? `first ${SEARCH_HITS}` : hits.length} found` : query.trim().length >= 2 ? "nothing found" : "type part of a name or email";
          out.push(`  ${p.eh("Search Employment Hero:")} ${query}${size.color ? "▏" : "_"}  ${p.dim(found)}`);
          hits.forEach((id, k) => out.push(ehLine(id, k === hit ? `  ${size.color ? p.ct("▶") : ">"} ` : `  ${k + 1}) `)));
        } else {
          const d = decision(i);
          const mine = chosen.get(i);
          if (mine && !mine.onList) out.push(`    ${p.change("Won't link")} ${p.dim("- checked again when they're approved")}`);
          else if (d.onList && d.ehEmployeeId === null) out.push(`    ${p.change("New hire, not this person")} ${p.dim("- syncs as a new employee on approval")}`);
          else if (d.onList && d.ehEmployeeId !== null && canEdit(i)) out.push(`  ${p.dim("Linked to")}`, ehLine(d.ehEmployeeId, "    "), ...pairLines(i, d.ehEmployeeId));
          else if (r.kind === "alreadySynced" && r.suggestion) out.push(`  ${p.dim("Matched by Payroll ID")}`, ehLine(r.suggestion, "    "));
          else {
            const choices = choicesOf(r);
            if (choices.length) {
              out.push(`  ${p.dim(choices.length > 1 ? "Suggestions" : "Suggested")}`);
              choices.forEach((c, k) => {
                const lead = choices.length > 1 ? `  ${k + 1}) ` : "    ";
                out.push(c === null ? `${lead}${p.change("New hire, not this person")}` : ehLine(c.ehEmployeeId, lead, c.reasons));
              });
            }
            const blocked = r.candidates.filter((c) => !linkable(c));
            if (blocked.length) {
              out.push(`  ${p.dim("Can't link")}`);
              for (const c of blocked) {
                out.push(ehLine(c.ehEmployeeId, "    "));
                if (c.reasons.includes("linkedElsewhere")) out.push(`      ${p.dim("already linked to someone else: fix it in Connecteam or EH first")}`);
              }
            }
            if (!choices.length && !blocked.length) out.push(`    ${p.dim("No Employment Hero match: syncs as a new hire. Search if they're already in EH.")}`);
          }
        }
        if (pendingMove) out.push(`  ${p.change(`EH ${pendingMove} is linked to row ${linkedRow(pendingMove) + 1}. Enter again to move it here, Esc to cancel.`)}`);
        return out;
      };
      const legend = (): string => {
        const k = (key: string, what: string) => `${p.bold(key)} ${p.dim(what)}`;
        if (confirming) return `  ${k("y", "save and continue")}   ${k("n", "back to the list")}`;
        if (searching) return `  ${k("↑↓", "choose")}   ${k("Enter", "link")}   ${k("Esc", "back")}`;
        const i = v[cursor];
        const parts = [k("↑↓", "move")];
        if (v.length > PAGE) parts.push(k("PgUp/PgDn", "page"));
        if (i !== undefined) {
          const mine = chosen.get(i);
          const n = choicesOf(rows[i]!).length;
          // Settled: chosen this run, or a match or saved link that needs no review.
          const settled = mine !== undefined || (decision(i).onList && !needsReview(i));
          // Enter does the row's next step: edit a linked pair, link an unlinked one (#225).
          if (canEdit(i)) parts.push(k("Enter / e", "edit"));
          else if (!settled && n === 1) parts.push(k("Enter", "link"));
          if (!settled && n > 1) parts.push(k(`1–${n}`, "link"));
          parts.push(k("/", "search EH"));
          if (mine?.onList !== false) parts.push(k("x", "don't link"));
          if (mine) parts.push(k("u", "undo"));
        }
        parts.push(k("s", byPack ? "number order" : "sort by pack"), k("Tab", showAll ? "show to review" : "show everyone"), k("c", "confirm"));
        return `  ${parts.join("   ")}`;
      };

      const ds = rows.map((_, i) => decision(i));
      const toLink = ds.filter((d) => d.onList && d.ehEmployeeId !== null).length;
      const wont = rows.filter((_, i) => chosen.get(i)?.onList === false).length;
      const newHires = rows.filter((r, i) => {
        const d = ds[i]!;
        return d.onList ? d.ehEmployeeId === null : r.kind === "newHire" && !chosen.has(i);
      }).length;
      const W = size.columns;
      const done = reviewed();
      const barW = 20;
      const fill = review.size ? Math.round((done / review.size) * barW) : barW;
      const bar = size.color ? p.ok("█".repeat(fill)) + p.dim("░".repeat(barW - fill)) : `[${"#".repeat(fill)}${".".repeat(barW - fill)}]`;
      const tabs = showAll
        ? `${p.dim(`To review (${review.size})`)}  ${p.bold(p.ct(`[Everyone (${rows.length})]`))}`
        : `${p.bold(p.ct(`[To review (${review.size})]`))}  ${p.dim(`Everyone (${rows.length})`)}`;
      const head = [
        `${p.bold("Link Pre-existing employees")}   ${tabs}`,
        `${p.bold(`Reviewed ${done} of ${review.size}`)} ${bar}   ${p.ok(`${toLink} to link`)} · ${p.change(`${wont} won't link`)} · ${newHires} new hire${newHires === 1 ? "" : "s"}`,
        p.dim("─".repeat(Math.max(1, W - 1))),
        ...headings,
      ].map((l) => fit(l, W));
      const legendLines = wrap(legend(), W, "   ", "  ");
      const panelLines = panel().flatMap((l) => wrap(l, W, "  "));
      // The panel gets up to 9 lines; the list keeps at least 1, and 3 when there's room.
      const room = size.rows - head.length - 1 - legendLines.length;
      const panelH = Math.max(0, Math.min(9, panelLines.length, room - Math.min(3, Math.max(1, room - panelLines.length))));
      const listH = Math.max(1, room - panelH);
      if (cursor < top) top = cursor;
      if (cursor >= top + listH) top = cursor - listH + 1;
      top = Math.max(0, Math.min(top, Math.max(0, v.length - listH)));
      const body = v.slice(top, top + listH).map((i, k) => (top + k === cursor && size.color ? highlight(fit(line(i, true), W - 1), W - 1, size) : fit(line(i, top + k === cursor), W)));
      while (body.length < listH) body.push("");
      const more = v.length > listH ? `  ${top + 1}–${Math.min(v.length, top + listH)} of ${v.length}` : "";
      const rule = fit(p.dim("─".repeat(Math.max(1, W - 1 - more.length)) + more), W);
      const screenLines = [...head, ...body, rule, ...panelLines.slice(0, panelH), ...legendLines].slice(0, size.rows);
      if (editing) return overlay(screenLines, editPopup(editing, p, size), size);
      return confirming ? overlay(screenLines, savePopup(p, size), size) : screenLines;
    },
    decisions: (): LinkDecision[] => rows.map((_, i) => decision(i)),
  };
}

export type LinkScreen = ReturnType<typeof createLinkScreen>;
