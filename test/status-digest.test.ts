import { describe, it, expect } from "vitest";
import { digestMessages, type DigestEmployee } from "../src/status/digest.js";

function employee(over: Partial<DigestEmployee>): DigestEmployee {
  return { ctUserId: 100, ehEmployeeId: "1", state: "waiting_on_employee", reasons: ["taxFileNumber"], ...over };
}

describe("digestMessages", () => {
  it("is a single all-clear line when everyone is ready", () => {
    const msgs = digestMessages([employee({ state: "ready", reasons: [] })], 1);
    expect(msgs).toEqual(["✅ All 1 employee is Complete in Employment Hero - no follow-up needed."]);
  });

  it("pluralises the all-clear line", () => {
    const msgs = digestMessages(
      [employee({ ctUserId: 1, state: "ready", reasons: [] }), employee({ ctUserId: 2, state: "ready", reasons: [] })],
      2,
    );
    expect(msgs).toEqual(["✅ All 2 employees are Complete in Employment Hero - no follow-up needed."]);
  });

  it("groups non-ready employees by state, in a fixed order, with names when known", () => {
    const employees: DigestEmployee[] = [
      employee({ ctUserId: 1, state: "ready", reasons: [] }),
      employee({ ctUserId: 2, state: "broken", reasons: ["retries exhausted"] }),
      employee({ ctUserId: 3, state: "waiting_on_admin", reasons: ["Pay Run Defaults are incomplete"], name: "Ada Lovelace" }),
      employee({ ctUserId: 4, state: "waiting_on_employee", reasons: ["taxFileNumber", "bsb"] }),
    ];
    const [msg] = digestMessages(employees, 4);
    expect(msg).toBe(
      [
        "📋 Employment Hero sync status: 3 of 4 employees need attention.",
        "",
        "**🟡 Waiting on employee (1):**",
        "• Connecteam user 4 — tax file number; bank details",
        "",
        "**🟠 Waiting on admin (1):**",
        "• **Ada Lovelace** (3) — Pay Run Defaults are incomplete",
        "",
        "**🔴 Broken (1):**",
        "• Connecteam user 2 — retries exhausted",
        "",
        "✅ 1 complete in Employment Hero",
      ].join("\n"),
    );
  });

  it("counts people left out by choice on one line, never as needing attention", () => {
    const leftOut = (id: number) => employee({ ctUserId: id, state: "left_out", reasons: ["Employee Status: PBV"] });
    const [msg] = digestMessages([employee({ ctUserId: 1 }), leftOut(2), leftOut(3), leftOut(4)], 4);
    expect(msg).toMatch(/^📋 Employment Hero sync status: 1 of 4 employees need attention\./);
    expect(msg).not.toContain("Connecteam user 2");
    expect(msg!.split("\n").at(-1)).toBe("**⚪ Left out by choice: 3** (Employee Status: PBV)");
  });

  it("still gives the all-clear when everyone else is ready", () => {
    const msgs = digestMessages(
      [employee({ ctUserId: 1, state: "ready", reasons: [] }), employee({ ctUserId: 2, state: "left_out", reasons: ["Employee Status: PBV"] })],
      2,
    );
    expect(msgs).toEqual(["✅ All 1 employee is Complete in Employment Hero - no follow-up needed.\n\n**⚪ Left out by choice: 1** (Employee Status: PBV)"]);
  });

  it("names what an employee was asked to fix in plain words, keeping anything it doesn't recognise", () => {
    const [msg] = digestMessages([employee({ reasons: ["claimTaxFreeThreshold", "bankAccount1_BSB", "bankAccount1_AccountNumber", "mysteryField"] })], 1);
    expect(msg).toContain("— tax declaration; bank details; mysteryField");
  });

  it("never bolds the first line, which a phone's notification preview shows as typed", () => {
    const [msg] = digestMessages([employee({ ctUserId: 1 })], 1);
    expect(msg!.split("\n")[0]).not.toContain("**");
  });

  it("falls back to a generic reason line when reasons is empty", () => {
    const [msg] = digestMessages([employee({ reasons: [] })], 1);
    expect(msg).toContain("— see the audit log");
  });

  it("splits into multiple chunks, each within the Connecteam 500-char message clamp", () => {
    const many: DigestEmployee[] = Array.from({ length: 40 }, (_, i) =>
      employee({ ctUserId: 1000 + i, name: `Employee Number ${i}`, reasons: ["taxFileNumber looks invalid, please re-enter it"] }),
    );
    const msgs = digestMessages(many, 40);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(500);
    // every employee still appears exactly once across the chunks
    for (const e of many) {
      const hits = msgs.filter((m) => m.includes(String(e.ctUserId)));
      expect(hits.length).toBe(1);
    }
    expect(msgs[1]?.startsWith("(cont.) ")).toBe(true);
  });
});
