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

  it("lists who is waiting for a summary, oldest first, and clears only those named", async () => {
    await store.recordNotice("link", 3, 300, true);
    await store.recordNotice("link", 1, 100, true);
    await store.recordNotice("link", 2, 200, false);
    await store.recordNotice("existing_match", 9, 50, true);

    expect(await store.listRolledUp("link")).toEqual([
      { ctUserId: 1, at: 100 },
      { ctUserId: 3, at: 300 },
    ]);

    await store.clearRolledUp("link", [1]);
    expect(await store.listRolledUp("link")).toEqual([{ ctUserId: 3, at: 300 }]);
    expect(await store.listRolledUp("existing_match")).toEqual([{ ctUserId: 9, at: 50 }]);
    // A cleared notice still counts toward a burst.
    expect(await store.countRecentNotices("link", 0)).toBe(3);
  });

  it("clears nobody for an empty list", async () => {
    await store.recordNotice("link", 1, 100, true);
    await store.clearRolledUp("link", []);
    expect(await store.listRolledUp("link")).toHaveLength(1);
  });

  it("clears a go-live-sized summary, past D1's 100 bound parameters", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    await env.DB.batch(
      ids.map((id) => env.DB.prepare("INSERT INTO notice_rollup (kind, ct_user_id, at, rolled_up) VALUES ('existing_match', ?, 100, 1)").bind(id)),
    );

    await store.clearRolledUp("existing_match", ids);

    expect(await store.listRolledUp("existing_match")).toEqual([]);
  });
});
