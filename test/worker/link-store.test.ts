/**
 * The storage linking builds on (ADR-0009, ADR-0010), against real local D1
 * with every migration applied: `pending_link` rows and the linked state on
 * `employee_map`.
 */
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { SyncStore } from "../../src/db/store.js";
import { deriveRosterEntry } from "../../src/status/roster.js";

const store = new SyncStore(env.DB);
const baseline = { keyId: "k1", units: { phone: "fp-phone", bankAccount1: "fp-bank" } };

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM employee_map"), env.DB.prepare("DELETE FROM pending_link")]);
});

describe("pending_link", () => {
  it("adds, reads, lists and deletes a pending link", async () => {
    await store.savePendingLink({ ctUserId: 1, ehEmployeeId: "40213", confirmedAt: 100 });
    await store.savePendingLink({ ctUserId: 2, ehEmployeeId: null, confirmedAt: 200 });

    expect(await store.getPendingLink(1)).toEqual({ ctUserId: 1, ehEmployeeId: "40213", confirmedAt: 100 });
    expect(await store.getPendingLink(2)).toEqual({ ctUserId: 2, ehEmployeeId: null, confirmedAt: 200 });
    expect((await store.listPendingLinks()).map((l) => l.ctUserId).sort()).toEqual([1, 2]);

    await store.deletePendingLink(1);
    expect(await store.getPendingLink(1)).toBeNull();
    expect(await store.listPendingLinks()).toHaveLength(1);
  });

  it("replaces a person's pending link rather than adding a second", async () => {
    await store.savePendingLink({ ctUserId: 1, ehEmployeeId: "40213", confirmedAt: 100 });
    await store.savePendingLink({ ctUserId: 1, ehEmployeeId: "40999", confirmedAt: 300 });
    expect(await store.listPendingLinks()).toEqual([{ ctUserId: 1, ehEmployeeId: "40999", confirmedAt: 300 }]);
  });

  it("deleting someone with no pending link is a no-op", async () => {
    await expect(store.deletePendingLink(99)).resolves.toBeUndefined();
  });
});

describe("linked state on employee_map", () => {
  const link = { ctUserId: 7, ehEmployeeId: "40213", lastSyncedTs: 1, lastPayloadHash: "h", lastOutcome: "ok" as const };

  it("an ordinary row is not linked and has no baseline", async () => {
    await store.saveEmployeeLink(link);
    const row = await store.getEmployeeLink(7);
    expect(row?.linkedAt).toBeNull();
    expect(row?.baseline).toBeNull();
  });

  it("marks a row linked with its first baseline, then replaces the baseline", async () => {
    await store.saveEmployeeLink(link);
    await store.markLinked(7, 5000, baseline);
    expect(await store.getEmployeeLink(7)).toMatchObject({ linkedAt: 5000, baseline });

    const rolled = { keyId: "k1", units: { ...baseline.units, phone: "fp-phone-2" } };
    await store.saveBaseline(7, rolled);
    expect(await store.getEmployeeLink(7)).toMatchObject({ linkedAt: 5000, baseline: rolled });
  });

  it("a later full save keeps the linked state", async () => {
    await store.saveEmployeeLink(link);
    await store.markLinked(7, 5000, baseline);
    await store.saveEmployeeLink({ ...link, lastPayloadHash: "h2" });
    expect(await store.getEmployeeLink(7)).toMatchObject({ linkedAt: 5000, baseline, lastPayloadHash: "h2" });
  });

  it("stores fingerprints and the key id, nothing else", async () => {
    await store.saveEmployeeLink(link);
    await store.markLinked(7, 5000, baseline);
    const raw = await env.DB.prepare("SELECT baseline FROM employee_map WHERE ct_user_id = 7").first<{ baseline: string }>();
    expect(JSON.parse(raw!.baseline)).toEqual(baseline);
  });

  it("a baseline that can't be read comes back as null, not an error", async () => {
    await store.saveEmployeeLink(link);
    await env.DB.prepare("UPDATE employee_map SET linked_at = 1, baseline = 'not json' WHERE ct_user_id = 7").run();
    expect((await store.getEmployeeLink(7))?.baseline).toBeNull();
  });
});

