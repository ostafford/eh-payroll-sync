/**
 * Helpers for the live EH tests (#177): a create that is never repeated blind,
 * and cleanup that finds the run's employees by Payroll ID.
 */
import type { EhPayrollClient, EhResult } from "../../src/eh/client.js";
import type { EhEmployeePayload, EhEmployee } from "../../src/eh/types.js";

type WriteResult = Awaited<ReturnType<EhPayrollClient["upsertByExternalId"]>>;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Create the employee, never POSTing blind. A `retryable` result may still have
 * created it (the client stopped waiting, EH didn't), so look the Payroll ID
 * up, a few times as EH's reads catch up, and POST again only if none finds it.
 */
export async function createOnce(
  client: Pick<EhPayrollClient, "getByExternalId" | "upsertByExternalId">,
  externalId: string,
  payload: EhEmployeePayload,
  opts: { sleep?: (ms: number) => Promise<void>; attempts?: number; lookups?: number } = {},
): Promise<WriteResult> {
  const sleep = opts.sleep ?? sleepMs;
  let r!: WriteResult;
  for (let attempt = 0; attempt < (opts.attempts ?? 3); attempt++) {
    r = await client.upsertByExternalId(externalId, payload, null);
    if (r.outcome !== "retryable") return r;
    for (let i = 0; i < (opts.lookups ?? 4); i++) {
      await sleep(1000 * (i + 1));
      const found = await client.getByExternalId(externalId);
      if (found.outcome === "ok" && found.data) return landed(found.data);
    }
  }
  return r;
}

/** The write envelope for a create whose own result was lost. */
function landed(e: EhEmployee): WriteResult {
  return {
    outcome: "ok",
    data: { id: e.id, status: e.status ?? null, detailedStatus: null, operationType: null, created: true },
  };
}

/**
 * Delete every employee carrying this run's Payroll ID, found by lookup rather
 * than by a remembered id, so a create whose result was lost (or a duplicate)
 * still goes. Returns the ids deleted; a failed lookup or delete is returned
 * as is, for the caller to report.
 */
export async function deleteRunEmployees(
  client: Pick<EhPayrollClient, "findEmployees" | "deleteEmployee">,
  externalId: string,
): Promise<EhResult<number[]>> {
  const found = await client.findEmployees(`externalId eq ${odataString(externalId)}`);
  if (found.outcome !== "ok") return found;
  const ids: number[] = [];
  // Re-checked here so a filter EH ignored can never widen the delete.
  for (const e of found.data.filter((e) => e.externalId === externalId)) {
    const del = await client.deleteEmployee(e.id);
    if (del.outcome !== "ok") return del;
    ids.push(e.id);
  }
  return { outcome: "ok", data: ids };
}

function odataString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** Every live test employee carries this name and a Payroll ID with this prefix. */
export const TEST_NAME = { firstName: "Zztest", surname: "Alpha" } as const;
export const TEST_PREFIX = "ZZZTEST-";

/**
 * Test employees earlier runs left behind: the test name with a ZZZTEST-
 * Payroll ID. Matched on the name in EH and the prefix here, so it needs only
 * the `eq` filters the sync already relies on. `delete: true` also deletes them.
 */
export async function findLeftovers(
  client: Pick<EhPayrollClient, "findEmployees" | "deleteEmployee">,
  opts: { delete?: boolean } = {},
): Promise<EhResult<Array<{ id: number; externalId: string }>>> {
  const found = await client.findEmployees(
    `firstName eq ${odataString(TEST_NAME.firstName)} and surname eq ${odataString(TEST_NAME.surname)}`,
  );
  if (found.outcome !== "ok") return found;
  const leftovers = found.data.flatMap((e) =>
    e.externalId?.startsWith(TEST_PREFIX) ? [{ id: e.id, externalId: e.externalId }] : [],
  );
  if (opts.delete) {
    for (const { id } of leftovers) {
      const del = await client.deleteEmployee(id);
      if (del.outcome !== "ok") return del;
    }
  }
  return { outcome: "ok", data: leftovers };
}
