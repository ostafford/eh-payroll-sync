/**
 * The wizard's webhook stage (#195): `--stage webhook` runs it alone on a live
 * deployment. Runs the real wizard from a scratch directory (its own
 * `.dev.vars`, never the clone's) with stub `npm` and `curl` first on PATH:
 * they record what they were asked and answer like Cloudflare and Connecteam,
 * so nothing reaches either.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const WIZARD = join(root, "scripts/setup-wizard.sh");
// See setup-wizard-link.test.ts: an inherited WIZARD_LOG skips the log wrapper.
const { WIZARD_LOG: _log, WIZARD_DETAILS: _details, ...cleanEnv } = process.env;

const URL_ = "https://eh-payroll-sync.acme.workers.dev";
const TARGET = `${URL_}/webhook`;
const SECRET = "webhook-secret-0123456789";
const DEV_VARS = `CT_API_KEY=ct-key-0123456789\nCT_WEBHOOK_SECRET=${SECRET}\n`;

type Hook = { id: number; url: string; featureType?: string; eventTypes?: string[]; isDisabled?: boolean };
const hook = (id: number, over: Partial<Hook> = {}): Hook => ({
  id,
  url: TARGET,
  featureType: "users",
  eventTypes: ["user_updated"],
  isDisabled: false,
  ...over,
});

type Opts = {
  devVars?: string;
  /** Connecteam's webhook list before the stage; after a POST, the new one is added. */
  webhooks?: Hook[];
  env?: Record<string, string>;
  input?: string;
};

