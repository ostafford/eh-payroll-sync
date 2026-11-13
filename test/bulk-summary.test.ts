import { describe, it, expect, vi } from "vitest";
import { runBulkSummaries, BULK_SUMMARY_QUIET_MS, BULK_SUMMARY_MAX_WAIT_MS } from "../src/sync/rollup.js";
import { bulkSummaryMessage } from "../src/sync/messages.js";
import type { RollupKind } from "../src/sync/gateway.js";
import { fakeCt, fakeGateway } from "./support/sync-fakes.js";

const NOW = 1_000_000_000;
const MINUTE = 60 * 1000;

/** People waiting for a Bulk summary, rolled up at these times. Their ids run from 101. */
function waiting(kind: RollupKind, ...at: number[]) {
  const store = fakeGateway();
  at.forEach((t, i) => store.rollups.set(`${kind}:${101 + i}`, { kind, ctUserId: 101 + i, at: t, rolledUp: true }));
  return store;
}
const stillWaiting = (store: ReturnType<typeof fakeGateway>) =>
  [...store.rollups.values()].filter((r) => r.rolledUp).map((r) => r.ctUserId);

function summarise(store: ReturnType<typeof fakeGateway>, ct = fakeCt(null), now = NOW) {
  return runBulkSummaries({ store, ct, adminChannelId: "chan-1", now: () => now }).then((result) => ({ result, ct }));
}

describe("bulkSummaryMessage (#193)", () => {
  it("counts the Held people and says where to resolve them", () => {
    expect(bulkSummaryMessage("existing_match", 109)).toBe(
      "⚠️ Held: 109 more people may already be in Employment Hero, so nothing was written for them.\n\n" +
        "➡️ To fix: re-run the setup wizard's link stage, which lists each of them, and either link them to the right employee or mark them **New hire, not this person**. `GET /status` also lists them, as waiting on admin.\n\n" +
        "They'll sync at the next daily recheck, or straight away when their profile is edited.",
    );
  });

  it("counts the Linked employees", () => {
    expect(bulkSummaryMessage("link", 98)).toBe(
      "🔗 98 more Pre-existing employees are now linked to Employment Hero.\n\n" +
        "For each, only the Payroll ID was set, or nothing was written if Employment Hero already had it. From now on, only what they change in Connecteam is synced.",
    );
  });

  it("counts the employees who synced and says where each is listed (#199)", () => {
    expect(bulkSummaryMessage("admin_success", 12)).toBe(
      "✅ 12 more employees have synced to Employment Hero.\n\n`GET /status` lists each of them, as ready.",
    );
  });

  it("reads right for one person", () => {
    expect(bulkSummaryMessage("existing_match", 1)).toContain("⚠️ Held: 1 more person may already be in Employment Hero");
    expect(bulkSummaryMessage("existing_match", 1)).toContain("which lists them,");
    expect(bulkSummaryMessage("link", 1)).toContain("🔗 1 more Pre-existing employee is now linked");
    expect(bulkSummaryMessage("admin_success", 1)).toBe(
      "✅ 1 more employee has synced to Employment Hero.\n\n`GET /status` lists them, as ready.",
    );
  });

  it("fits one Connecteam message, so the clamp never cuts the fix off", () => {
    for (const kind of ["existing_match", "link", "admin_success"] as const) expect(bulkSummaryMessage(kind, 99_999).length).toBeLessThanOrEqual(500);
  });

  it("never names anyone: a count only", () => {
    expect(bulkSummaryMessage("existing_match", 3)).not.toMatch(/\(\d{3,}\)/);
  });
});

