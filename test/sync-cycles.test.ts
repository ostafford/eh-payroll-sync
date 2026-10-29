import { describe, it, expect } from "vitest";
import {
  advanceCycle,
  directManagerUserId,
  type CycleStore,
  MANAGER_ESCALATION_CYCLE,
  DIRECT_MANAGER_FIELD_ID,
} from "../src/sync/cycles.js";
import type { SyncDecision } from "../src/sync/decide.js";

function fakeStore(initial = 0): CycleStore & { count: number; sets: number[] } {
  return {
    count: initial,
    sets: [],
    async getFailureCount() {
      return this.count;
    },
    async setFailureCount(_id: number, count: number) {
      this.count = count;
      this.sets.push(count);
    },
  };
}

const correction: SyncDecision = { kind: "correction", fields: [{ field: "taxFileNumber", reason: "invalid" }] };
const clean: SyncDecision = { kind: "ok" };

describe("advanceCycle - correction cycles", () => {
  it("first two failed cycles message the employee only", async () => {
    const store = fakeStore(0);

    const first = await advanceCycle(store, 1, correction);
    expect(first).toEqual({ action: "correction", cycle: 1, notifyManager: false });

    const second = await advanceCycle(store, 1, correction);
    expect(second).toEqual({ action: "correction", cycle: 2, notifyManager: false });

    expect(store.count).toBe(2);
  });

  it("the third consecutive failed cycle also messages the Direct manager", async () => {
    const store = fakeStore(2);
    const third = await advanceCycle(store, 1, correction);
    expect(third).toEqual({ action: "correction", cycle: MANAGER_ESCALATION_CYCLE, notifyManager: true });
    expect(store.count).toBe(3);
  });

  it("keeps escalating on cycles beyond the third", async () => {
    const store = fakeStore(3);
    const fourth = await advanceCycle(store, 1, correction);
    expect(fourth).toEqual({ action: "correction", cycle: 4, notifyManager: true });
  });
});

describe("advanceCycle - resets", () => {
  it("a clean sync after failures resets the count and reports it", async () => {
    const store = fakeStore(2);
    const out = await advanceCycle(store, 1, clean);
    expect(out).toEqual({ action: "reset", previous: 2 });
    expect(store.count).toBe(0);
    expect(store.sets).toEqual([0]);
  });

  it("a clean sync with no prior failures touches nothing", async () => {
    const store = fakeStore(0);
    const out = await advanceCycle(store, 1, clean);
    expect(out).toEqual({ action: "none" });
    expect(store.sets).toEqual([]);
  });

  it("a synced-with-follow-up also clears a prior failure count", async () => {
    const store = fakeStore(2);
    const out = await advanceCycle(store, 1, { kind: "follow_up", reasons: ["SMSF"] });
    expect(out).toEqual({ action: "follow_up" });
    expect(store.count).toBe(0);
  });

  it("a follow-up with no prior failures does not write", async () => {
    const store = fakeStore(0);
    await advanceCycle(store, 1, { kind: "follow_up", reasons: ["SMSF"] });
    expect(store.sets).toEqual([]);
  });
});

describe("advanceCycle - retry", () => {
  it("a retry is a system alert and leaves the failure count untouched", async () => {
    const store = fakeStore(1);
    const out = await advanceCycle(store, 1, { kind: "retry", detail: "EH 503" });
    expect(out).toEqual({ action: "system_alert" });
    expect(store.count).toBe(1);
    expect(store.sets).toEqual([]);
  });
});

describe("directManagerUserId", () => {
  const wrap = (value: unknown) => [{ customFieldId: DIRECT_MANAGER_FIELD_ID, value }];

  it("reads a plain integer userId", () => {
    expect(directManagerUserId(wrap(17760357))).toBe(17760357);
  });

  it("reads a numeric string", () => {
    expect(directManagerUserId(wrap("17760357"))).toBe(17760357);
  });

  it("unwraps a Connecteam dropdown-style array / object", () => {
    expect(directManagerUserId(wrap([{ id: 1, value: 17760357 }]))).toBe(17760357);
    expect(directManagerUserId(wrap({ value: "17760357" }))).toBe(17760357);
  });

  it("finds the field by its directManager type, whatever its id", () => {
    // Custom-field ids are per Connecteam account; the type is the same everywhere.
    expect(
      directManagerUserId([
        { customFieldId: 51234567, type: "str", value: 111 },
        { customFieldId: 51234568, type: "directManager", value: 17760357 },
      ]),
    ).toBe(17760357);
  });

  it("returns null when the field is absent, blank, zero or non-numeric", () => {
    expect(directManagerUserId([])).toBeNull();
    expect(directManagerUserId(wrap(""))).toBeNull();
    expect(directManagerUserId(wrap(0))).toBeNull();
    expect(directManagerUserId(wrap("not-a-number"))).toBeNull();
    expect(directManagerUserId(wrap(null))).toBeNull();
  });
});
