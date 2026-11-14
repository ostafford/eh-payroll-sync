/**
 * Live read-only probe for the un-approve question behind the cron sweep (#7):
 * when an admin un-approves an Onboarding pack, does the Onboarding API move it
 * out of `status: "completed"` (back to "in_progress"), or does it keep
 * "completed" and only change `isWaitingApproval`?
 *
 * `diffAssignments` in src/cron/sweep.ts assumes the former. Run this between
 * each Connecteam UI action to confirm:
 *
 *   1. pack Approved      ->  npx vitest run test/onboarding-status.integration.test.ts
 *   2. un-approve it      ->  run again, compare
 *   3. re-approve it      ->  run again, compare
 *
 * Skipped unless CT_API_KEY is set (test/setup.env.ts loads it from .dev.vars).
 * Read-only: it only calls GET /onboarding/v1/packs/{id}/assignments.
 */
import { describe, it } from "vitest";
import { ConnecteamClient } from "../src/connecteam/client.js";

const apiKey = process.env.CT_API_KEY;
const packId = Number(process.env.CT_ONBOARDING_PACK_ID) || 5474;
const live = apiKey ? describe : describe.skip;

live("Onboarding pack status probe (live account, read-only)", () => {
  it(`dumps every assignment's status for pack ${packId}`, async () => {
    const client = new ConnecteamClient({ apiKey: apiKey! });
    const r = await client.listAssignments(packId);

    if (r.outcome !== "ok") {
      console.log(`\nlistAssignments failed: ${r.outcome} ${"detail" in r ? r.detail : ""}\n`);
      return;
    }

    const rows = [...r.data]
      .sort((a, b) => a.userId - b.userId)
      .map((a) => ({
        assignmentId: a.id,
        userId: a.userId,
        status: a.status,
        isWaitingApproval: a.isWaitingApproval,
      }));

    const approved = rows.filter((x) => x.status === "completed").length;
    console.log(
      `\npack ${packId}: ${rows.length} assignment(s), ${approved} with status "completed" ` +
        `— rate-limit ${JSON.stringify(client.lastRateLimit)}`,
    );
    console.table(rows);
  });
});
