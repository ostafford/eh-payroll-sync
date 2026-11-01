import { describe, it, expect } from "vitest";
import {
  correctionMessage,
  correctionMessages,
  managerEscalationMessage,
  followUpNoticeMessage,
  systemAlertMessage,
  collisionAlertMessage,
  friendlyLine,
  GENERIC_CORRECTION,
  personLabel,
  correctionTopics,
  firstSyncMessage,
  correctionFixedMessage,
  adminFirstSyncMessage,
  adminCorrectionFixedMessage,
} from "../src/sync/messages.js";
import { DEFAULT_AUTOMATED_NOTE, DEFAULT_PROFILE_PATH } from "../src/mapping/schema.js";
import type { EhFieldError } from "../src/eh/errors.js";

const PATH = DEFAULT_PROFILE_PATH;
const NOTE = DEFAULT_AUTOMATED_NOTE;

describe("personLabel", () => {
  it("is 'First Last (id)' when a name is known", () => {
    expect(personLabel({ ctUserId: 42, firstName: "Jane", lastName: "Smith" })).toBe("Jane Smith (42)");
  });
  it("uses whichever name parts are present", () => {
    expect(personLabel({ ctUserId: 42, firstName: "Jane" })).toBe("Jane (42)");
  });
  it("falls back to 'Connecteam user id' with no name", () => {
    expect(personLabel({ ctUserId: 42 })).toBe("Connecteam user 42");
    expect(personLabel({ ctUserId: 42, firstName: "  ", lastName: null })).toBe("Connecteam user 42");
  });
});

describe("friendlyLine - curated EH-error -> plain language", () => {
  const cases: Array<[EhFieldError, RegExp]> = [
    [{ field: "BankAccount1", reason: "BSB must contain 6 digits only" }, /BSB/],
    [{ field: "bankAccount1_AccountNumber", reason: "is invalid" }, /account number/],
    [{ field: "taxFileNumber", reason: "The tax file number is invalid." }, /Tax File Number/],
    [{ field: "(incomplete)", reason: "Basic Details are incomplete" }, /legal name/],
    [{ field: "(incomplete)", reason: "Tax Details are incomplete" }, /tax declaration/],
    [{ field: "startDate", reason: "is required" }, /start date/],
    [{ field: "dateOfBirth", reason: "must be a valid date" }, /date of birth/],
    [{ field: "employmentType", reason: "is not valid" }, /employment type/],
    [{ field: "residentialPostCode", reason: "is invalid" }, /postcode/],
    [{ field: "superFund1_MemberNumber", reason: "is required" }, /super fund/],
    [{ field: "(unknown)", reason: "Tax free threshold can only be claimed for Australian residents" }, /tax declaration/],
    [{ field: "claimTaxFreeThreshold", reason: "a non-resident for tax cannot claim the tax-free threshold - set that answer to No" }, /tax declaration/],
  ];
  it.each(cases)("%o -> %s", (err, re) => {
    expect(friendlyLine(err)).toMatch(re);
  });

  it("never echoes the raw EH reason text", () => {
    const line = friendlyLine({ field: "bankAccount1_BSB", reason: "BSB 083-170 failed the mod-97 checksum" });
    expect(line).not.toContain("083-170");
    expect(line).not.toContain("mod-97");
  });

  it("falls back to the generic actionable line for an unknown field", () => {
    expect(friendlyLine({ field: "someBrandNewField", reason: "computer says no" })).toBe(GENERIC_CORRECTION);
  });
});