describe("runBulkSummaries (#193)", () => {
  it("sends nothing when nobody is waiting", async () => {
    const { result, ct } = await summarise(fakeGateway());
    expect(result).toEqual({ existing_match: "none", link: "none", admin_success: "none" });
    expect(ct.channels).toEqual([]);
  });

  it("waits while the burst is still going", async () => {
    const store = waiting("existing_match", NOW - 6 * MINUTE, NOW - MINUTE);
    const { result, ct } = await summarise(store);
    expect(result.existing_match).toBe("waiting");
    expect(ct.channels).toEqual([]);
    expect(stillWaiting(store)).toEqual([101, 102]);
  });

  it("posts one summary once the burst has been quiet for 3 minutes, and stops them waiting", async () => {
    const store = waiting("existing_match", NOW - 8 * MINUTE, NOW - 5 * MINUTE, NOW - BULK_SUMMARY_QUIET_MS);
    const { result, ct } = await summarise(store);

    expect(result.existing_match).toBe("sent");
    expect(ct.channels).toEqual([{ id: "chan-1", text: bulkSummaryMessage("existing_match", 3) }]);
    expect(stillWaiting(store)).toEqual([]);

    // The next tick has nothing left to post.
    await summarise(store, ct, NOW + MINUTE);
    expect(ct.channels).toHaveLength(1);
  });

  it("posts after 30 minutes even if the burst is still going, so the channel isn't silent through a long drain", async () => {
    const store = waiting("link", NOW - BULK_SUMMARY_MAX_WAIT_MS, NOW - MINUTE);
    const { result, ct } = await summarise(store);
    expect(result.link).toBe("sent");
    expect(ct.channels).toEqual([{ id: "chan-1", text: bulkSummaryMessage("link", 2) }]);
  });

  it("posts each kind as its own summary", async () => {
    const store = waiting("existing_match", NOW - 10 * MINUTE);
    store.rollups.set("link:201", { kind: "link", ctUserId: 201, at: NOW - 10 * MINUTE, rolledUp: true });
    store.rollups.set("admin_success:301", { kind: "admin_success", ctUserId: 301, at: NOW - 10 * MINUTE, rolledUp: true });
    store.rollups.set("admin_success:302", { kind: "admin_success", ctUserId: 302, at: NOW - 10 * MINUTE, rolledUp: true });
    const { result, ct } = await summarise(store);

    expect(result).toEqual({ existing_match: "sent", link: "sent", admin_success: "sent" });
    expect(ct.channels.map((c) => c.text)).toEqual([
      bulkSummaryMessage("existing_match", 1),
      bulkSummaryMessage("link", 1),
      bulkSummaryMessage("admin_success", 2),
    ]);
  });

  it("keeps them waiting when the send fails, and the next tick sends it", async () => {
    const store = waiting("existing_match", NOW - 10 * MINUTE, NOW - 10 * MINUTE);
    const ct = fakeCt(null);
    ct.failSends.set("chan-1", 1);

    expect((await summarise(store, ct)).result.existing_match).toBe("failed");
    expect(ct.channels).toEqual([]);
    expect(stillWaiting(store)).toEqual([101, 102]);

    expect((await summarise(store, ct, NOW + MINUTE)).result.existing_match).toBe("sent");
    expect(ct.channels).toHaveLength(1);
  });

  it("keeps them waiting when the send throws, and logs the failure", async () => {
    const store = waiting("link", NOW - 10 * MINUTE);
    const ct = fakeCt(null);
    const send = ct.sendChannelMessage.bind(ct);
    let throws = 1;
    ct.sendChannelMessage = (async (id: string, text: string) => {
      if (throws-- > 0) throw new Error("network");
      return send(id, text);
    }) as typeof ct.sendChannelMessage;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect((await summarise(store, ct)).result.link).toBe("failed");
    expect(stillWaiting(store)).toEqual([101]);
    expect(log.mock.calls.flat().join("\n")).toContain('"notice":"bulk_summary"');
    log.mockRestore();

    expect((await summarise(store, ct, NOW + MINUTE)).result.link).toBe("sent");
  });

  it("doesn't post a summary twice when the tick that sent it crashed before clearing (ADR-0007)", async () => {
    const store = waiting("existing_match", NOW - 10 * MINUTE, NOW - 10 * MINUTE);
    const ct = fakeCt(null);
    store.failRollup.clear = 1;
    await expect(summarise(store, ct)).rejects.toThrow("evicted");
    expect(ct.channels).toHaveLength(1);

    const { result } = await summarise(store, ct, NOW + MINUTE);

    expect(result.existing_match).toBe("none");
    expect(ct.channels).toHaveLength(1);
    expect(stillWaiting(store)).toEqual([]);
  });

  it("doesn't count a crashed tick's people again when more roll up before the next tick", async () => {
    const store = waiting("existing_match", NOW - 10 * MINUTE, NOW - 10 * MINUTE);
    const ct = fakeCt(null);
    store.failRollup.clear = 1;
    await expect(summarise(store, ct)).rejects.toThrow("evicted");
    await store.recordNotice("existing_match", 103, NOW + 30_000, true);

    await summarise(store, ct, NOW + 30_000 + BULK_SUMMARY_QUIET_MS);

    expect(ct.channels.map((c) => c.text)).toEqual([
      bulkSummaryMessage("existing_match", 2),
      bulkSummaryMessage("existing_match", 1),
    ]);
    expect(stillWaiting(store)).toEqual([]);
  });

  it("counts a crashed tick's people next time when its summary never went out", async () => {
    const store = waiting("link", NOW - 10 * MINUTE, NOW - 10 * MINUTE);
    // A tick that crashed after picking these two for its summary, before claiming or sending it.
    for (const r of store.rollups.values()) r.summaryAt = NOW - 5 * MINUTE;

    const { result, ct } = await summarise(store);

    expect(result.link).toBe("sent");
    expect(ct.channels).toEqual([{ id: "chan-1", text: bulkSummaryMessage("link", 2) }]);
    expect(stillWaiting(store)).toEqual([]);
  });

  it("leaves anyone who rolls up while the summary is sending for the next one", async () => {
    const store = waiting("link", NOW - 10 * MINUTE);
    const ct = fakeCt(null);
    const send = ct.sendChannelMessage.bind(ct);
    ct.sendChannelMessage = (async (id: string, text: string) => {
      await store.recordNotice("link", 202, NOW, true);
      return send(id, text);
    }) as typeof ct.sendChannelMessage;

    await summarise(store, ct);

    expect(ct.channels.map((c) => c.text)).toEqual([bulkSummaryMessage("link", 1)]);
    expect(stillWaiting(store)).toEqual([202]);
  });

  it("posts a new summary for the same people a week later, when their holds are re-posted", async () => {
    const WEEK = 7 * 24 * 60 * MINUTE;
    const store = waiting("existing_match", NOW - 10 * MINUTE);
    const ct = fakeCt(null);
    await summarise(store, ct);
    store.rollups.set("existing_match:101", { kind: "existing_match", ctUserId: 101, at: NOW + WEEK, rolledUp: true });

    await summarise(store, ct, NOW + WEEK + 10 * MINUTE);

    expect(ct.channels).toHaveLength(2);
  });
});
