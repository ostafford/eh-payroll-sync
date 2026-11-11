import { describe, it, expect } from "vitest";
import { createOnce, deleteRunEmployees, findLeftovers, TEST_NAME } from "./support/eh-live.js";
import type { EhEmployee, EhEmployeePayload } from "../src/eh/types.js";

const PAYROLL_ID = "ZZZTEST-1";
const PAYLOAD: EhEmployeePayload = { ...TEST_NAME };

/**
 * An in-memory EH business. `lostCreates` POSTs land but report `retryable`
 * (a 5xx after EH saved it); each lands only after `lookupLag` more
 * lookups by external id, as EH's read side catches up.
 */
function fakeEh(opts: { lostCreates?: number; lookupLag?: number; lookupsFail?: boolean } = {}) {
  const employees: EhEmployee[] = [];
  let lostCreates = opts.lostCreates ?? 0;
  let hiddenFor = 0;
  let nextId = 100;
  const posts: EhEmployeePayload[] = [];
  const deleted: number[] = [];
  return {
    employees,
    posts,
    deleted,
    /** Answers `field eq 'value'` clauses joined by `and`, case-insensitively. */
    async findEmployees(filter: string) {
      const clauses = filter.split(" and ").map((c) => {
        const m = /^(\w+) eq '(.*)'$/.exec(c);
        if (!m) throw new Error(`fake EH can't read filter: ${c}`);
        return [m[1]!, m[2]!.replace(/''/g, "'").toLowerCase()] as const;
      });
      const hits = employees.filter((e) => clauses.every(([f, v]) => String(e[f] ?? "").toLowerCase() === v));
      return { outcome: "ok" as const, data: hits };
    },
    async deleteEmployee(id: number) {
      const at = employees.findIndex((e) => e.id === id);
      if (at >= 0) employees.splice(at, 1);
      deleted.push(id);
      return { outcome: "ok" as const, data: null };
    },
    async getByExternalId(externalId: string) {
      if (opts.lookupsFail) return { outcome: "retryable" as const, status: 429, detail: "rate limited" };
      if (hiddenFor > 0) {
        hiddenFor--;
        return { outcome: "ok" as const, data: null };
      }
      return { outcome: "ok" as const, data: employees.find((e) => e.externalId === externalId) ?? null };
    },
    async upsertByExternalId(externalId: string, payload: EhEmployeePayload, current?: EhEmployee | null) {
      if (current !== null) throw new Error("createOnce must pass current: null, so the client never looks up");
      posts.push(payload);
      const id = nextId++;
      employees.push({ id, externalId, status: "Incomplete", ...payload });
      if (lostCreates > 0) {
        lostCreates--;
        hiddenFor = opts.lookupLag ?? 0;
        return { outcome: "retryable" as const, status: 503, detail: "unavailable" };
      }
      return {
        outcome: "ok" as const,
        data: {
          id,
          status: "Incomplete",
          detailedStatus: "Basic Details are incomplete",
          operationType: "Create",
          created: true,
        },
      };
    },
  };
}

const noWait = async () => {};

describe("createOnce", () => {
  it("gives up rather than POSTing again when no lookup can say whether the create landed", async () => {
    const eh = fakeEh({ lostCreates: 1, lookupsFail: true });
    const r = await createOnce(eh, PAYROLL_ID, PAYLOAD, { sleep: noWait });
    expect(eh.posts).toHaveLength(1);
    expect(r.outcome).toBe("retryable");
  });

  it("finds a create that landed despite a retryable result, instead of creating a second", async () => {
    const eh = fakeEh({ lostCreates: 1, lookupLag: 1 });
    const r = await createOnce(eh, PAYROLL_ID, PAYLOAD, { sleep: noWait });
    expect(eh.employees).toHaveLength(1);
    expect(r).toMatchObject({ outcome: "ok", data: { id: 100, created: true } });
  });

  it("posts again only once lookups show the first create never landed", async () => {
    const eh = fakeEh();
    let failNext = true;
    const flaky = {
      ...eh,
      async upsertByExternalId(id: string, p: EhEmployeePayload, c?: EhEmployee | null) {
        if (failNext) {
          failNext = false;
          return {
            outcome: "retryable" as const,
            status: 503,
            detail: "unavailable",
          };
        }
        return eh.upsertByExternalId(id, p, c);
      },
    };
    const r = await createOnce(flaky, PAYROLL_ID, PAYLOAD, { sleep: noWait });
    expect(eh.employees).toHaveLength(1);
    expect(r).toMatchObject({ outcome: "ok", data: { created: true } });
  });
});

describe("deleteRunEmployees", () => {
  it("deletes every employee carrying the run's Payroll ID, duplicates included, and no one else", async () => {
    const eh = fakeEh({ lostCreates: 2 });
    await eh.upsertByExternalId(PAYROLL_ID, PAYLOAD, null);
    await eh.upsertByExternalId(PAYROLL_ID, PAYLOAD, null);
    await eh.upsertByExternalId("ZZZTEST-other-run", PAYLOAD, null);

    const r = await deleteRunEmployees(eh, PAYROLL_ID);

    expect(r).toEqual({ outcome: "ok", data: [100, 101] });
    expect(eh.employees.map((e) => e.externalId)).toEqual(["ZZZTEST-other-run"]);
  });
});

describe("deleteRunEmployees, when EH ignores the filter", () => {
  it("deletes only rows that carry the run's Payroll ID", async () => {
    const eh = fakeEh();
    await eh.upsertByExternalId(PAYROLL_ID, PAYLOAD, null);
    await eh.upsertByExternalId("EMP-7", PAYLOAD, null);
    const everyone = { ...eh, findEmployees: async () => ({ outcome: "ok" as const, data: [...eh.employees] }) };

    const r = await deleteRunEmployees(everyone, PAYROLL_ID);

    expect(r).toEqual({ outcome: "ok", data: [100] });
    expect(eh.employees.map((e) => e.externalId)).toEqual(["EMP-7"]);
  });
});

describe("findLeftovers", () => {
  it("reports earlier runs' ZZZTEST- employees and leaves them be", async () => {
    const eh = fakeEh();
    await eh.upsertByExternalId("ZZZTEST-111", PAYLOAD, null);
    await eh.upsertByExternalId("ZZZTEST-222", PAYLOAD, null);
    await eh.upsertByExternalId("EMP-7", PAYLOAD, null); // a real Payroll ID on a same-named person
    await eh.upsertByExternalId("ZZZTEST-333", { firstName: "Real", surname: "Person" }, null);

    const r = await findLeftovers(eh);

    expect(r).toEqual({
      outcome: "ok",
      data: [
        { id: 100, externalId: "ZZZTEST-111" },
        { id: 101, externalId: "ZZZTEST-222" },
      ],
    });
    expect(eh.deleted).toEqual([]);
  });

  it("deletes them too when asked", async () => {
    const eh = fakeEh();
    await eh.upsertByExternalId("ZZZTEST-111", PAYLOAD, null);
    await eh.upsertByExternalId("EMP-7", PAYLOAD, null);

    const r = await findLeftovers(eh, { delete: true });

    expect(r).toEqual({
      outcome: "ok",
      data: [{ id: 100, externalId: "ZZZTEST-111" }],
    });
    expect(eh.employees.map((e) => e.externalId)).toEqual(["EMP-7"]);
  });
});
