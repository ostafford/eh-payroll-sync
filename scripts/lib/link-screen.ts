/**
 * The link stage's full-screen list (#154, variant E of #137): the state the
 * keys change and the frame drawn from it. Pure - the script owns the terminal
 * (raw mode, the alternate screen) and feeds keys in.
 */
import { palette } from "./field-check.js";
import type { LinkDecision } from "./link-changes.js";
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
}

/** A keypress as readline's `keypress` event gives it. */
export interface LinkKey {
  name?: string;
  ctrl?: boolean;
}

/** A candidate the admin can link: not someone else's, and still in EH. */
const linkable = (c: LinkCandidate) => !c.reasons.includes("linkedElsewhere") && !c.reasons.includes("goneFromEh");

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

/** A row the admin has to look at: a choice, a Held or can't-link person, or a saved link that no longer checks out. */
function toReview(r: LinkRow): boolean {
  if (r.kind === "choice" || r.kind === "held" || r.kind === "taken") return true;
  return r.kind === "onLinkList" && r.candidates.some((c) => c.reasons.length > 0);
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

// eslint-disable-next-line no-control-regex
const visibleWidth = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

/** A line cut to `w` visible characters, colour codes kept intact and closed. */
function fit(s: string, w: number): string {
  if (visibleWidth(s) <= w) return s;
  let out = "";
  let seen = 0;
  // eslint-disable-next-line no-control-regex
  for (const part of s.split(/(\u001b\[[0-9;]*m)/)) {
    if (part.startsWith("\u001b")) out += part;
    else {
      out += part.slice(0, Math.max(0, w - 1 - seen));
      seen += part.length;
      if (seen >= w - 1) break;
    }
  }
  return `${out}…${s.includes("\u001b") ? "\u001b[0m" : ""}`;
}

/** Wraps a line at its `sep` separators to `w` wide, never cutting a part: continuations are indented. */
function wrap(s: string, w: number, sep: string, indent = "      "): string[] {
  const lead = /^ */.exec(s)![0];
  const out: string[] = [];
  let line = "";
  for (const part of s.slice(lead.length).split(sep)) {
    const next = line ? `${line}${sep}${part}` : `${out.length ? indent : lead}${part}`;
    if (line && visibleWidth(next) > w) {
      out.push(line);
      line = `${indent}${part}`;
    } else line = next;
  }
  out.push(line);
  // A single part wider than the terminal: break it, rather than lose the end of it.
  return out.flatMap((l) => {
    const plain = l.replace(/\u001b\[[0-9;]*m/g, "");
    if (plain.length <= w) return [l];
    const pieces: string[] = [];
    for (let k = 0; k < plain.length; k += w) pieces.push(plain.slice(k, k + w));
    return pieces;
  });
}
const fullName = (first: string, last: string) => `${first} ${last}`.trim();

export function createLinkScreen(list: LinkList, people: LinkScreenPeople) {
  const { rows } = list;
  /** What the admin chose, by row index; a row not here keeps its proposal. */
  const chosen = new Map<number, LinkDecision>();
  const review = new Set(rows.flatMap((r, i) => (toReview(r) ? [i] : [])));
  /** Rows whose link the admin moved to another row, with what `u` on that row puts back. */
  const movedTo = new Map<number, { to: number; was: LinkDecision | undefined; wasInReview: boolean }>();
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

  const visible = () => {
    const v = showAll ? rows.map((_, i) => i) : [...review].sort((a, b) => a - b);
    return byPack ? v.sort((a, b) => PACK_URGENCY.indexOf(rows[a]!.pack) - PACK_URGENCY.indexOf(rows[b]!.pack) || a - b) : v;
  };
  const nextUnreviewed = () => {
    const v = visible();
    for (let k = 1; k <= v.length; k++) {
      const j = (cursor + k) % v.length;
      if (!chosen.has(v[j]!)) return j;
    }
    return Math.min(cursor + 1, v.length - 1);
  };
  /** What a row will save: the admin's choice, else off once its link moved to another row, else its proposal. */
  const decision = (i: number): LinkDecision =>
    chosen.get(i) ?? (movedTo.has(i) ? { ctUserId: rows[i]!.ctUserId, onList: false } : proposed(rows[i]!));
  const reviewed = () => [...review].filter((i) => chosen.has(i)).length;
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
    if (other >= 0 && other !== i) {
      if (pendingMove !== ehEmployeeId) {
        pendingMove = ehEmployeeId;
        return false;
      }
      movedTo.set(other, { to: i, was: chosen.get(other), wasInReview: review.has(other) });
      chosen.delete(other);
      review.add(other);
    }
    pendingMove = null;
    chosen.set(i, { ctUserId: rows[i]!.ctUserId, onList: true, ehEmployeeId });
    if (!showAll) cursor = nextUnreviewed();
    return true;
  };

  /** Puts row i back the way it was, giving back any link that was moved here. */
  const undo = (i: number) => {
    chosen.delete(i);
    for (const [from, m] of movedTo) {
      if (m.to !== i) continue;
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
      if (mine?.onList) return mine.ehEmployeeId === null ? [p.mark.none, p.dim("(none)"), p.change("new hire, not this person")] : linked(mine.ehEmployeeId, p.change("linked"));
      const moved = movedTo.get(i);
      if (moved !== undefined) return [p.mark.warn, p.dim("(none)"), p.change(`match moved to row ${moved.to + 1}`)];
      if (r.kind === "taken") return [p.mark.bad, p.dim("(none)"), p.bad("Can't link: already linked to someone else")];
      if (r.kind === "alreadySynced") return linked(r.suggestion!, p.dim("already matched by Payroll ID"));
      if (r.kind === "newHire") return [p.mark.none, p.dim("(no match)"), p.dim("new hire")];
      const problem = r.candidates.flatMap((c) => c.reasons);
      if (d.onList && !problem.length) {
        if (d.ehEmployeeId === null) return [p.mark.none, p.dim("(none)"), p.dim("new hire, not this person")];
        return linked(d.ehEmployeeId, p.dim(r.kind === "matched" ? "matched by email" : "on the Link list"));
      }
      const several = r.candidates.length > 1;
      const ehCol = several ? p.dim(`(${r.candidates.length} EH employees)`) : r.candidates[0] ? p.change(`${cut(ehName(r.candidates[0].ehEmployeeId), nameW)} ?`) : p.dim("(none)");
      if (savedButUnlinkable(r)) {
        return [p.mark.warn, ehCol, p.change(`saved link will be removed: ${[...new Set(problem)].map((x) => REASON[x]).join(", ")}`)];
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

  return {
    /** One keypress, as readline gives it: "save" or "cancel" ends the screen. */
    press(str: string | undefined, key: LinkKey): "save" | "cancel" | null {
      if (key.ctrl && key.name === "c") return "cancel";
      // Only pressing the same Enter (or number) again confirms a move; anything else drops it.
      if (key.name !== "return" && !(str && /^[1-9]$/.test(str))) pendingMove = null;
      if (confirming) {
        if (str === "y") return "save";
        if (str === "n" || key.name === "escape") confirming = false;
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
          else if (d.onList && d.ehEmployeeId !== null && (mine || !r.candidates.some((c) => c.reasons.length))) out.push(`  ${p.dim("Linked to")}`, ehLine(d.ehEmployeeId, "    "));
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
          const settled = mine !== undefined || (decision(i).onList && !toReview(rows[i]!));
          if (!settled) {
            if (n === 1) parts.push(k("Enter", "link"));
            else if (n > 1) parts.push(k(`1–${n}`, "link"));
          }
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
      // Not reviewed: a saved link that's still possible stays as it was; anyone else is left unlinked.
      const unreviewed = [...review].filter((i) => !chosen.has(i));
      const kept = unreviewed.filter((i) => ds[i]!.onList).length;
      const left = unreviewed.length - kept;
      const confirmText = [
        p.bold("  Save these links?"),
        `  ${[
          p.ok(`${toLink} to link`),
          ...(kept ? [p.change(`${kept} kept as saved, not reviewed`)] : []),
          ...(left ? [p.change(`${left} not reviewed - left unlinked, checked again on approval`)] : []),
          ...(unreviewed.length ? [] : [p.ok("everything reviewed")]),
        ].join(" · ")}`,
      ];
      const panelLines = (confirming ? confirmText : panel()).flatMap((l) => wrap(l, W, "  "));
      // The panel gets up to 9 lines; the list keeps at least 1, and 3 when there's room.
      const room = size.rows - head.length - 1 - legendLines.length;
      const panelH = Math.max(0, Math.min(9, panelLines.length, room - Math.min(3, Math.max(1, room - panelLines.length))));
      const listH = Math.max(1, room - panelH);
      if (cursor < top) top = cursor;
      if (cursor >= top + listH) top = cursor - listH + 1;
      top = Math.max(0, Math.min(top, Math.max(0, v.length - listH)));
      const body = v.slice(top, top + listH).map((i, k) => fit(line(i, top + k === cursor), W));
      while (body.length < listH) body.push("");
      const more = v.length > listH ? `  ${top + 1}–${Math.min(v.length, top + listH)} of ${v.length}` : "";
      const rule = fit(p.dim("─".repeat(Math.max(1, W - 1 - more.length)) + more), W);
      return [...head, ...body, rule, ...panelLines.slice(0, panelH), ...legendLines].slice(0, size.rows);
    },
    decisions: (): LinkDecision[] => rows.map((_, i) => decision(i)),
  };
}

export type LinkScreen = ReturnType<typeof createLinkScreen>;