describe("correctionMessage - naming the employee's own answer", () => {
  const tbc = { field: "claimTaxFreeThreshold", reason: "x", answer: { question: "Claim Tax Free Threshold?", value: "TBC", kind: "yesNo" as const } };
  const contractor = { field: "employmentType", reason: "x", answer: { question: "Employee Status", value: "Contractor", kind: "option" as const } };

  it("says which question and what they answered, and what's needed", () => {
    const msg = correctionMessage([tbc, contractor], "Profile > Payroll", "");
    expect(msg).toContain('❗ You answered "TBC" to **"Claim Tax Free Threshold?"** - please change it to Yes or No.');
    expect(msg).toContain('❗ You answered "Contractor" to **"Employee Status"** - please choose a different option.');
    expect(msg).not.toContain("missing or inconsistent");
  });

  it("splits into numbered parts when it won't fit, hiding nothing", () => {
    const bsb = { field: "bankAccount1_BSB", reason: "x" };
    const parts = correctionMessages([tbc, contractor, bsb], "Profile > Personal Information", DEFAULT_AUTOMATED_NOTE);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\(1 of 2\) ✏️ Hi - a few of the details you entered need a quick fix/);
    expect(parts[1]).toMatch(/^\(2 of 2\)\n❗ /);
    expect(parts[1]!.endsWith(`We'll sync again automatically once you save.\n\n${DEFAULT_AUTOMATED_NOTE}`)).toBe(true);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    const all = parts.join("\n");
    for (const s of ['"TBC"', '"Contractor"', "BSB"]) expect(all).toContain(s);
    expect(all).not.toContain("more");
  });

  it("is one unlabelled message when it fits", () => {
    expect(correctionMessages([tbc], "Profile > Payroll", DEFAULT_AUTOMATED_NOTE)).toEqual([
      correctionMessage([tbc], "Profile > Payroll", DEFAULT_AUTOMATED_NOTE),
    ]);
    expect(correctionMessage([tbc], "Profile > Payroll", "")).not.toMatch(/^\(1 of/);
  });

  it("never bolds the first line, which a phone's notification preview shows as typed", () => {
    for (const parts of [correctionMessages([tbc, contractor], "Profile > Payroll", ""), [managerEscalationMessage([tbc], { ctUserId: 1, firstName: "Sam", lastName: "Rivera" }, "")]]) {
      for (const p of parts) expect(p.split("\n")[0]).not.toContain("**");
    }
  });

  it("keeps the plain wording in the manager's copy", () => {
    const msg = managerEscalationMessage([tbc], undefined, "");
    expect(msg).not.toContain("You answered");
    expect(msg).toContain("tax declaration answers");
  });
});

describe("correctionMessage", () => {
  it("names each distinct field once, in plain language, under 500 chars", () => {
    const msg = correctionMessage([
      { field: "bankAccount1_BSB", reason: "BSB must contain 6 digits only" },
      { field: "bankAccount1_BSB", reason: "BSB is invalid" },
      { field: "taxFileNumber", reason: "The tax file number is invalid." },
    ], PATH, "");
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatchInlineSnapshot(`
      "✏️ Hi - a few of the details you entered need a quick fix before they can be saved to Employment Hero:

      ❗ Your bank BSB doesn't look right - check it's the 6-digit branch number for your account.
      ❗ Your Tax File Number doesn't appear to be valid - re-check the 9 digits.

      ➡️ To fix: go to **Profile > Personal Information** and update them.
      We'll sync again automatically once you save."
    `);
  });

  it("drops the generic catch-all once at least one specific line is present", () => {
    const msg = correctionMessage([
      { field: "startDate", reason: "is required" },
      { field: "mysteryField", reason: "nope" },
    ], PATH, "");
    expect(msg).toContain("start date");
    expect(msg).not.toContain(GENERIC_CORRECTION);
  });

  it("uses the generic line alone when nothing is recognised", () => {
    const msg = correctionMessage([{ field: "mysteryField", reason: "nope" }], PATH, "");
    expect(msg).toContain(GENERIC_CORRECTION);
  });
});

describe("managerEscalationMessage - naming the employee", () => {
  it("names them once, without doubled brackets", () => {
    const msg = managerEscalationMessage([{ field: "taxFileNumber", reason: "invalid" }], { ctUserId: 17760356, firstName: "Sam", lastName: "Rivera" }, "");
    expect(msg.split("\n")[0]).toBe(
      "Heads up: an employee you manage, Sam Rivera (17760356), has had their details fail to sync to Employment Hero three times in a row.",
    );
  });
});

describe("managerEscalationMessage", () => {
  it("frames it for the manager and lists the stuck fields, under 500 chars", () => {
    const msg = managerEscalationMessage([{ field: "taxFileNumber", reason: "invalid" }], undefined, "");
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatchInlineSnapshot(`
      "Heads up: an employee you manage has had their details fail to sync to Employment Hero three times in a row.

      They've been asked to correct:

      • Your Tax File Number doesn't appear to be valid - re-check the 9 digits.

      Please check in with them so their Employment Hero record can be completed."
    `);
  });
});

