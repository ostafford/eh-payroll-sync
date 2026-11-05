import { describe, it, expect } from "vitest";
import {
  preCreateFilters,
  runPreCreateCheck,
  existingMatchDetail,
  heldCandidateIds,
  type ExistingMatch,
} from "../src/sync/precheck.js";
import { existingMatchMessages, existingMatchLine } from "../src/sync/messages.js";
import type { EhEmployeePayload } from "../src/eh/types.js";

const PAYLOAD: EhEmployeePayload = {
  firstName: "Samuel",
  surname: "Rivera",
  dateOfBirth: "1992-04-07",
  emailAddress: "sam.rivera@example.com",
  taxFileNumber: "123456782",
  residentialSuburb: "Carlton",
};

/** An EH row as the unstructured endpoint returns it: full values, DOB with a time. */
const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  externalId: null,
  firstName: "Samuel",
  surname: "Rivera",
  dateOfBirth: "1992-04-07T00:00:00",
  emailAddress: "Sam.Rivera@example.com",
  taxFileNumber: "123456782",
  status: "Active",
  ...over,
});

/** A fake EH that answers each filter by the field it starts with. */
function eh(answers: Partial<Record<"emailAddress" | "taxFileNumber" | "firstName", unknown[]>> = {}) {
  const filters: string[] = [];
  return {
    filters,
    async findEmployees(filter: string) {
      filters.push(filter);
      const field = filter.split(" ")[0] as keyof typeof answers;
      return { outcome: "ok" as const, data: (answers[field] ?? []) as never[] };
    },
  };
}

describe("preCreateFilters", () => {
  it("builds the email, TFN and name + DOB filters, in that order", () => {
    expect(preCreateFilters(PAYLOAD)).toEqual([
      { key: "email", filter: "emailAddress eq 'sam.rivera@example.com'" },
      { key: "tfn", filter: "taxFileNumber eq '123456782'" },
      {
        key: "nameDob",
        filter: "firstName eq 'Samuel' and surname eq 'Rivera' and dateOfBirth eq datetime'1992-04-07T00:00:00'",
      },
    ]);
  });

  it.each(["000000000", "111111111", "333333333", "444444444", "987654321"])(
    "skips the ATO placeholder TFN %s",
    (tfn) => {
      expect(preCreateFilters({ ...PAYLOAD, taxFileNumber: tfn }).map((f) => f.key)).toEqual(["email", "nameDob"]);
    },
  );

  it("never checks a name alone: no DOB means no name filter", () => {
    const { dateOfBirth: _, ...noDob } = PAYLOAD;
    expect(preCreateFilters(noDob).map((f) => f.key)).toEqual(["email", "tfn"]);
  });

  it("skips a key the payload doesn't have", () => {
    expect(preCreateFilters({ firstName: "Samuel", surname: "Rivera" })).toEqual([]);
  });

  it("doubles a single quote, so a name can't break the filter", () => {
    const [f] = preCreateFilters({ firstName: "Seán", surname: "O'Brien", dateOfBirth: "1990-01-02" });
    expect(f!.filter).toBe("firstName eq 'Seán' and surname eq 'O''Brien' and dateOfBirth eq datetime'1990-01-02T00:00:00'");
  });
});

