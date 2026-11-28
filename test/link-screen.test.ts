import { describe, it, expect } from "vitest";
import type { LinkCtUser, LinkEhEmployee, LinkList, LinkRow } from "../scripts/lib/link-list.js";
import { createLinkScreen } from "../scripts/lib/link-screen.js";
import type { DifferingDetail } from "../scripts/lib/link-details.js";

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

  it("u on the row a link was moved to gives it back to the row it came from", () => {
    const s = press(screen(), "<tab>", "<down>", "<down>", "<down>", "/", "j", "a", "c", "k", "<return>", "<return>", "u");
    expect(decisionFor(s, 104)).toEqual({ ctUserId: 104, onList: false });
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: true, ehEmployeeId: "40213" });
    expect(frame(s)).not.toContain("match moved");
  });

  it("after a chain of moves, u never links one EH employee twice: the link stays where it went last", () => {
    const jack = ["/", "j", "a", "c", "k", "<return>", "<return>"];
    // Row 1's match moves to row 5, then on to row 6; then u on row 5.
    const s = press(screen(), "<tab>", "<down>", "<down>", "<down>", ...jack, "<down>", ...jack, "<up>", "u");
    expect(s.decisions().filter((d) => d.onList && d.ehEmployeeId === "40213")).toEqual([
      { ctUserId: 105, onList: true, ehEmployeeId: "40213" },
    ]);
    expect(decisionFor(s, 100)).toEqual({ ctUserId: 100, onList: false });
    expect(frame(s)).toMatch(/1 \[!\]\s+Jack Mitchell .*match moved to row 6/);
    expect(frame(s)).not.toContain("match moved to row 5");
  });

  it("after a chain of moves, u on the last row hands the link back one step", () => {
    const jack = ["/", "j", "a", "c", "k", "<return>", "<return>"];
    const s = press(screen(), "<tab>", "<down>", "<down>", "<down>", ...jack, "<down>", ...jack, "u");
    expect(s.decisions().filter((d) => d.onList && d.ehEmployeeId === "40213")).toEqual([
      { ctUserId: 104, onList: true, ehEmployeeId: "40213" },
    ]);
    expect(frame(s)).toMatch(/1 \[!\]\s+Jack Mitchell .*match moved to row 5/);
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

  describe("a link saved on an earlier run that no longer checks out", () => {
    const stale = () =>
      createLinkScreen(
        {
          rows: [
            // Saved to EH 40600, which now belongs to Connecteam user 999 (and was terminated).
            row({ ctUserId: 106, kind: "onLinkList", suggestion: "40600", candidates: [{ ehEmployeeId: "40600", reasons: ["terminated", "linkedElsewhere"], linkedTo: 999 }] }),
            // Saved to EH 40401, since terminated in EH: still possible.
            row({ ctUserId: 102, kind: "onLinkList", suggestion: "40401", candidates: [{ ehEmployeeId: "40401", reasons: ["terminated", "hasPayrollId"], payrollId: "E-77" }] }),
            row({ ctUserId: 101, kind: "choice", candidates: [{ ehEmployeeId: "40377", reasons: ["nameDiffers"] }] }),
          ],
          ignoredEhCount: 0,
          ehOwners: new Map([["40600", 999]]),
        },
        people,
      );

    it("comes off the Link list when it can no longer be made, and says so", () => {
      const s = stale();
      expect(decisionFor(s, 106)).toEqual({ ctUserId: 106, onList: false });
      // Only what stops the link: being terminated alone wouldn't.
      expect(frame(s)).toMatch(/1 \[!\]\s+Ivy Reid .*saved link will be removed: linked to someone else$/m);
    });

    it("stays when it's still possible, and the save check counts it as kept, not left unlinked", () => {
      const s = stale();
      expect(decisionFor(s, 102)).toEqual({ ctUserId: 102, onList: true, ehEmployeeId: "40401" });
      const f = frame(press(s, "c"));
      expect(f).toMatch(/To link +1 /);
      expect(f).toMatch(/Not reviewed, kept as saved +1 /);
      expect(f).toMatch(/Not reviewed, left unlinked +2 +\(checked again on approval\)/);
    });
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
      expect(out).toMatch(/To link +3 /);
      expect(out).toMatch(/Not reviewed, left unlinked +2 /);
      const all = frame(press(screen(), "<return>", "x", "x", "c"));
      expect(all).toMatch(/To link +3 /);
      expect(all).toContain("Everything reviewed");
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

describe("link screen on a re-run: To review, External ID and Details (#225)", () => {
  const cts: LinkCtUser[] = [
    { ctUserId: 200, firstName: "Avery", lastName: "Lin", email: "avery@example.com", payrollId: "200" },
    { ctUserId: 201, firstName: "Blake", lastName: "Okoro", email: "blake@example.com", payrollId: "201" },
    { ctUserId: 202, firstName: "Casey", lastName: "Duarte", email: "casey@example.com", payrollId: "202" },
    { ctUserId: 203, firstName: "Devon", lastName: "Marsh", email: "devon@example.com", payrollId: "203" },
    { ctUserId: 204, firstName: "Emery", lastName: "Novak", email: "emery@example.com", payrollId: "204" },
    { ctUserId: 205, firstName: "Finley", lastName: "Rowe", email: "finley@example.com", payrollId: "205" },
    { ctUserId: 206, firstName: "Harper", lastName: "Quinn", email: "harper@example.com", payrollId: "206" },
  ];
  const ehs: LinkEhEmployee[] = [
    { id: "300", firstName: "Avery", surname: "Lin", email: "avery@example.com", externalId: null, status: "Active" },
    { id: "301", firstName: "Blake", surname: "Okoro", email: "blake@example.com", externalId: "201", status: "Active" },
    { id: "302", firstName: "Casey", surname: "Duarte", email: "casey@example.com", externalId: null, status: "Active" },
    { id: "303", firstName: "Devon", surname: "Marsh", email: "devon@example.com", externalId: null, status: "Active" },
    { id: "304", firstName: "Emery", surname: "Novak", email: "emery@example.com", externalId: null, status: "Terminated" },
    { id: "305", firstName: "Finley", surname: "Rowe", email: "finley@example.com", externalId: null, status: "Active" },
    { id: "306", firstName: "Harper", surname: "Quinn", email: "harper@example.com", externalId: "306", status: "Active" },
  ];
  const postcode: DifferingDetail = { unit: "residentialAddress", label: "Residential address", fields: ["Postcode"] };
  const phone: DifferingDetail = { unit: "mobilePhone", label: "Mobile phone", fields: ["Mobile phone"] };
  const differ: Record<string, DifferingDetail[]> = { "200:300": [postcode, phone], "201:301": [postcode], "202:302": [phone] };
  const details = (ctUserId: number, ehEmployeeId: string) => differ[`${ctUserId}:${ehEmployeeId}`] ?? [];
  const saved = (ctUserId: number, eh: string, hasBaseline: boolean, over: Partial<LinkRow> = {}) =>
    row({ ctUserId, kind: "onLinkList", suggestion: eh, candidates: [{ ehEmployeeId: eh, reasons: [] }], saved: { hasBaseline, confirmedAt: CONFIRMED }, ...over });
  const CONFIRMED = Date.UTC(2026, 10, 10, 12);
  /** Rows 1-7, in this order. */
  const rerun: LinkList = {
    rows: [
      saved(200, "300", false),
      saved(201, "301", true),
      row({ ctUserId: 202, kind: "matched", suggestion: "302" }),
      row({ ctUserId: 203, kind: "matched", suggestion: "303" }),
      saved(204, "304", true, { candidates: [{ ehEmployeeId: "304", reasons: ["terminated"] }] }),
      saved(205, "305", true, { wouldBlock: "payroll-id-elsewhere" }),
      saved(206, "306", true, { candidates: [{ ehEmployeeId: "306", reasons: ["hasPayrollId"], payrollId: "306" }], wouldBlock: "different-payroll-id" }),
    ],
    ignoredEhCount: 0,
    ehOwners: new Map(),
  };
  const rerunPeople = { ct: new Map(cts.map((u) => [u.ctUserId, u])), eh: new Map(ehs.map((e) => [e.id, e])) };
  const rerunScreen = () => createLinkScreen(rerun, rerunPeople, { details });
  /** The list's line for one person, in the frame. */
  const lineOf = (f: string, name: string) => f.split("\n").find((l) => l.includes(name)) ?? "";

  it("lists exactly who needs a decision: details differ with no choice made, a link that would block, an External ID that doesn't match", () => {
    const f = frame(rerunScreen());
    expect(f).toContain("[To review (4)]");
    for (const name of ["Avery Lin", "Casey Duarte", "Finley Rowe", "Harper Quinn"]) expect(lineOf(f, name)).not.toBe("");
    // Blake's choices were made when his Baseline was taken; Devon has nothing to check; Emery's saved link goes through.
    for (const name of ["Blake Okoro", "Devon Marsh", "Emery Novak"]) expect(lineOf(f, name)).toBe("");
  });

  it("says in the Status column which reason applies", () => {
    const f = frame(rerunScreen());
    expect(lineOf(f, "Avery Lin")).toContain("2 details differ · all EH's kept");
    expect(lineOf(f, "Casey Duarte")).toContain("1 detail differs · all EH's kept");
    expect(lineOf(f, "Finley Rowe")).toContain("link will be blocked: Payroll ID on another EH employee");
    expect(lineOf(f, "Harper Quinn")).toContain("EH External ID doesn't match · held at approval");
  });

  it("e opens one Edit pop-up for the pair, with sections 1 EH External ID and 2 Details, and a ✓ where there's nothing to choose", () => {
    const f = frame(press(rerunScreen(), "e"));
    expect(f).toContain("Edit · Avery Lin");
    expect(f).toMatch(/1 {2}EH External ID/);
    expect(f).toMatch(/EH External ID +\(blank\)/);
    expect(f).toMatch(/Connecteam User ID +200/);
    expect(f).toContain("[ok] Blank in EH: it'll be set to their Connecteam User ID.");
    expect(f).toMatch(/2 {2}Details \(2 differ\)/);
    expect(f).toContain("Values aren't shown");
    expect(f).toContain("Residential address (Postcode)");
    expect(f).toContain("Mobile phone");
    expect(f).toMatch(/> \(x\) Keep EH's/);
    expect(f).toMatch(/\( \) Use Connecteam's/);
    // Devon (Everyone, row 4): nothing differs.
    expect(frame(press(rerunScreen(), "<tab>", "<down>", "<down>", "<down>", "e"))).toContain("[ok] All the same in both. Nothing to choose.");
  });

  it("names both IDs when EH's External ID doesn't match, and flags one that's their EH Employee ID", () => {
    // Harper is the last row to review; Enter on a linked row edits it.
    const f = frame(press(rerunScreen(), "<down>", "<down>", "<down>", "<return>"));
    expect(f).toContain("Edit · Harper Quinn");
    expect(f).toMatch(/EH External ID +306 +\[!\] this is their EH Employee ID/);
    expect(f).toMatch(/Connecteam User ID +206/);
    expect(f).toContain("[x] They don't match: they're held at approval.");
  });

  it("Enter picks the option under the bar, and Esc or Backspace goes back with the picks kept", () => {
    const s = press(rerunScreen(), "e", "<down>", "<return>", "<escape>");
    expect(decisionFor(s, 200)).toEqual({ ctUserId: 200, onList: true, ehEmployeeId: "300", details: { useConnecteam: ["residentialAddress"] } });
    expect(lineOf(frame(s), "Avery Lin")).toContain("2 details differ · 1 from Connecteam");
    // Back in: the pick is still there, and Keep EH's puts it back.
    press(s, "e", "<down>", "<down>", "<down>", "<return>", "<up>", "<up>", "<up>", "<return>", "<backspace>");
    expect(decisionFor(s, 200)).toEqual({ ctUserId: 200, onList: true, ehEmployeeId: "300", details: { useConnecteam: ["mobilePhone"] } });
  });

  it("previews what the Link notice will say", () => {
    expect(frame(press(rerunScreen(), "e"))).toContain("Link notice will say: (just linked)");
    expect(frame(press(rerunScreen(), "e", "<down>", "<return>", "<down>", "<down>", "<return>"))).toContain(
      "Link notice will say: Sent from Connecteam: Residential address, Mobile phone",
    );
  });

  it("Enter links a row's one suggestion, then opens Edit only when that pair has something to choose", () => {
    const toPick: LinkList = {
      rows: [
        row({ ctUserId: 202, kind: "choice", candidates: [{ ehEmployeeId: "302", reasons: ["nameDiffers"] }] }),
        row({ ctUserId: 203, kind: "choice", candidates: [{ ehEmployeeId: "303", reasons: ["nameDiffers"] }] }),
      ],
      ignoredEhCount: 0,
      ehOwners: new Map(),
    };
    const s = press(createLinkScreen(toPick, rerunPeople, { details }), "<return>");
    expect(decisionFor(s, 202)).toEqual({ ctUserId: 202, onList: true, ehEmployeeId: "302" });
    expect(frame(s)).toContain("Edit · Casey Duarte");
    // Back on the list, the cursor has moved on to Devon: nothing differs, so no pop-up.
    press(s, "<escape>", "<return>");
    expect(decisionFor(s, 203)).toEqual({ ctUserId: 203, onList: true, ehEmployeeId: "303" });
    expect(frame(s)).not.toContain("Edit ·");
  });

  it("keeps a stored Baseline unless the admin picks in its Edit pop-up, after warning that changes since then are decided there", () => {
    // Blake (Everyone, row 2) was confirmed with a Baseline on 10 Nov 2026.
    const blake = () => press(rerunScreen(), "<tab>", "<down>", "e");
    expect(frame(blake())).toContain("changes since 10 Nov 2026 are decided here, not sent");
    expect(decisionFor(press(blake(), "<escape>"), 201)).toEqual({ ctUserId: 201, onList: true, ehEmployeeId: "301" });
    expect(decisionFor(press(blake(), "<return>", "<escape>"), 201)).toEqual({
      ctUserId: 201,
      onList: true,
      ehEmployeeId: "301",
      details: { useConnecteam: [] },
    });
  });

  it("asks 'Save these links?' in a pop-up counting what the save does: held people are counted, not blocking", () => {
    const f = frame(press(rerunScreen(), "c"));
    expect(f).toContain("Save these links?");
    expect(f).toMatch(/To link +7 /);
    expect(f).toMatch(/New hires +0 /);
    // Avery was saved before Baselines: re-saved with one.
    expect(f).toMatch(/Re-confirmed +1 /);
    // Finley's link would be blocked, Harper's External ID doesn't match.
    expect(f).toMatch(/Held at approval +2 /);
    expect(f).toMatch(/Sent from Connecteam at link +nothing /);
    expect(f).toMatch(/Kept as EH's +3 details /);
  });

  it("counts each detail sent from Connecteam, and goes back on Esc, Backspace or n", () => {
    const s = press(rerunScreen(), "e", "<down>", "<return>", "<escape>", "<down>", "e", "<down>", "<return>", "<escape>", "c");
    expect(frame(s)).toMatch(/Sent from Connecteam at link +Residential address, Mobile phone /);
    expect(frame(s)).toMatch(/Kept as EH's +1 detail /);
    for (const back of ["<escape>", "<backspace>", "n"]) {
      expect(frame(press(rerunScreen(), "c", back))).not.toContain("Save these links?");
    }
    expect(press(rerunScreen(), "c").press("y", { name: "y" })).toBe("save");
  });

  it("shows the selected pair's EH External ID and Details as two status lines in its panel, with Enter / e to edit", () => {
    const avery = frame(rerunScreen());
    expect(avery).toMatch(/EH External ID +blank in EH, will be set/);
    expect(avery).toMatch(/Details +2 differ · all EH's kept/);
    expect(avery).toContain("Enter / e edit");
    const harper = frame(press(rerunScreen(), "<down>", "<down>", "<down>"));
    expect(harper).toMatch(/EH External ID +doesn't match · held at approval/);
    expect(harper).toMatch(/Details +all the same/);
  });

  it("scrolls a pop-up taller than the terminal inside itself, keeping the bar in view", () => {
    const many = Array.from({ length: 12 }, (_, k): DifferingDetail => ({ unit: `u${k + 1}`, label: `Detail ${k + 1}`, fields: [`Detail ${k + 1}`] }));
    const one: LinkList = { rows: [row({ ctUserId: 203, kind: "matched", suggestion: "303" })], ignoredEhCount: 0, ehOwners: new Map() };
    const s = press(createLinkScreen(one, rerunPeople, { details: () => many }), "<tab>", "e");
    const top = frame(s);
    expect(top.split("\n").length).toBeLessThanOrEqual(30);
    expect(top).toContain("Detail 1");
    expect(top).not.toContain("Detail 12");
    expect(top).toMatch(/↓ \d+ more/);
    // Down to the last option: Detail 12's Use Connecteam's.
    press(s, ...Array.from({ length: 23 }, () => "<down>"));
    const bottom = frame(s);
    expect(bottom).toContain("Detail 12");
    expect(bottom).toMatch(/> \( \) Use Connecteam's/);
    expect(bottom).toMatch(/↑ \d+ more/);
    expect(bottom).toContain("Esc / Backspace");
  });

  it("draws the selected list row and pop-up option as a full-width bar: black on a light terminal, grey on a dark one or one that doesn't say", () => {
    const BLACK = "\u001b[1;97;40m";
    const GREY = "\u001b[1;97;100m";
    const colour = { columns: 160, rows: 30, color: true };
    const avery = (lines: string[]) => lines.find((l) => l.includes("Avery") && l.includes("▶")) ?? "";
    expect(avery(rerunScreen().render({ ...colour, background: "light" }))).toContain(BLACK);
    for (const size of [colour, { ...colour, background: "dark" as const }]) {
      const bar = avery(rerunScreen().render(size));
      expect(bar).toContain(GREY);
      expect(bar).not.toContain(BLACK);
    }
    const option = press(rerunScreen(), "e").render({ ...colour, background: "light" }).find((l) => l.includes("Keep EH's") && l.includes("▶")) ?? "";
    expect(option).toContain(BLACK);
  });
});