describe("followUpNoticeMessage", () => {
  it("addresses the admin channel with the follow-up reasons and the user ref", () => {
    const msg = followUpNoticeMessage(
      [
        'Employee marked "not an Australian resident for tax" - set the foreign-resident or working-holiday-maker tax scale in Employment Hero.',
        "Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.",
      ],
      { ctUserId: 17760356 },
    );
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toContain("17760356");
    expect(msg).toMatchInlineSnapshot(`
      "Employment Hero follow-up needed for Connecteam user 17760356:

      • Employee marked "not an Australian resident for tax" - set the foreign-resident or working-holiday-maker tax scale in Employment Hero.
      • Self-managed super fund (fund ABN given, no USI) - add the SMSF to the employee in Employment Hero manually.

      The sync completed with safe defaults - finish this by hand in Employment Hero."
    `);
  });

  it("still says something useful when given no reasons", () => {
    const msg = followUpNoticeMessage([], { ctUserId: 42 });
    expect(msg).toContain("review this record");
  });

  it("leads with the employee's name and keeps the id in brackets when a name is known", () => {
    const msg = followUpNoticeMessage(["x"], { ctUserId: 17760356, firstName: "Jane", lastName: "Smith" });
    expect(msg).toContain("Employment Hero follow-up needed for Jane Smith (17760356):");
  });
});

describe("systemAlertMessage", () => {
  it("names the user, includes the detail, says no employee action is possible, and how to retry", () => {
    const msg = systemAlertMessage("EH 503: service unavailable", { ctUserId: 42 });
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toMatchInlineSnapshot(`
      "Employment Hero sync failed for Connecteam user 42 and could not be retried.

      Detail: EH 503: service unavailable

      No employee action is possible - check the Employment Hero API status and credentials.

      Once fixed, edit their profile in Connecteam to sync again."
    `);
  });

  it("copes with an empty detail", () => {
    expect(systemAlertMessage("", { ctUserId: 42 })).toContain("No further detail");
  });
});

describe("collisionAlertMessage", () => {
  it("names both the EH employee id and the other Connecteam user, and says no employee action is possible", () => {
    const msg = collisionAlertMessage("14246310", { ctUserId: 17760361, firstName: "Noah", lastName: "Davidson" }, 14504723);
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toContain("Noah Davidson (17760361)");
    expect(msg).toContain("14246310");
    expect(msg).toContain("14504723");
    expect(msg).toMatch(/Tax File Number/i);
    expect(msg).toMatch(/No employee action is possible/);
  });
});

describe("length clamping", () => {
  it("keeps the 'where to fix it' line when a correction runs long", () => {
    // One error in every curated bucket - the composed message runs well past 500.
    const many: EhFieldError[] = [
      { field: "bankAccount1_BSB", reason: "bad" },
      { field: "bankAccount1_AccountNumber", reason: "bad" },
      { field: "bankAccount1_AccountName", reason: "bad" },
      { field: "taxFileNumber", reason: "bad" },
      { field: "australianResident", reason: "bad" },
      { field: "startDate", reason: "bad" },
      { field: "dateOfBirth", reason: "bad" },
      { field: "employmentType", reason: "bad" },
      { field: "gender", reason: "bad" },
      { field: "residentialPostCode", reason: "bad" },
      { field: "residentialState", reason: "bad" },
      { field: "residentialStreetAddress", reason: "bad" },
      { field: "emailAddress", reason: "bad" },
      { field: "mobilePhone", reason: "bad" },
      { field: "superFund1_MemberNumber", reason: "bad" },
      { field: "emergencyContact1_Name", reason: "bad" },
      { field: "surname", reason: "bad" },
    ];
    const parts = correctionMessages(many, PATH, NOTE);
    // At most 3 parts, each within the cap; past that, bullets are dropped (with a
    // count), not the closing line: the employee still learns where to go.
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500);
    const last = parts.at(-1)!;
    expect(last).toMatch(/\n❗ \.\.\.and \d+ more\n/);
    expect(last.endsWith(`➡️ To fix: go to **${PATH}** and update them.\nWe'll sync again automatically once you save.\n\n${NOTE}`)).toBe(true);
  });
});

