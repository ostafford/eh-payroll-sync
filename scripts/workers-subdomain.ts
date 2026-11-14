/**
 * `npm run workers-subdomain [-- --check-only]`
 *
 * The wizard's check, at the Cloudflare account stage, that the account has a
 * workers.dev subdomain, the address the sync is reached at (#194). A
 * brand-new account has none, and the deploy then fails after every secret is
 * stored. With none, in a terminal it asks for a name and registers it,
 * retrying a name that's taken or invalid. See scripts/lib/workers-subdomain.ts.
 *
 * Signs in the way wrangler is signed in (`wrangler auth token`), on the
 * account `CLOUDFLARE_ACCOUNT_ID` names, or the only one wrangler can see.
 *
 * Exit code: 0 = the account has a subdomain (now), 2 = it has none (and
 * `--check-only`, no terminal, or a blank answer), 1 = the check failed.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  DASHBOARD_PATH,
  NAME_RULES,
  readSubdomain,
  registerUntilDone,
  toCfResponse,
  type CfApi,
} from "./lib/workers-subdomain.js";

const API = "https://api.cloudflare.com/client/v4";

/** Runs wrangler and parses the JSON it prints. */
function wranglerJson<T>(args: string[]): T {
  let out: string;
  try {
    out = execFileSync("npx", ["--yes", "wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`wrangler ${args.join(" ")} failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`.trimEnd());
  }
  return JSON.parse(out.slice(out.search(/[[{]/))) as T;
}

type Credentials = { type: "oauth" | "api_token"; token: string } | { type: "api_key"; key: string; email: string };

function authHeaders(c: Credentials): Record<string, string> {
  return c.type === "api_key" ? { "X-Auth-Key": c.key, "X-Auth-Email": c.email } : { authorization: `Bearer ${c.token}` };
}

function accountId(): string {
  const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv) return fromEnv;
  const { accounts = [] } = wranglerJson<{ accounts?: Array<{ id: string; name: string }> }>(["whoami", "--json"]);
  if (accounts.length === 1) return accounts[0]!.id;
  if (accounts.length === 0) throw new Error("wrangler can't see any Cloudflare account. Run `npx wrangler login`.");
  throw new Error(
    [
      "wrangler can see more than one Cloudflare account. Say which one with CLOUDFLARE_ACCOUNT_ID, then run this again:",
      ...accounts.map((a) => `  CLOUDFLARE_ACCOUNT_ID=${a.id}   (${a.name})`),
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check-only");
  const credentials = wranglerJson<Credentials>(["auth", "token", "--json"]);
  const id = accountId();
  const api: CfApi = async (method, path, body) => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { ...authHeaders(credentials), accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return toCfResponse(r.status, await r.json().catch(() => null));
  };

  const existing = await readSubdomain(api, id);
  if (existing) {
    console.log(`✓ The account's workers.dev subdomain is ${existing}: the sync will be at https://eh-payroll-sync.${existing}.workers.dev`);
    return;
  }

  console.log("This Cloudflare account has no workers.dev subdomain yet. The sync needs one: it's part of its web address.");
  if (checkOnly || !process.stdin.isTTY) {
    console.log(`Register one in the ${DASHBOARD_PATH}, or run \`npm run workers-subdomain\` in a terminal.`);
    process.exitCode = 2;
    return;
  }

  console.log(`Pick a name: ${NAME_RULES}. The client's business name usually works. Leave it blank to stop.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const got = await registerUntilDone(api, id, () => rl.question("workers.dev subdomain: "), (line) => console.log(`  ${line}`));
    if (!got) {
      console.log(`Nothing registered. Register one in the ${DASHBOARD_PATH}, then run the wizard again.`);
      process.exitCode = 2;
      return;
    }
    console.log(`✓ Registered ${got}.workers.dev. The sync will be at https://eh-payroll-sync.${got}.workers.dev (it can take a few minutes to answer).`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