function wizard(opts: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wizard-webhook-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), '{\n  "name": "eh-payroll-sync"\n}\n');
  writeFileSync(join(dir, ".dev.vars"), opts.devVars ?? DEV_VARS);
  const list = join(dir, "webhooks.json");
  writeFileSync(list, JSON.stringify({ data: { webhooks: opts.webhooks ?? [] } }));
  const npmLog = join(dir, "npm.log");
  const curlLog = join(dir, "curl.log");
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${npmLog}"
if [[ "$*" == *deploy:config* ]]; then [[ -z "\${FAIL_CONFIG:-}" ]] || { echo "✗ database mismatch"; exit 1; }; exit 0; fi
if [[ "$*" == *workers-subdomain* ]]; then [[ -z "\${NO_SUBDOMAIN:-}" ]] || { echo "no subdomain" >&2; exit 2; }; echo "${URL_}"; exit 0; fi
exit 0
`,
  );
  // Records "METHOD URL [body]"; the URL is curl's last argument.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
method=GET body=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  [[ "\${args[i]}" == "-X" ]] && method="\${args[i+1]}"
  [[ "\${args[i]}" == "-d" ]] && body="\${args[i+1]}"
done
url="\${args[\${#args[@]}-1]}"
printf '%s %s %s\\n' "$method" "$url" "$body" >> "${curlLog}"
case "$method $url" in
  "GET ${URL_}/health") [[ -n "\${NO_HEALTH:-}" ]] && exit 7; echo '{"ok":true,"ops":{}}' ;;
  "GET https://api.connecteam.com/settings/v1/webhooks") cat "${list}" ;;
  "POST https://api.connecteam.com/settings/v1/webhooks")
    [[ -n "\${POST_FAILS:-}" ]] && { echo '{"detail":"bad request"}'; exit 0; }
    node -e 'const f=process.argv[1];const j=JSON.parse(require("fs").readFileSync(f,"utf8"));j.data.webhooks.push({id:77,...JSON.parse(process.argv[2])});require("fs").writeFileSync(f,JSON.stringify(j))' "${list}" "$body"
    echo '{"data":{"id":77}}' ;;
  PUT*) echo '{"data":{}}' ;;
  DELETE*) echo '{}' ;;
esac
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  const r = spawnSync("bash", [WIZARD, "--stage", "webhook"], {
    cwd: dir,
    input: opts.input ?? "",
    encoding: "utf8",
    env: { ...cleanEnv, PATH: `${bin}:${process.env.PATH}`, WIZARD_DETAILS: join(dir, "wrangler.log"), ...opts.env },
    timeout: 30_000,
  });
  const lines = (f: string) => {
    try {
      return readFileSync(f, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const curl = lines(curlLog);
  return { ...r, npm: lines(npmLog), curl, connecteam: curl.filter((c) => c.includes("api.connecteam.com")) };
}

describe("setup wizard, --stage webhook", () => {
  it("checks the live deployment, then registers the webhook at the Worker's address", () => {
    const r = wizard();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Stage 1/1 · Register the Connecteam webhook");
    expect(r.stdout).not.toContain("Cloudflare account");
    expect(r.npm).toEqual(["run --silent deploy:config -- --check-live", "run --silent workers-subdomain -- --print-url"]);
    const post = r.connecteam.filter((c) => c.startsWith("POST "));
    expect(post).toHaveLength(1);
    const body = JSON.parse(post[0]!.slice(post[0]!.indexOf("{")));
    expect(body).toMatchObject({ url: TARGET, featureType: "users", eventTypes: ["user_updated"], secretKey: SECRET, isDisabled: false });
    expect(r.stdout).toContain("registered webhook id 77");
  });

  it("shows the registered webhooks, marking this Worker's", () => {
    const r = wizard({ webhooks: [hook(3, { url: "https://other.example/hook" })] });
    expect(r.stdout).toContain("Connecteam's registered webhooks for this account:");
    expect(r.stdout).toMatch(/-> 77 {2}https:\/\/eh-payroll-sync\.acme\.workers\.dev\/webhook {2}events: user_updated {2}enabled/);
    expect(r.stdout).toMatch(/ {3}3 {2}https:\/\/other\.example\/hook/);
  });

  it("updates a webhook already pointing at the Worker instead of adding one (#82)", () => {
    const r = wizard({ webhooks: [hook(5, { isDisabled: true })] });
    expect(r.connecteam.some((c) => c.startsWith("POST "))).toBe(false);
    const put = r.connecteam.filter((c) => c.startsWith("PUT "));
    expect(put).toHaveLength(1);
    expect(put[0]).toContain("https://api.connecteam.com/settings/v1/webhooks/5 ");
    expect(put[0]).toContain(`"secretKey":"${SECRET}"`);
    expect(r.stdout).toContain("updated the existing webhook id 5");
  });

  it("offers to delete extra webhooks pointing at the Worker, and deletes them on yes", () => {
    const r = wizard({ webhooks: [hook(5), hook(6)], input: "y\n" });
    expect(r.stdout).toContain("Delete the extra webhook(s) 6 in Connecteam");
    expect(r.connecteam.filter((c) => c.startsWith("DELETE "))).toEqual(["DELETE https://api.connecteam.com/settings/v1/webhooks/6 "]);
  });

  it("keeps the extras when the answer is no", () => {
    const r = wizard({ webhooks: [hook(5), hook(6)] });
    expect(r.connecteam.some((c) => c.startsWith("DELETE "))).toBe(false);
  });

  it("never prints the webhook secret", () => {
    const r = wizard();
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it("exits non-zero, listing what's left, when Connecteam doesn't confirm the registration", () => {
    const r = wizard({ env: { POST_FAILS: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("could not confirm the webhook registered");
    expect(r.stdout).toContain("still to do by hand:");
  });

  it("stops before Connecteam when the deploy settings don't check out against the live Worker", () => {
    const r = wizard({ env: { FAIL_CONFIG: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("database mismatch");
    expect(r.npm).toEqual(["run --silent deploy:config -- --check-live"]);
    expect(r.curl).toEqual([]);
  });

  it("stops before Connecteam when the account has no workers.dev subdomain", () => {
    const r = wizard({ env: { NO_SUBDOMAIN: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("Couldn't work out the sync's address");
    expect(r.curl).toEqual([]);
  });

  it("stops before Connecteam when nothing answers at the Worker's /health", () => {
    const r = wizard({ env: { NO_HEALTH: "1" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain(`Nothing answers at ${URL_}/health`);
    expect(r.connecteam).toEqual([]);
  });

  it("stops, touching nothing, when .dev.vars has no webhook secret", () => {
    const r = wizard({ devVars: "CT_API_KEY=ct-key-0123456789\n" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("run the whole wizard instead");
    expect(r.npm).toEqual([]);
    expect(r.curl).toEqual([]);
  });

  it("on a first setup, still registers the webhook right after the deploy", () => {
    const script = readFileSync(WIZARD, "utf8");
    const deploy = script.search(/^stage "Push secrets \+ deploy"$/m);
    const call = script.search(/^webhook_stage$/m);
    expect(deploy).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(deploy);
    expect(script.slice(call + 1)).not.toMatch(/^\s*webhook_stage\b/m);
  });
});
