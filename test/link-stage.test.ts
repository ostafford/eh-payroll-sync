import { describe, it, expect, vi } from "vitest";
import type { ConnecteamUser } from "../src/connecteam/types.js";
import type { LinkStageData } from "../scripts/lib/link-input.js";
import type { LinkScreen } from "../scripts/lib/link-screen.js";
import { runLinkStage, type LinkStageDeps } from "../scripts/lib/link-stage.js";

const ctUser = (userId: number, firstName: string, lastName: string, email: string): ConnecteamUser => ({
  userId,
  firstName,
  lastName,
  email,
  customFields: [],
});
const ehEmployee = (id: number, firstName: string, surname: string, emailAddress: string) => ({
  id,
  firstName,
  surname,
  emailAddress,
  externalId: null,
  status: "Active",
});
/** Jack matches by email; Mia's EH name differs, so she's to review; Omar is a new hire. */
const data = (over: Partial<LinkStageData> = {}): LinkStageData => ({
  ctUsers: [
    ctUser(100, "Jack", "Mitchell", "jack@example.com"),
    ctUser(101, "Mia", "Chen", "mia@example.com"),
    ctUser(102, "Omar", "Haddad", "omar@example.com"),
  ],
  ehEmployees: [ehEmployee(40213, "Jack", "Mitchell", "jack@example.com"), ehEmployee(40377, "Mia", "Chen-Wong", "mia@example.com")],
  assignments: [],
  employeeMap: [],
  pendingLinks: [],
  heldDetails: [],
  payrollIdFrom: "userId",
  ...over,
});

/** A stage whose screen presses `keys` (single characters, or "<name>"), then confirms. */
function stage(keys: string[], over: Partial<LinkStageDeps> = {}) {
  const out: string[] = [];
  const execute = vi.fn(async (_sql: string) => {});
  const deps: LinkStageDeps = {
    load: async () => data(),
    drive: async (screen: LinkScreen) => {
      for (const k of [...keys, "c", "y"]) {
        const name = /^<(.+)>$/.exec(k)?.[1];
        const done = screen.press(name ? undefined : k, { name: name ?? k });
        if (done) return done;
      }
      return "cancel";
    },
    execute,
    print: (line) => out.push(line),
    now: () => 1762790400000,
    ...over,
  };
  return { run: () => runLinkStage(deps), execute, out };
}

describe("runLinkStage", () => {
  it("writes exactly the links the admin confirmed: the email match and the one they chose", async () => {
    const s = stage(["<return>"]);
    await s.run();
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.execute).toHaveBeenCalledWith(
      "INSERT INTO pending_link (ct_user_id, eh_employee_id, confirmed_at) VALUES " +
        "(100, '40213', 1762790400000), (101, '40377', 1762790400000) " +
        "ON CONFLICT(ct_user_id) DO UPDATE SET eh_employee_id = excluded.eh_employee_id, confirmed_at = excluded.confirmed_at;",
    );
  });

  it("writes nothing when the admin cancels", async () => {
    const s = stage([], { drive: async () => "cancel" });
    await expect(s.run()).resolves.toBe("cancelled");
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.out.join("\n")).toContain("Nothing saved");
    expect(s.out.join("\n")).not.toContain("Held people sync");
  });

  it("writes nothing on a re-run that changes nothing", async () => {
    const saved = [
      { ctUserId: 100, ehEmployeeId: "40213" },
      { ctUserId: 101, ehEmployeeId: "40377" },
    ];
    const s = stage([], { load: async () => data({ pendingLinks: saved }) });
    await expect(s.run()).resolves.toBe("unchanged");
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.out.join("\n")).toContain("No changes to the Link list");
    // A re-run is when the reminder of when people sync is wanted.
    expect(s.out.join("\n")).toContain("Held people sync at the next daily recheck");
  });

  it("writes 'New hire, not this person' for a Held employee as a row with no EH id", async () => {
    const held = data({
      employeeMap: [{ ctUserId: 101, ehEmployeeId: null, lastOutcome: "existing_match", externalId: null }],
      heldDetails: [{ ctUserId: 101, detail: "existing_match: EH 40377 (email)" }],
    });
    // Mia's choices: 1) EH 40377, 2) New hire, not this person.
    const s = stage(["2"], { load: async () => held });
    await s.run();
    expect(s.execute.mock.calls[0]![0]).toContain("(101, NULL, 1762790400000)");
  });

  it("ends by saying what was saved and when people sync: held ones at the next daily recheck or on a profile edit", async () => {
    // Links Mia, then takes Omar's saved "new hire" off the list (row 3, in Everyone).
    const s = stage(["<return>", "<tab>", "<down>", "x"], { load: async () => data({ pendingLinks: [{ ctUserId: 102, ehEmployeeId: null }] }) });
    await expect(s.run()).resolves.toBe("saved");
    const out = s.out.join("\n");
    expect(out).toContain("Saved: 2 links added or changed, 1 taken off the Link list.");
    expect(out).toContain("Everyone else on the Link list is linked when their onboarding pack is approved.");
    expect(out).toContain("Held people sync at the next daily recheck, or straight away if their Connecteam profile is edited.");
  });

  describe("before the first deploy (ADR-0012)", () => {
    const nobodyInEh = async () => data({ ehEmployees: [] });

    it("asks before going live with an empty Link list, and stops on a no", async () => {
      const confirm = vi.fn(async () => false);
      const s = stage([], { load: nobodyInEh, beforeDeploy: { confirm } });
      await expect(s.run()).resolves.toBe("unconfirmed");
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("created as a new employee in Employment Hero"));
      expect(s.out.join("\n")).toContain("nothing is live yet");
    });

    it("carries on with an empty Link list once the admin confirms nobody is already in EH", async () => {
      const s = stage([], { load: nobodyInEh, beforeDeploy: { confirm: async () => true } });
      await expect(s.run()).resolves.toBe("unchanged");
    });

    it("doesn't ask once someone is on the Link list", async () => {
      const confirm = vi.fn(async () => false);
      const s = stage(["<return>"], { beforeDeploy: { confirm } });
      await expect(s.run()).resolves.toBe("saved");
      expect(confirm).not.toHaveBeenCalled();
    });

    it("counts what the save leaves on the list: taking the only row off asks", async () => {
      // Jack's saved "new hire" is row 1 in Everyone.
      const confirm = vi.fn(async () => false);
      const s = stage(["<tab>", "x"], {
        load: async () => data({ ehEmployees: [], pendingLinks: [{ ctUserId: 100, ehEmployeeId: null }] }),
        beforeDeploy: { confirm },
      });
      await expect(s.run()).resolves.toBe("unconfirmed");
      expect(confirm).toHaveBeenCalled();
    });

    it("never asks on a cancel: nothing was decided", async () => {
      const confirm = vi.fn(async () => true);
      const s = stage([], { drive: async () => "cancel", beforeDeploy: { confirm } });
      await expect(s.run()).resolves.toBe("cancelled");
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it("in a rehearsal, shows what it would save and runs nothing", async () => {
    const s = stage(["<return>"], { rehearsal: true });
    await expect(s.run()).resolves.toBe("rehearsed");
    expect(s.execute).not.toHaveBeenCalled();
    const out = s.out.join("\n");
    expect(out).toContain("Rehearsal: nothing written. It would save 2 links added or changed.");
    expect(out).toContain("INSERT INTO pending_link");
    expect(out).not.toContain("Saved");
  });
});
