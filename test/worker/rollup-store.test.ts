/**
 * The `notice_rollup` table behind the Bulk summary (#193), against real local
 * D1 with every migration applied.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { SyncStore } from "../../src/db/store.js";

const store = new SyncStore(env.DB);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM notice_rollup").run();
});

describe("notice_rollup", () => {
  it("counts each kind's notices since a time, sent or rolled up", async () => {
    await store.recordNotice("existing_match", 1, 100, false);
    await store.recordNotice("existing_match", 2, 200, true);
    await store.recordNotice("existing_match", 3, 300, false);
    await store.recordNotice("link", 4, 300, false);

    expect(await store.countRecentNotices("existing_match", 200)).toBe(2);
    expect(await store.countRecentNotices("existing_match", 0)).toBe(3);
    expect(await store.countRecentNotices("link", 0)).toBe(1);
  });

  it("keeps one row per person and kind: a later notice replaces the earlier one", async () => {
    await store.recordNotice("existing_match", 1, 100, true);
    await store.recordNotice("existing_match", 1, 500, false);

    expect(await store.countRecentNotices("existing_match", 0)).toBe(1);
    expect(await store.countRecentNotices("existing_match", 500)).toBe(1);
    expect(await store.listRolledUp("existing_match")).toEqual([]);
  });

  it("lists who is waiting for a summary, oldest first", async () => {
    await store.recordNotice("link", 3, 300, true);
    await store.recordNotice("link", 1, 100, true);
    await store.recordNotice("link", 2, 200, false);
    await store.recordNotice("existing_match", 9, 50, true);

    expect(await store.listRolledUp("link")).toEqual([
      { ctUserId: 1, at: 100, summaryAt: null },
      { ctUserId: 3, at: 300, summaryAt: null },
    ]);
  });

  it("picks everyone waiting for one summary, then clears only them", async () => {
    await store.recordNotice("link", 1, 100, true);
    await store.recordNotice("link", 2, 200, true);
    await store.recordNotice("existing_match", 9, 50, true);

    expect(await store.assignSummary("link", 1000)).toBe(2);
    // Rolled up after the pick: waits for the next summary.
    await store.recordNotice("link", 3, 1001, true);

    await store.clearSummary("link", 1000);

    expect(await store.listRolledUp("link")).toEqual([{ ctUserId: 3, at: 1001, summaryAt: null }]);
    expect(await store.listRolledUp("existing_match")).toEqual([{ ctUserId: 9, at: 50, summaryAt: null }]);
    // A cleared notice still counts toward a burst.
    expect(await store.countRecentNotices("link", 0)).toBe(3);
  });

  it("puts a summary that never went out back to waiting", async () => {
    await store.recordNotice("link", 1, 100, true);
    await store.assignSummary("link", 1000);
    expect(await store.listRolledUp("link")).toEqual([{ ctUserId: 1, at: 100, summaryAt: 1000 }]);

    await store.releaseSummary("link", 1000);

    expect(await store.listRolledUp("link")).toEqual([{ ctUserId: 1, at: 100, summaryAt: null }]);
  });

  it("takes someone rolled up again out of the summary they were picked for: theirs is a new notice", async () => {
    await store.recordNotice("existing_match", 1, 100, true);
    await store.assignSummary("existing_match", 1000);
    await store.recordNotice("existing_match", 1, 2000, true);

    await store.clearSummary("existing_match", 1000);

    expect(await store.listRolledUp("existing_match")).toEqual([{ ctUserId: 1, at: 2000, summaryAt: null }]);
  });

  it("picks and clears a go-live-sized summary in one statement each", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    await env.DB.batch(
      ids.map((id) => env.DB.prepare("INSERT INTO notice_rollup (kind, ct_user_id, at, rolled_up) VALUES ('existing_match', ?, 100, 1)").bind(id)),
    );

    expect(await store.assignSummary("existing_match", 1000)).toBe(150);
    await store.clearSummary("existing_match", 1000);

    expect(await store.listRolledUp("existing_match")).toEqual([]);
  });
});
