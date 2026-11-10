import { describe, it, expect } from "vitest";
import type { LinkCtUser, LinkEhEmployee, LinkList, LinkRow } from "../scripts/lib/link-list.js";
import { createLinkScreen } from "../scripts/lib/link-screen.js";

// eslint-disable-next-line no-control-regex
const width = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "").length;

const ctUsers: LinkCtUser[] = [
  { ctUserId: 100, firstName: "Jack", lastName: "Mitchell", email: "jack@example.com", payrollId: "100" },
  { ctUserId: 101, firstName: "Mia", lastName: "Chen", email: "mia.chen@regional-operations.example.com.au", payrollId: "101" },
  { ctUserId: 102, firstName: "Omar", lastName: "Haddad", email: "omar@example.com", payrollId: "102" },
  { ctUserId: 103, firstName: "Ruby", lastName: "Kelly", email: "ruby@example.com", payrollId: "103" },
  { ctUserId: 104, firstName: "Theo", lastName: "Fraser", email: "theo@example.com", payrollId: "104" },
  { ctUserId: 105, firstName: "Ava", lastName: "Singh", email: "ava@example.com", payrollId: "105" },
  { ctUserId: 106, firstName: "Ivy", lastName: "Reid", email: "ivy@example.com", payrollId: "106" },
];
const ehEmployees: LinkEhEmployee[] = [
  { id: "40213", firstName: "Jack", surname: "Mitchell", email: "jack@example.com", externalId: null, status: "Active" },
  { id: "40377", firstName: "Mia", surname: "Chen-Wong", email: "mia.chen@regional-operations.example.com.au", externalId: null, status: "Active" },
  { id: "40400", firstName: "Omar", surname: "Haddad", email: "o.haddad@example.com", externalId: null, status: "Active" },
  { id: "40401", firstName: "Omar", surname: "Haddad", email: "omar.h@example.net", externalId: "E-77", status: "Terminated" },
  { id: "40500", firstName: "Ruby", surname: "Kelly", email: "ruby@example.com", externalId: null, status: "Active" },
  { id: "40600", firstName: "Ivy", surname: "Reid", email: "ivy@example.com", externalId: "999", status: "Active" },
];
const row = (over: Partial<LinkRow> & Pick<LinkRow, "ctUserId" | "kind">): LinkRow => ({
  suggestion: null,
  candidates: [],
  pack: "notAssigned",
  ...over,
});
/** One of each kind of row, numbered 1-7 in this order. */
const list: LinkList = {
  rows: [
    row({ ctUserId: 100, kind: "matched", suggestion: "40213" }),
    row({ ctUserId: 101, kind: "choice", candidates: [{ ehEmployeeId: "40377", reasons: ["nameDiffers"] }], pack: "readyForReview" }),
    row({
      ctUserId: 102,
      kind: "held",
      newHireChoice: true,
      candidates: [
        { ehEmployeeId: "40400", reasons: [] },
        { ehEmployeeId: "40401", reasons: ["terminated", "hasPayrollId"], payrollId: "E-77" },
      ],
      pack: "approvedNotSynced",
    }),
    row({ ctUserId: 103, kind: "onLinkList", suggestion: "40500", candidates: [{ ehEmployeeId: "40500", reasons: [] }] }),
    row({ ctUserId: 104, kind: "newHire" }),
    row({ ctUserId: 105, kind: "onLinkList", suggestion: null, pack: "inProgress" }),
    row({ ctUserId: 106, kind: "taken", candidates: [{ ehEmployeeId: "40600", reasons: ["linkedElsewhere"], linkedTo: 999 }] }),
  ],
  ignoredEhCount: 3,
  // EH 40600 belongs to Connecteam user 999, who isn't on the screen.
  ehOwners: new Map([["40600", 999]]),
};
const people = {
  ct: new Map(ctUsers.map((u) => [u.ctUserId, u])),
  eh: new Map(ehEmployees.map((e) => [e.id, e])),
};
const screen = () => createLinkScreen(list, people);
/** Presses each key in turn: a single character, or a key name in angle brackets ("<return>"). */
const press = (s: ReturnType<typeof screen>, ...keys: string[]) => {
  for (const k of keys) {
    const name = /^<(.+)>$/.exec(k)?.[1];
    s.press(name ? undefined : k, { name: name ?? k });
  }
  return s;
};
const plain = { columns: 160, rows: 30, color: false };
const frame = (s: ReturnType<typeof screen>, size = plain) => s.render(size).join("\n");
const decisionFor = (s: ReturnType<typeof screen>, ctUserId: number) => s.decisions().find((d) => d.ctUserId === ctUserId);