describe("completeLink", () => {
  const patch = { ctUserId: 7, ehEmployeeId: "40213", lastSyncedTs: 1, lastPayloadHash: "h", lastOutcome: "ok" as const };

  it("saves the row linked with its Baseline and deletes the pending link, together", async () => {
    await store.savePendingLink({ ctUserId: 7, ehEmployeeId: "40213", confirmedAt: 100 });
    await store.completeLink(patch, 5000, baseline);

    expect(await store.getEmployeeLink(7)).toMatchObject({ ...patch, linkedAt: 5000, baseline, failureCycleCount: 0 });
    expect(await store.getPendingLink(7)).toBeNull();
  });

  it("links a Held employee's existing row", async () => {
    await store.saveEmployeeLink({ ...patch, ehEmployeeId: null, lastPayloadHash: null, lastOutcome: "existing_match" });
    await store.completeLink(patch, 5000, baseline);
    expect(await store.getEmployeeLink(7)).toMatchObject({ ehEmployeeId: "40213", lastOutcome: "ok", linkedAt: 5000 });
  });

  it("shows a Linked employee in the roster as ready and linked", async () => {
    await store.completeLink(patch, 5000, baseline);
    await store.saveEmployeeLink({ ...patch, ctUserId: 8 });
    const entries = (await store.listRosterRows()).map(deriveRosterEntry);
    expect(entries).toEqual([
      { ctUserId: 7, ehEmployeeId: "40213", state: "ready", reasons: [], linked: true },
      { ctUserId: 8, ehEmployeeId: "40213", state: "ready", reasons: [] },
    ]);
  });
});

describe("the stored match key (ADR-0011)", () => {
  const patch = { ctUserId: 7, ehEmployeeId: "40213", lastSyncedTs: 1, lastPayloadHash: "h", lastOutcome: "ok" as const };

  it("keeps the first key saved; a later save can't replace or clear it", async () => {
    await store.saveEmployeeLink({ ...patch, externalId: "P-100" });
    await store.saveEmployeeLink({ ...patch, lastPayloadHash: "h2", externalId: "P-200" });
    await store.saveEmployeeLink({ ...patch, lastPayloadHash: "h3", externalId: null });
    await store.saveEmployeeLink({ ...patch, lastPayloadHash: "h4" });
    expect(await store.getEmployeeLink(7)).toMatchObject({ externalId: "P-100", lastPayloadHash: "h4" });
  });

  it("a row saved without one has none", async () => {
    await store.saveEmployeeLink({ ...patch, ehEmployeeId: null, lastOutcome: "existing_match" });
    expect((await store.getEmployeeLink(7))?.externalId).toBeNull();
  });

  it("a link stores the key it was made with", async () => {
    await store.saveEmployeeLink({ ...patch, ehEmployeeId: null, lastOutcome: "existing_match" });
    await store.completeLink({ ...patch, externalId: "P-100" }, 5000, baseline);
    expect((await store.getEmployeeLink(7))?.externalId).toBe("P-100");
  });
});

describe("migration 0006 backfill", () => {
  // Setup already applied every migration, so re-run 0006 minus its ALTER
  // (the column exists) over rows shaped as they were before it: no key stored.
  const backfill = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0006_"))!.queries.filter(
    (q) => !/^\s*ALTER\s/i.test(q),
  );

  it("gives each row EH accepted a write for its userId, and leaves the rest without a key", async () => {
    const link = { lastSyncedTs: 1, lastPayloadHash: "h", lastOutcome: "ok" as const };
    await store.saveEmployeeLink({ ...link, ctUserId: 7, ehEmployeeId: "40213" });
    await store.completeLink({ ...link, ctUserId: 8, ehEmployeeId: "40214" }, 5000, baseline);
    await store.saveEmployeeLink({ ...link, ctUserId: 9, ehEmployeeId: null, lastPayloadHash: null, lastOutcome: "existing_match" });
    await store.setFailureCount(10, 1);
    await env.DB.prepare("UPDATE employee_map SET external_id = NULL").run();

    for (const q of backfill) await env.DB.prepare(q).run();

    const keys = Object.fromEntries(
      await Promise.all([7, 8, 9, 10].map(async (id) => [id, (await store.getEmployeeLink(id))?.externalId])),
    );
    expect(keys).toEqual({ 7: "7", 8: "8", 9: null, 10: null });
  });
});
