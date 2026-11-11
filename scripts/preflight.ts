/**
 * `npm run preflight`
 *
 * Read-only. Before go-live, lists what approval will do to each Connecteam
 * person in the onboarding pack, given the employees already in EH: linked,
 * created, held, or a Payroll ID used twice. The wizard runs it in the Field
 * map stage. See scripts/lib/preflight.ts for the rules.
 *
 * Exit code: 0 = nothing to look at, 2 = someone needs a look, 1 = the check
 * itself failed.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, CT_ONBOARDING_PACK_ID,
 * EH_API_KEY, EH_BUSINESS_ID.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConnecteamClient } from "../src/connecteam/client.js";
import { applyFieldMap, type ConnecteamUser } from "../src/mapping/apply.js";
import { loadFieldMap } from "../src/mapping/loader.js";
import type { FieldMap } from "../src/mapping/schema.js";
import {
  classifyAll,
  needsAttention,
  renderPreflight,
  type PreflightEhEmployee,
  type PreflightPerson,
} from "./lib/preflight.js";

// --- env -----------------------------------------------------------------

function loadDevVars(): void {
  try {
    const path = fileURLToPath(new URL("../.dev.vars", import.meta.url));
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/\r$/, "");
    }
  } catch {
    /* no .dev.vars - rely on the shell env */
  }
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set (in .dev.vars or the shell)`);
  return v;
}

// --- EH --------------------------------------------------------------------

const PAGE = 100;

async function listEhEmployees(businessId: string, apiKey: string): Promise<PreflightEhEmployee[]> {
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  const out: PreflightEhEmployee[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const url = `https://api.yourpayroll.com.au/api/v2/business/${businessId}/employee/unstructured?$top=${PAGE}&$skip=${skip}`;
    const r = await fetch(url, { headers: { authorization: auth, accept: "application/json" } });
    if (!r.ok) throw new Error(`Employment Hero employee list -> ${r.status} ${await r.text()}`);
    const page = (await r.json()) as Array<Record<string, unknown>>;
    for (const e of page) {
      // Only what the Pre-create check compares, plus the Payroll ID.
      out.push({
        id: Number(e.id),
        externalId: e.externalId,
        firstName: e.firstName,
        surname: e.surname,
        emailAddress: e.emailAddress,
        taxFileNumber: e.taxFileNumber,
        dateOfBirth: e.dateOfBirth,
      });
    }
    if (page.length < PAGE) return out;
  }
}

// --- Connecteam ----------------------------------------------------------

async function listPackPeople(
  ct: ConnecteamClient,
  packId: number,
  fieldMap: FieldMap,
): Promise<{ people: PreflightPerson[]; missing: number }> {
  const assignments = await ct.listAssignments(packId);
  if (assignments.outcome !== "ok") throw new Error(`Connecteam onboarding assignments -> ${assignments.status} ${assignments.detail}`);
  // Every assignee, approved or not: Pre-existing employees aren't approved yet.
  const userIds = [...new Set(assignments.data.map((a) => a.userId))];

  const people: PreflightPerson[] = [];
  let missing = 0;
  for (const [i, userId] of userIds.entries()) {
    process.stderr.write(`\rReading Connecteam people in the onboarding pack: ${i + 1}/${userIds.length}`);
    if ((ct.lastRateLimit?.minuteRemaining ?? Infinity) <= 1) await new Promise((r) => setTimeout(r, 60_000));
    const u = await ct.getUser(userId);
    if (u.outcome !== "ok") throw new Error(`Connecteam user ${userId} -> ${u.status} ${u.detail}`);
    if (!u.data) {
      missing++;
      continue;
    }
    // The same mapping the sync runs, so the key and details are exactly what EH would get.
    const mapped = applyFieldMap(u.data as unknown as ConnecteamUser, fieldMap, {});
    people.push({ ctUserId: userId, key: mapped.externalId, keyFromField: mapped.externalIdFromField, payload: mapped.payload });
  }
  process.stderr.write("\n");
  return { people, missing };
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  const ct = new ConnecteamClient({ apiKey: need("CT_API_KEY"), customPublisherId: 0 });
  const fieldMap = loadFieldMap(process.env.FIELD_MAP_CLIENT);
  const { people, missing } = await listPackPeople(ct, Number(need("CT_ONBOARDING_PACK_ID")), fieldMap);
  const eh = await listEhEmployees(need("EH_BUSINESS_ID"), need("EH_API_KEY"));

  const rows = classifyAll(people, eh, fieldMap.identity.externalIdFrom !== "userId");
  console.log(renderPreflight(rows, eh.length, missing));
  if (rows.some(needsAttention)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
