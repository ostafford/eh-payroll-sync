/**
 * The live D1 database, from a local script: through the built config
 * (wrangler.deploy.json), and only once that config checks out against the
 * live Worker (`npm run deploy:config -- --check-live`), so a script never
 * reads or writes a database other than the live one. Used by the link stage
 * and the preflight.
 */
import { execFileSync } from "node:child_process";
import { DEPLOY_CONFIG_PATH } from "./deploy-config.js";

const DATABASE = "eh-payroll-sync";

/** Builds wrangler.deploy.json and checks it against the live Worker; throws if it doesn't check out. */
export function checkDeployConfig(): void {
  try {
    execFileSync("npm", ["run", "--silent", "deploy:config", "--", "--check-live"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`The deploy settings aren't ready:\n${err.stdout ?? ""}${err.stderr ?? ""}`.trimEnd());
  }
}

/** Runs one SQL statement on the live database; call {@link checkDeployConfig} first. */
export function d1(sql: string): unknown[] {
  let out: string;
  try {
    out = execFileSync(
      "npx",
      ["--yes", "wrangler", "d1", "execute", DATABASE, "--remote", "--json", "--command", sql, "--config", DEPLOY_CONFIG_PATH],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`wrangler d1 execute failed:\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
  const results = JSON.parse(out.slice(out.search(/[[{]/))) as Array<{ results?: unknown[] }>;
  return results.flatMap((r) => r.results ?? []);
}