describe("link screen", () => {
  it("keeps what's proposed until the admin changes it: matches and earlier links on the Link list, everyone else off", () => {
    expect(screen().decisions()).toEqual([
      { ctUserId: 100, onList: true, ehEmployeeId: "40213" },
      { ctUserId: 101, onList: false },
      { ctUserId: 102, onList: false },
      { ctUserId: 103, onList: true, ehEmployeeId: "40500" },
      { ctUserId: 104, onList: false },
      { ctUserId: 105, onList: true, ehEmployeeId: null },
      { ctUserId: 106, onList: false },
    ]);
  });

  it("opens on the rows to review: Enter links the one suggestion and moves on to the next, where a number picks one of several", () => {
    const s = press(screen(), "<return>", "1");
    expect(decisionFor(s, 101)).toEqual({ ctUserId: 101, onList: true, ehEmployeeId: "40377" });
    expect(decisionFor(s, 102)).toEqual({ ctUserId: 102, onList: true, ehEmployeeId: "40400" });
  });

  it("offers a Held employee 'New hire, not this person' as the number after their candidates", () => {
    const s = press(screen(), "<down>", "3");
    expect(decisionFor(s, 102)).toEqual({ ctUserId: 102, onList: true, ehEmployeeId: null });
  });

  it("Tab shows everyone, keeping the selected row, and x takes a matched person off the Link list", () => {
    const s = press(screen(), "<tab>", "<up>", "x");
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: false });
  });

  it("u puts a row back the way it was", () => {
    const s = press(screen(), "<tab>", "<up>", "x", "u");
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: true, ehEmployeeId: "40213" });
  });

  it("c asks before saving: y saves, n goes back to the list, and Ctrl-C cancels", () => {
    const s = screen();
    expect(s.press("c", { name: "c" })).toBeNull();
    expect(s.press("n", { name: "n" })).toBeNull();
    expect(s.press("y", { name: "y" })).toBeNull();
    expect(s.press("c", { name: "c" })).toBeNull();
    expect(s.press("y", { name: "y" })).toBe("save");
    expect(screen().press(undefined, { name: "c", ctrl: true })).toBe("cancel");
  });

  it("/ searches all of EH by name or email as you type, and Enter links the chosen hit, for a new hire too", () => {
    const theo = (s: ReturnType<typeof screen>) => press(s, "<tab>", "<down>", "<down>", "<down>");
    expect(decisionFor(press(theo(screen()), "/", "o", "m", "a", "r", "<down>", "<return>"), 104)).toEqual({
      ctUserId: 104,
      onList: true,
      ehEmployeeId: "40401",
    });
    expect(decisionFor(press(theo(screen()), "/", "o", ".", "h", "a", "d", "<return>"), 104)).toEqual({
      ctUserId: 104,
      onList: true,
      ehEmployeeId: "40400",
    });
  });

  it("ranks search hits by the same name first, then anyone not linked to another row", () => {
    const ruby = () => press(screen(), "<tab>", "<down>", "<down>", "/", "e", "x");
    expect(decisionFor(press(ruby(), "<return>"), 103)).toEqual({ ctUserId: 103, onList: true, ehEmployeeId: "40500" });
    // Jack's record is linked to row 1, so it drops below Mia's.
    expect(decisionFor(press(ruby(), "<down>", "<return>"), 103)).toEqual({ ctUserId: 103, onList: true, ehEmployeeId: "40377" });
  });

  it("finds an EH employee who belongs to someone else in search, but won't link them", () => {
    const fromTheo = press(screen(), "<tab>", "<down>", "<down>", "<down>", "/", "i", "v", "y", "<return>", "<return>");
    expect(decisionFor(fromTheo, 104)).toEqual({ ctUserId: 104, onList: false });
    expect(frame(fromTheo)).toMatch(/Ivy Reid .*EH 40600 .*linked to someone else/);
    const fromIvy = press(screen(), "<down>", "<down>", "/", "i", "v", "y", "<return>");
    expect(decisionFor(fromIvy, 106)).toEqual({ ctUserId: 106, onList: false });
  });

  it("drops a pending move when the admin backs out with Esc, so the next Enter asks again", () => {
    const s = press(screen(), "<tab>", "<down>", "<down>", "<down>", "/", "j", "a", "c", "k", "<return>");
    expect(frame(s)).toContain("Enter again to move it here");
    press(s, "<escape>");
    expect(frame(s)).not.toContain("Enter again to move it here");
    press(s, "/", "j", "a", "c", "k", "<return>");
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: true, ehEmployeeId: "40213" });
    expect(decisionFor(s, 104)).toEqual({ ctUserId: 104, onList: false });
  });

  it("moves an EH employee linked to another row only on a second Enter, taking the link off that row", () => {
    const s = press(screen(), "<tab>", "<down>", "<down>", "<down>", "/", "j", "a", "c", "k", "<return>");
    expect(decisionFor(s, 104)).toEqual({ ctUserId: 104, onList: false });
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: true, ehEmployeeId: "40213" });
    press(s, "<return>");
    expect(decisionFor(s, 104)).toEqual({ ctUserId: 104, onList: true, ehEmployeeId: "40213" });
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: false });
  });

  it("PgDn and PgUp move ten rows at a time, stopping at either end", () => {
    const many = Array.from({ length: 30 }, (_, k) => row({ ctUserId: 1000 + k, kind: "newHire" }));
    const s = press(createLinkScreen({ rows: many, ignoredEhCount: 0, ehOwners: new Map() }, people), "<tab>", "<pagedown>");
    const selected = () => /Row (\d+)/.exec(frame(s))?.[1];
    expect(selected()).toBe("11");
    expect((press(s, "<pageup>"), selected())).toBe("1");
    expect((press(s, "<pagedown>", "<pagedown>", "<pagedown>", "<pagedown>"), selected())).toBe("30");
  });

  describe("the frame", () => {
    it("tops the list with how many of the rows to review are done, and what the Link list will hold", () => {
      const s = screen();
      expect(frame(s)).toMatch(/Reviewed 0 of 3 .* 2 to link · 0 won't link · 2 new hires/);
      press(s, "<return>", "x");
      expect(frame(s)).toMatch(/Reviewed 2 of 3 .* 3 to link · 1 won't link · 2 new hires/);
    });

    it("lists the rows to review under fixed column headings, numbered as in the whole list, with why and where their pack is", () => {
      const out = frame(screen());
      expect(out).toMatch(/#\s+Connecteam user\s+Connecteam email\s+Employment Hero match\s+Pack\s+Status/);
      expect(out).toMatch(/> 2 \[!\]\s+Mia Chen\s+mia\.chen@regional-\S*…\s+→ Mia Chen-Wong \?\s+Ready for review\s+name differs/);
      expect(out).toMatch(/ {2}3 \[!\]\s+Omar Haddad\s+omar@example\.com\s+→ \(2 EH employees\)\s+Approved, not synced\s+held on approval: matches 2 EH employees/);
      expect(out).not.toContain("Jack Mitchell");
    });

    it("puts a row whose link moved to another row back in review, saying where it went", () => {
      const s = press(screen(), "<tab>", "<down>", "<down>", "<down>", "/", "j", "a", "c", "k", "<return>", "<return>", "<tab>");
      const out = frame(s);
      expect(out).toMatch(/Reviewed 0 of 4/);
      expect(out).toMatch(/1 \[!\]\s+Jack Mitchell .*match moved to row 5/);
    });

    it("shows the selected person in the bottom panel with each suggestion in full: email, EH status, Payroll ID", () => {
      expect(frame(screen())).toMatch(/Row 2 {2}Mia Chen {2}mia\.chen@regional-operations\.example\.com\.au\n.*Suggested\n\s+Mia Chen-Wong {2}mia\.chen@regional-operations\.example\.com\.au {2}EH 40377 {2}Active {2}\[!\] name differs/);
      const held = frame(press(screen(), "<down>"));
      expect(held).toMatch(/Row 3 {2}Omar Haddad {2}omar@example\.com/);
      expect(held).toMatch(/1\) Omar Haddad {2}o\.haddad@example\.com {2}EH 40400 {2}Active/);
      expect(held).toMatch(/2\) Omar Haddad {2}omar\.h@example\.net {2}EH 40401 {2}Terminated {2}Payroll ID E-77/);
      expect(held).toMatch(/3\) New hire, not this person/);
    });

    it("s sorts by pack, the most urgent first, keeping each row's number; s again goes back to number order", () => {
      const order = (s: ReturnType<typeof screen>) =>
        frame(s).split("\n").flatMap((l) => /^[ >] +(\d) /.exec(l)?.[1] ?? []).join("");
      const s = press(screen(), "<tab>", "s");
      expect(order(s)).toBe("3261457");
      expect(order(press(s, "s"))).toBe("1234567");
    });

    it("ends with a legend of only the keys that apply to the selected row", () => {
      const legend = (s: ReturnType<typeof screen>) => s.render(plain).at(-1);
      expect(legend(screen())).toBe("  ↑↓ move   Enter link   / search EH   x don't link   s sort by pack   Tab show everyone   c confirm");
      expect(legend(press(screen(), "<down>"))).toContain("1–3 link");
      const off = press(screen(), "x", "<up>");
      expect(legend(off)).not.toContain("Enter link");
      expect(legend(off)).toContain("u undo");
      expect(legend(press(screen(), "/"))).toBe("  ↑↓ choose   Enter link   Esc back");
      expect(legend(press(screen(), "c"))).toBe("  y save and continue   n back to the list");
    });

    it("marks a row whose match belongs to someone else as can't link, and won't link it", () => {
      const s = press(screen(), "<down>", "<down>");
      expect(frame(s)).toMatch(/> 7 \[x\]\s+Ivy Reid .*Can't link: already linked to someone else/);
      expect(s.render(plain).at(-1)).not.toMatch(/Enter link|1–\d link/);
      press(s, "<return>", "1");
      expect(decisionFor(s, 106)).toEqual({ ctUserId: 106, onList: false });
    });

    it.each([
      { columns: 60, rows: 14 },
      { columns: 200, rows: 60 },
    ])("fills a $columns×$rows terminal exactly, scrolling to the selected row and wrapping the panel, never cutting its emails", (size) => {
      for (const color of [false, true]) {
        const s = press(screen(), "<tab>", "<up>", "<down>");
        const lines = s.render({ ...size, color });
        expect(lines).toHaveLength(size.rows);
        for (const l of lines) expect(width(l)).toBeLessThanOrEqual(size.columns);
        expect(lines.join("")).toContain("mia.chen@regional-operations.example.com.au");
        press(s, "<down>", "<down>", "<down>", "<down>", "<down>");
        expect(s.render({ ...size, color }).some((l) => /^\S* +7 /.test(l.replace(/\u001b\[[0-9;]*m/g, "")))).toBe(true);
      }
    });

    it("asks 'Save these links?' on c, counting what's left unreviewed", () => {
      const out = frame(press(screen(), "<return>", "c"));
      expect(out).toContain("Save these links?");
      expect(out).toContain("3 to link · 2 not reviewed - left unlinked, checked again on approval");
      expect(frame(press(screen(), "<return>", "x", "x", "c"))).toContain("3 to link · everything reviewed");
    });

    it("draws in the field check's colours and marks on a terminal, and in plain text with [ok] / [!] / [x] without colour", () => {
      const coloured = screen().render({ ...plain, color: true }).join("\n");
      expect(coloured).toContain("\u001b[35m");
      expect(coloured).toContain("⚠");
      const bare = frame(screen());
      expect(bare).not.toContain("\u001b");
      expect(bare).toMatch(/\[!\].*\n.*\[!\].*\n.*\[x\]/);
    });

    it.each([100, 160])("keeps each heading over its column and the view tabs in sight at %i columns", (columns) => {
      const lines = screen().render({ columns, rows: 24, color: false });
      const heading = lines.find((l) => l.includes("Pack"))!;
      const mia = lines.find((l) => l.includes("Mia Chen"))!;
      expect(heading.indexOf("Conn"), "Connecteam user").toBe(mia.indexOf("Mia"));
      expect(heading.lastIndexOf("Conn"), "Connecteam email").toBe(mia.indexOf("mia."));
      expect(heading.indexOf("Empl"), "Employment Hero match").toBe(mia.indexOf("Mia Chen-"));
      expect(heading.indexOf("Pack"), "Pack").toBe(mia.indexOf("Ready"));
      expect(lines.join("\n")).toContain("[To review (3)]  Everyone (7)");
    });
  });
});