describe("runPreCreateCheck", () => {
  it("is clear when no filter finds anyone, after running all three", async () => {
    const fake = eh();
    expect(await runPreCreateCheck(fake, PAYLOAD)).toEqual({ outcome: "ok", data: [] });
    expect(fake.filters).toHaveLength(3);
  });

  it.each([
    ["email", "emailAddress"],
    ["tfn", "taxFileNumber"],
    ["nameDob", "firstName"],
  ] as const)("is a hit on %s alone", async (key, field) => {
    const res = await runPreCreateCheck(eh({ [field]: [row(40213)] }), PAYLOAD);
    expect(res).toEqual({
      outcome: "ok",
      data: [{ ehEmployeeId: 40213, terminated: false, matched: [key], differs: [] }],
    });
  });

  it("gives one hit when keys disagree, naming the disagreement", async () => {
    const theirs = row(40213, { taxFileNumber: "876543217" });
    const res = await runPreCreateCheck(eh({ emailAddress: [theirs], firstName: [theirs] }), PAYLOAD);
    expect(res).toEqual({
      outcome: "ok",
      data: [{ ehEmployeeId: 40213, terminated: false, matched: ["email", "nameDob"], differs: ["tfn"] }],
    });
  });

  it("doesn't call a missing value a disagreement", async () => {
    const theirs = row(40213, { taxFileNumber: "", dateOfBirth: null });
    const res = await runPreCreateCheck(eh({ emailAddress: [theirs] }), PAYLOAD);
    expect(res.outcome === "ok" && res.data[0]!.differs).toEqual([]);
  });

  it("marks a terminated candidate, still as a hit", async () => {
    const res = await runPreCreateCheck(eh({ taxFileNumber: [row(40377, { status: "Terminated" })] }), PAYLOAD);
    expect(res).toMatchObject({ outcome: "ok", data: [{ ehEmployeeId: 40377, terminated: true, matched: ["tfn"] }] });
  });

  it("lists every candidate, by EH id", async () => {
    const res = await runPreCreateCheck(
      eh({ emailAddress: [row(50000, { taxFileNumber: "876543217" })], taxFileNumber: [row(40213, { emailAddress: "other@example.com" })] }),
      PAYLOAD,
    );
    expect(res.outcome === "ok" && res.data.map((m) => [m.ehEmployeeId, m.matched, m.differs])).toEqual([
      [40213, ["tfn"], ["email"]],
      [50000, ["email"], ["tfn"]],
    ]);
  });

  it("returns a failed lookup as is, without running the rest", async () => {
    const filters: string[] = [];
    const down = {
      async findEmployees(filter: string) {
        filters.push(filter);
        return { outcome: "retryable" as const, status: 429, detail: "rate limited" };
      },
    };
    expect(await runPreCreateCheck(down, PAYLOAD)).toEqual({ outcome: "retryable", status: 429, detail: "rate limited" });
    expect(filters).toHaveLength(1);
  });
});

describe("existingMatchDetail", () => {
  const matches: ExistingMatch[] = [
    { ehEmployeeId: 40213, terminated: false, matched: ["email", "nameDob"], differs: ["tfn"] },
    { ehEmployeeId: 40377, terminated: true, matched: ["tfn"], differs: [] },
  ];

  it("names ids and keys only", () => {
    expect(existingMatchDetail(matches)).toBe(
      "existing_match: EH 40213 (email, nameDob; tfn differs) | EH 40377 terminated (tfn)",
    );
  });

  it("round-trips the EH ids for the roster", () => {
    expect(heldCandidateIds(existingMatchDetail(matches))).toEqual(["40213", "40377"]);
  });
});

describe("Existing-match notice", () => {
  const person = { ctUserId: 17760356, firstName: "Samuel", lastName: "Rivera" };

  it("lists each candidate with the keys that matched or disagreed, terminated where it applies, and how to fix it", () => {
    const [text, ...rest] = existingMatchMessages(person, [
      { ehEmployeeId: 40213, terminated: false, matched: ["email", "nameDob"], differs: ["tfn"] },
      { ehEmployeeId: 40377, terminated: true, matched: ["tfn"], differs: [] },
    ]);
    expect(rest).toEqual([]);
    expect(text).toBe(
      [
        "⚠️ Held: Samuel Rivera (17760356) may already be in Employment Hero, so nothing was written for them.",
        "",
        "Possible matches:",
        "",
        "• EH 40213: email and name + date of birth match; TFN differs",
        "• EH 40377 (Terminated in EH): TFN matches",
        "",
        "➡️ To fix: re-run the setup wizard's link stage and either link them to the right employee or mark them **New hire, not this person**.",
        "",
        "They'll sync at the next daily recheck, or straight away when their profile is edited.",
      ].join("\n"),
    );
  });

  it("never shows a matched value (the name is the person's label, as on every admin notice)", () => {
    const text = existingMatchMessages(person, [
      { ehEmployeeId: 1, terminated: false, matched: ["email", "tfn", "nameDob"], differs: [] },
    ]).join("\n");
    for (const v of ["sam.rivera", "123456782", "1992", "04-07"]) expect(text.toLowerCase()).not.toContain(v);
  });

  it("splits a long notice into numbered parts, each within the cap, with nothing lost", () => {
    const many: ExistingMatch[] = Array.from({ length: 12 }, (_, i) => ({
      ehEmployeeId: 40000 + i,
      terminated: i % 2 === 0,
      matched: ["email", "nameDob"],
      differs: ["tfn"],
    }));
    const parts = existingMatchMessages(person, many);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(500);
      expect(p.startsWith(`(${i + 1} of ${parts.length})`)).toBe(true);
    });
    expect(parts[0]).toContain("⚠️ Held:");
    expect(parts.at(-1)).toContain("To fix:");
    for (const m of many) expect(parts.join("\n")).toContain(existingMatchLine(m));
  });
});