describe("admin success notice", () => {
  const ref = { ctUserId: 42, firstName: "Jane", lastName: "Smith" };

  it("first sync names the person", () => {
    expect(adminFirstSyncMessage(ref)).toBe("✅ Jane Smith (42) has synced to Employment Hero.");
  });

  it("a fix names what was fixed, or 'details' when nothing is known", () => {
    expect(adminCorrectionFixedMessage(ref, ["tax file number"])).toBe(
      "✅ Jane Smith (42) fixed their tax file number and has now synced to Employment Hero.",
    );
    expect(adminCorrectionFixedMessage(ref, [])).toBe(
      "✅ Jane Smith (42) fixed their details and has now synced to Employment Hero.",
    );
  });
});

describe("employee success messages (issue #71)", () => {
  const err = (field: string, reason = "invalid"): EhFieldError => ({ field, reason });

  it("first sync says the details were received in Employment Hero", () => {
    expect(firstSyncMessage("")).toBe("Thanks, your details have now been received in Employment Hero.");
  });

  it("a fix names the topics the Correction asked about, in the order asked", () => {
    const topics = correctionTopics([err("bankAccounts[0].bsb"), err("taxFileNumber")]);
    expect(topics).toEqual(["bank details", "tax file number"]);
    expect(correctionFixedMessage(topics, "")).toBe(
      "Thanks, that's fixed: your bank details and tax file number have now been updated in Employment Hero.",
    );
  });

  it("agrees the verb with a single singular topic", () => {
    expect(correctionFixedMessage(["tax file number"], "")).toBe(
      "Thanks, that's fixed: your tax file number has now been updated in Employment Hero.",
    );
    expect(correctionFixedMessage(["bank details"], "")).toBe(
      "Thanks, that's fixed: your bank details have now been updated in Employment Hero.",
    );
  });

  it("lists three or more topics with commas", () => {
    expect(correctionFixedMessage(["address", "email address", "super details"], "")).toBe(
      "Thanks, that's fixed: your address, email address and super details have now been updated in Employment Hero.",
    );
  });

  it("collapses fields that share a topic, and falls back to 'details' when none is known", () => {
    expect(correctionTopics([err("bankAccounts[0].bsb"), err("bankAccounts[0].accountNumber")])).toEqual([
      "bank details",
    ]);
    expect(correctionTopics([err("residentialPostCode"), err("residentialSuburb")])).toEqual(["address"]);
    expect(correctionTopics([err("somethingUnheardOf", "odd")])).toEqual([]);
    expect(correctionFixedMessage([], "")).toBe(
      "Thanks, that's fixed: your details have now been updated in Employment Hero.",
    );
  });

  it("never claims the record is Complete (an Incomplete record awaiting an admin is still a success)", () => {
    for (const text of [firstSyncMessage(""), correctionFixedMessage(["bank details"], ""), correctionFixedMessage([], "")]) {
      expect(text).not.toMatch(/complete/i);
    }
  });
});

describe("automated note", () => {
  const tfn: EhFieldError[] = [{ field: "taxFileNumber", reason: "invalid" }];

  it("ends every message to a person", () => {
    for (const text of [
      correctionMessage(tfn, PATH, NOTE),
      managerEscalationMessage(tfn, undefined, NOTE),
      firstSyncMessage(NOTE),
      correctionFixedMessage(["tax file number"], NOTE),
      correctionFixedMessage([], NOTE),
    ]) {
      expect(text.endsWith(`\n\n${NOTE}`)).toBe(true);
    }
  });

  it("reads as the last line of a first-sync message", () => {
    expect(firstSyncMessage(NOTE)).toBe(
      "Thanks, your details have now been received in Employment Hero.\n\nThis is an automated message from the Employment Hero sync.",
    );
  });

  it("a client's own wording replaces it, and blank leaves it off", () => {
    expect(firstSyncMessage("Sent automatically by Acme HR.")).toMatch(/\n\nSent automatically by Acme HR\.$/);
    expect(firstSyncMessage("")).toBe("Thanks, your details have now been received in Employment Hero.");
    expect(firstSyncMessage("   ")).toBe("Thanks, your details have now been received in Employment Hero.");
  });

  it("isn't added to admin-channel messages", () => {
    const ref = { ctUserId: 42, firstName: "Jane", lastName: "Smith" };
    for (const text of [
      adminFirstSyncMessage(ref),
      adminCorrectionFixedMessage(ref, ["tax file number"]),
      followUpNoticeMessage(["x"], ref),
      systemAlertMessage("detail", ref),
    ]) {
      expect(text).not.toContain("automated message");
    }
  });
});
