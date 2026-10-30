/**
 * `npm run discover -- --client <slug>`
 *
 * Talks to a prospective client's Connecteam and Employment Hero accounts with
 * the two API keys, and writes:
 *   - clients/<slug>/field-map.json   — a DRAFT mapping (every mapped field is a
 *                                        best-effort name match; TODOs elsewhere).
 *                                        A map already set up for THIS account is
 *                                        never overwritten: the draft goes to
 *                                        field-map.draft.json, with a diff printed.
 *   - stdout                          — a configuration checklist (every var and
 *                                        secret, with the discovered value or a TODO)
 *
 * It never reads or writes employee values - it reads the account's
 * custom-field DEFINITIONS (`GET /users/v1/custom-fields`: id, name, type) and
 * structural ids. Definitions exist as soon as a field is created, so it works
 * on a fresh onboarding pack nobody has answered yet. They cover the whole
 * account; whether a field is attached to the pack can't be read via the API.
 *
 * Env (from .dev.vars or the shell): CT_API_KEY, EH_API_KEY.
 * Optional: EH_BUSINESS_ID, CT_ONBOARDING_PACK_ID (skip the pickers).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFieldMap } from "../src/mapping/schema.js";
import { listCustomFieldDefinitions } from "./lib/connecteam-custom-fields.js";
import { buildFieldMapDraft } from "./lib/discover-draft.js";
import { fieldPicksPath, loadFieldPicks } from "./lib/field-picks.js";
import { chooseFieldMapWrite, diffFieldMaps } from "./lib/field-map-diff.js";

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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// --- HTTP --------------------------------------------------------------

async function ctGet(path: string): Promise<any> {
  const r = await fetch(`https://api.connecteam.com${path}`, {
    headers: { "X-API-KEY": process.env.CT_API_KEY!, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Connecteam GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function ehGet(path: string): Promise<any> {
  const r = await fetch(`https://api.yourpayroll.com.au/api/v2${path}`, {
    headers: { authorization: `Basic ${Buffer.from(`${process.env.EH_API_KEY}:`).toString("base64")}`, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Employment Hero GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

// --- main --------------------------------------------------------------

async function main(): Promise<void> {
  loadDevVars();
  const client = arg("client");
  const fromWizard = process.argv.includes("--from-wizard");
  if (!client) throw new Error("usage: npm run discover -- --client <slug>");
  if (!process.env.CT_API_KEY || !process.env.EH_API_KEY) {
    throw new Error("CT_API_KEY and EH_API_KEY must be set (in .dev.vars or the shell)");
  }

  // Connecteam: the pack, and every custom-field definition in the account.
  // Definitions exist as soon as a field is created, so this works on a fresh
  // pack nobody has filled in yet.
  let packId = Number(process.env.CT_ONBOARDING_PACK_ID) || undefined;
  const packs = await ctGet("/onboarding/v1/packs").then((b) => b?.data?.packs ?? b?.data ?? []);
  if (!packId && packs.length) packId = packs[0].id ?? packs[0].packId;
  if (!packId) throw new Error("no onboarding pack found - set CT_ONBOARDING_PACK_ID");

  const fields = await listCustomFieldDefinitions(ctGet);
  if (!fields.length) throw new Error("the Connecteam account has no custom fields - create them first (docs/connecteam-field-checklist.md)");

  // Employment Hero: structural ids
  const businesses = await ehGet("/business").then((b) => (Array.isArray(b) ? b : b?.businesses ?? []));
  const businessId = process.env.EH_BUSINESS_ID || String(businesses[0]?.id ?? "");
  const paySchedules = businessId ? await ehGet(`/business/${businessId}/payschedule`).catch(() => []) : [];
  const locations = businessId ? await ehGet(`/business/${businessId}/location`).catch(() => []) : [];

  const outDir = arg("out") ?? dirname(fieldPicksPath(client));
  const { draft, mappedCount, ruleFedCount, unmapped, notSynced } = buildFieldMapDraft({
    client,
    packId,
    businessId,
    payScheduleId: String(paySchedules[0]?.id ?? ""),
    locationId: String(locations[0]?.id ?? ""),
    fields,
    picks: loadFieldPicks(join(outDir, "field-picks.json")),
  });

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const mapFile = join(outDir, "field-map.json");
  let existing: unknown;
  if (existsSync(mapFile)) {
    try {
      existing = JSON.parse(readFileSync(mapFile, "utf8"));
    } catch {
      existing = null; // unreadable - keep it, write a draft beside it
    }
  }
  const write = chooseFieldMapWrite(existing, draft);
  const draftFile = join(outDir, "field-map.draft.json");
  const outFile = write.action === "draft" ? draftFile : mapFile;
  writeFileSync(outFile, JSON.stringify(draft, null, 2) + "\n");
  // A draft left by an earlier run would no longer describe the map.
  if (write.action !== "draft") rmSync(draftFile, { force: true });

  let schema = "valid against the field-map schema";
  try {
    parseFieldMap(draft);
  } catch (err) {
    schema = `NOT yet schema-valid - ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }

  const diff = write.action === "draft" ? diffFieldMaps(existing, draft) : [];
  const changed = diff.some((l) => l.startsWith("~") || l.startsWith("+"));

  if (fromWizard) {
    // Inside the wizard (#66): just the field map, in plain words. The wizard
    // has already collected the IDs and secrets the standalone checklist lists.
    if (write.action === "draft") {
      console.log("\nYour field map is already set up for this account, so it was kept.");
      if (changed) {
        console.log("Your Connecteam fields have changed since it was set up:");
        console.log(diff.filter((l) => !l.startsWith("=")).map((l) => "  " + l).join("\n"));
        console.log(`A fresh draft is in ${outFile}.`);
      } else {
        const same = Number(/^= (\d+)/.exec(diff[0] ?? "")?.[1] ?? 0);
        console.log(`Nothing to change: all ${same} field mappings still match your Connecteam fields.`);
      }
    } else {
      if (write.action === "replace") console.log("\nThe field map that came with the code was for another account, so it was replaced.");
      console.log(`${write.action === "replace" ? "" : "\n"}Built your field map from your Connecteam fields: ${mappedCount} mapped, ${ruleFedCount} tax/super answers.`);
    }
    printFieldLists(unmapped, notSynced);
    // Machine-readable last line for the wizard.
    console.log(`MAP_STATUS=${write.action === "draft" ? (changed ? "changed" : "unchanged") : "written"}`);
    return;
  }

  const line = (k: string, v: string) => `  ${k.padEnd(28)} ${v}`;
  if (write.action === "draft") {
    console.log(`\nKept ${mapFile} - it is already set up for this account (pack ${packId}, business ${businessId}).`);
    console.log(`Wrote DRAFT ${outFile}  (${schema})`);
    console.log("  Your map vs the draft (which Connecteam field feeds each EH field; pay-run settings and rule options aren't compared):");
    console.log(diff.map((l) => "    " + l).join("\n"));
  } else {
    if (write.action === "replace") {
      console.log(
        `\nReplaced ${mapFile} - it was for another account (pack ${String(write.previous.packId)}, ` +
          `business ${String(write.previous.businessId)}), not this one (pack ${packId}, business ${businessId}).`,
      );
    }
    console.log(`\nWrote DRAFT ${outFile}  (${schema})`);
  }
  console.log(`  ${mappedCount} fields mapped by name; ${ruleFedCount} fields fed into rules.`);
  printFieldLists(unmapped, notSynced);

  // FIELD_MAP_CLIENT and registry.ts only matter when one deployment serves
  // several clients (a slug other than "self"); a single-client setup leaves
  // FIELD_MAP_CLIENT blank (docs/RUNBOOK.md).
  const multiTenant = client !== "self";
  console.log("\nConfiguration checklist (.dev.vars values + secrets; never wrangler.jsonc):");
  if (multiTenant) console.log(line("FIELD_MAP_CLIENT", client));
  console.log(line("EH_BUSINESS_ID", businessId || "TODO  (GET /api/v2/business)"));
  console.log(line("CT_ONBOARDING_PACK_ID", String(packId)));
  console.log(line("CT_CUSTOM_PUBLISHER_ID", "TODO  (Connecteam > Settings > Custom Publishers)"));
  console.log(line("ADMIN_CONNECTEAM_CHANNEL_ID", "TODO  (GET /chat/v1/conversations, the 'EH Sync Alerts' channel)"));
  console.log("\n  secrets (wrangler secret put):");
  console.log(line("CT_API_KEY", "have"));
  console.log(line("EH_API_KEY", "have"));
  console.log(line("CT_WEBHOOK_SECRET", "TODO  (generate a random string; used when registering the webhook)"));
  console.log(
    multiTenant
      ? "\nNext: register this client in src/mapping/registry.ts, then tune the draft field-map (see docs/RUNBOOK.md step 4).\n"
      : "\nNext: tune the draft field-map if needed (see docs/RUNBOOK.md step 4).\n",
  );
}

/** Fields not in the draft: the ones the sync deliberately skips, then genuinely unknown ones. */
function printFieldLists(
  unmapped: Array<{ id: number; label: string }>,
  notSynced: Array<{ id: number; name: string; reason: string }>,
): void {
  if (notSynced.length) {
    console.log("\nNot used by the sync (that's expected):");
    console.log(notSynced.map((n) => `  - ${n.name}: ${n.reason}`).join("\n"));
  }
  if (unmapped.length) {
    console.log("\nNot recognised, so not synced (fine unless it holds something Employment Hero needs):");
    console.log(unmapped.map((u) => "  - " + u.label.replace(/^\d+\s+/, "")).join("\n"));
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
