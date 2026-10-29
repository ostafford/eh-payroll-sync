/**
 * `npm run preflight`
 *
 * Read-only. Before a first deploy, lists what the first sync will do to each
 * approved Connecteam person given the employees already in EH: already
 * linked, new, merge, or a duplicate / ambiguous match to fix first. See
 * scripts/lib/preflight.ts for why.
 *
 * Exit code: 0 = safe to deploy, 2 = something to fix first, 1 = the check
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
import {
  classifyAll,
  hasBlocking,
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
      out.push({
        id: Number(e.id),
        name: [e.firstName, e.surname].filter(Boolean).join(" "),
        email: typeof e.emailAddress === "string" && e.emailAddress ? e.emailAddress : null,
        tfn: digits(e.taxFileNumber),
        externalId: typeof e.externalId === "string" && e.externalId ? e.externalId : null,
      });
    }
    if (page.length < PAGE) return out;
  }
}

function digits(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  return d === "" ? null : d;
}

// --- Connecteam ----------------------------------------------------------

async function listApprovedPeople(ct: ConnecteamClient, packId: number): Promise<PreflightPerson[]> {
  const assignments = await ct.listAssignments(packId);
  if (assignments.outcome !== "ok") throw new Error(`Connecteam onboarding assignments -> ${assignments.status} ${assignments.detail}`);
  const approved = [...new Set(assignments.data.filter((a) => a.status === "completed").map((a) => a.userId))];

  const fieldMap = loadFieldMap(process.env.FIELD_MAP_CLIENT);
  const people: PreflightPerson[] = [];
  for (const [i, userId] of approved.entries()) {
    process.stderr.write(`\rReading approved Connecteam people: ${i + 1}/${approved.length}`);
    if ((ct.lastRateLimit?.minuteRemaining ?? Infinity) <= 1) await new Promise((r) => setTimeout(r, 60_000));
    const u = await ct.getUser(userId);
    if (u.outcome !== "ok") throw new Error(`Connecteam user ${userId} -> ${u.status} ${u.detail}`);
    if (!u.data) continue;
    // The same mapping the sync runs, so the TFN is exactly what EH would get.
    const mapped = applyFieldMap(u.data as unknown as ConnecteamUser, fieldMap, {});
    const p = mapped.payload;
    people.push({
      ctUserId: userId,
      name: [p.firstName ?? u.data.firstName, p.surname ?? u.data.lastName].filter(Boolean).join(" "),
      email: typeof p.emailAddress === "string" && p.emailAddress ? p.emailAddress : null,
      tfn: digits(p.taxFileNumber),
    });
  }
  process.stderr.write("\n");
  return people;
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  const ct = new ConnecteamClient({ apiKey: need("CT_API_KEY"), customPublisherId: 0 });
  const people = await listApprovedPeople(ct, Number(need("CT_ONBOARDING_PACK_ID")));
  const eh = await listEhEmployees(need("EH_BUSINESS_ID"), need("EH_API_KEY"));

  const rows = classifyAll(people, eh);
  console.log(renderPreflight(rows, eh));
  if (hasBlocking(rows, eh)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
