import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DATABASE_ID_KEY,
  DATABASE_ID_PLACEHOLDER,
  DEPLOY_CONFIG_PATH,
  REQUIRED_SECRETS,
  REQUIRED_VARS,
  compareWithLive,
  missingSecrets,
  parseDevVars,
  planBaselineKey,
  renderDeployConfig,
  stripJsonc,
  type LiveBinding,
} from "../scripts/lib/deploy-config.js";

const read = (p: string) => readFileSync(p, "utf8");
const template = read("wrangler.jsonc");

const goodVars = {
  [DATABASE_ID_KEY]: "11111111-2222-3333-4444-555555555555",
  EH_BUSINESS_ID: "555455",
  CT_ONBOARDING_PACK_ID: "5474",
  CT_CUSTOM_PUBLISHER_ID: "2505336",
  ADMIN_CONNECTEAM_CHANNEL_ID: "chan-1",
  CT_API_KEY: "secret-never-copied",
};

describe("stripJsonc", () => {
  it("drops comments and trailing commas but not // inside a string", () => {
    const text = '{\n  // a comment\n  "url": "https://x.dev", /* block */\n  "a": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ url: "https://x.dev", a: [1, 2] });
  });

  it("parses the real wrangler.jsonc", () => {
    expect(() => JSON.parse(stripJsonc(template))).not.toThrow();
  });
});

describe("parseDevVars", () => {
  it("reads KEY=VALUE, skipping comments and blanks, removing quotes", () => {
    expect(parseDevVars('# c\n\nA=1\nB="two"\nC=a=b\n  D = x \n')).toEqual({ A: "1", B: "two", C: "a=b", D: "x" });
  });
});

describe("renderDeployConfig", () => {
  it("fills the database id and every template var that .dev.vars has", () => {
    const r = renderDeployConfig(template, goodVars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.d1_databases?.[0]?.database_id).toBe(goodVars[DATABASE_ID_KEY]);
    expect(r.vars).toMatchObject({ EH_BUSINESS_ID: "555455", ADMIN_CONNECTEAM_CHANNEL_ID: "chan-1" });
    expect(r.vars.STATUS_DIGEST_DAY).toBe(""); // not in .dev.vars -> the template's value
  });

  it("never copies a secret into the config", () => {
    const r = renderDeployConfig(template, goodVars);
    expect(JSON.stringify(r)).not.toContain("secret-never-copied");
  });

  it("keeps everything else in the template as it is (queues, crons, flags)", () => {
    const r = renderDeployConfig(template, goodVars);
    if (!r.ok) throw new Error("render failed");
    const t = JSON.parse(stripJsonc(template));
    for (const key of ["name", "main", "compatibility_date", "compatibility_flags", "queues", "triggers"]) {
      expect(r.config[key]).toEqual(t[key]);
    }
  });

  it("refuses, naming each one, when the database id or a required var is missing", () => {
    const { [DATABASE_ID_KEY]: _db, CT_CUSTOM_PUBLISHER_ID: _pub, ...rest } = goodVars;
    expect(renderDeployConfig(template, { ...rest, EH_BUSINESS_ID: "  " })).toEqual({
      ok: false,
      missing: [DATABASE_ID_KEY, "EH_BUSINESS_ID", "CT_CUSTOM_PUBLISHER_ID"],
    });
  });

  it("treats the template's placeholder as missing", () => {
    const r = renderDeployConfig(template, { ...goodVars, [DATABASE_ID_KEY]: DATABASE_ID_PLACEHOLDER });
    expect(r).toEqual({ ok: false, missing: [DATABASE_ID_KEY] });
  });
});

describe("compareWithLive", () => {
  const rendered = { databaseId: "db-new", vars: { EH_BUSINESS_ID: "555455", ADMIN_CONNECTEAM_CHANNEL_ID: "chan-2" } };
  const live: LiveBinding[] = [
    { name: "DB", type: "d1", database_id: "db-new" },
    { name: "EH_BUSINESS_ID", type: "plain_text", text: "555455" },
    { name: "ADMIN_CONNECTEAM_CHANNEL_ID", type: "plain_text", text: "chan-1" },
    { name: "CT_API_KEY", type: "secret_text" },
  ];

  it("lists only the settings that change; secrets are never compared", () => {
    expect(compareWithLive(rendered, live)).toEqual({
      databaseChange: null,
      varChanges: [{ name: "ADMIN_CONNECTEAM_CHANNEL_ID", live: "chan-1", next: "chan-2" }],
    });
  });

  it("flags a different database", () => {
    const moved = live.map((b) => (b.type === "d1" ? { ...b, database_id: "db-old" } : b));
    expect(compareWithLive(rendered, moved).databaseChange).toEqual({ live: "db-old", next: "db-new" });
  });
});

describe("missingSecrets", () => {
  const all: LiveBinding[] = REQUIRED_SECRETS.map((name) => ({ name, type: "secret_text" }));

  it("is empty when the live Worker has every required secret", () => {
    expect(missingSecrets([...all, { name: "STATUS_TOKEN", type: "secret_text" }])).toEqual([]);
  });

  it("names BASELINE_KEY on a Worker deployed before linking", () => {
    expect(missingSecrets(all.filter((b) => b.name !== "BASELINE_KEY"))).toEqual(["BASELINE_KEY"]);
  });

  it("doesn't count a plain var with a secret's name", () => {
    const live = [...all.filter((b) => b.name !== "BASELINE_KEY"), { name: "BASELINE_KEY", type: "plain_text", text: "x" }];
    expect(missingSecrets(live)).toEqual(["BASELINE_KEY"]);
  });
});

describe("planBaselineKey (update.sh, #172)", () => {
  const fresh = () => "new-key";

  it("puts nothing when the live Worker already has a key, whatever .dev.vars holds", () => {
    expect(planBaselineKey([], { BASELINE_KEY: "other" }, fresh)).toEqual({ action: "none" });
    expect(planBaselineKey(["CT_API_KEY"], {}, fresh)).toEqual({ action: "none" });
  });

  it("puts the key .dev.vars keeps, so a backed-up key isn't replaced", () => {
    expect(planBaselineKey(["BASELINE_KEY"], { BASELINE_KEY: " kept-key " }, fresh)).toEqual({
      action: "put",
      key: "kept-key",
      keepInDevVars: false,
    });
  });

  it("makes a new key, to keep in .dev.vars, when there's none anywhere", () => {
    expect(planBaselineKey(["BASELINE_KEY"], { BASELINE_KEY: "" }, fresh)).toEqual({ action: "put", key: "new-key", keepInDevVars: true });
  });
});

describe("the secrets check is wired into every deploy path", () => {
  const script = read("scripts/deploy-config.ts");
  const wizard = read("scripts/setup-wizard.sh");

  it("--check-live refuses a missing secret unless told the wizard will put it", () => {
    expect(script).toMatch(/allowMissingSecrets \? \[\] : missingSecrets\(bindings\)/);
    expect(script).toContain('process.argv.includes("--allow-missing-secrets")');
  });

  it("npm run deploy and update.sh keep the check on", () => {
    expect(JSON.parse(read("package.json")).scripts.deploy).not.toContain("--allow-missing-secrets");
    expect(read("scripts/update.sh")).not.toContain("--allow-missing-secrets");
  });

  it("update.sh puts a missing BASELINE_KEY, keeping it in .dev.vars before the put, and only after the database check", () => {
    expect(read("scripts/update.sh")).toContain("deploy:config -- --check-live --put-baseline-key");
    const dbCheck = script.indexOf("Matches the live Worker's database");
    const keep = script.indexOf('appendFileSync(".dev.vars"');
    const put = script.indexOf('wrangler(["secret", "put", "BASELINE_KEY"]');
    expect(dbCheck).toBeGreaterThan(-1);
    expect(keep).toBeGreaterThan(dbCheck);
    expect(put).toBeGreaterThan(keep);
  });

  it("the wizard skips the check only because it puts every required secret before deploying", () => {
    // Except `--stage webhook` (#195): it deploys nothing, and the live Worker must already hold the
    // webhook secret it registers, so it runs the full check.
    const alone = wizard.slice(wizard.indexOf('if [[ "$STAGE_ONLY" == "webhook" ]]'));
    const strict = alone.slice(0, alone.indexOf("\nfi\n"));
    expect(strict).toContain("npm run --silent deploy:config -- --check-live 2>&1)");
    for (const line of wizard.replace(strict, "").split("\n").filter((l) => l.includes("deploy:config -- --check-live"))) {
      expect(line).toContain("--allow-missing-secrets");
    }
    // The link stage (#154) and the preflight reach D1 only through the check, so they never touch a
    // database other than the live Worker's. Neither deploys, so neither needs the live Worker's secrets:
    // the preflight only reads (#168), and the link stage runs before the first deploy (ADR-0012).
    expect(read("scripts/lib/remote-d1.ts")).toContain('"deploy:config", "--", "--check-live"');
    expect(read("scripts/lib/remote-d1.ts")).not.toContain("--allow-missing-secrets");
    expect(read("scripts/link.ts")).toContain('from "./lib/remote-d1.js"');
    expect(read("scripts/link.ts")).toContain('checkDeployConfig(["--allow-missing-secrets"])');
    expect(read("scripts/preflight.ts")).toContain('checkDeployConfig(["--allow-missing-secrets"])');
    const deployAt = wizard.indexOf("wr_quiet deploy --config");
    for (const name of REQUIRED_SECRETS) {
      const putAt = wizard.indexOf(`put_secret ${name} `);
      expect(putAt, name).toBeGreaterThan(-1);
      expect(putAt, name).toBeLessThan(deployAt);
    }
  });

  it("the wizard keeps an existing BASELINE_KEY rather than making a new one", () => {
    expect(wizard).toContain("BASELINE_KEY=$(_existing BASELINE_KEY)");
  });
});

// The wizard, update.sh, `npm run deploy`, the runbook and the template must all
// agree on where a deployment's values live. A slip in any one of them brings
// back the deploy that blanks a live Worker's settings.
describe("every deploy path uses the built config, never the template", () => {
  const CFG = `--config ${DEPLOY_CONFIG_PATH}`;
  const wizard = read("scripts/setup-wizard.sh");
  const update = read("scripts/update.sh");
  const runbookCode = [...read("docs/RUNBOOK.md").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");

  /** Lines that run a wrangler command which reads the config's database or deploys. */
  const configReaders = (text: string) =>
    text
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .filter((l) => /wrangler(?:["' ]| \S+ )*(deploy\b(?! --dry-run)|d1 (migrations|export|execute)|secret put)|wr_quiet (deploy|d1 migrations)/.test(l));

  it("the template holds no deployment's values", () => {
    const t = JSON.parse(stripJsonc(template));
    expect(t.d1_databases[0].database_id).toBe(DATABASE_ID_PLACEHOLDER);
    for (const key of REQUIRED_VARS) expect(t.vars[key]).toBe("");
  });

  it("git ignores the values and the built config", () => {
    const ignored = read(".gitignore").split("\n");
    expect(ignored).toContain(".dev.vars");
    expect(ignored).toContain(DEPLOY_CONFIG_PATH);
  });

  it("npm run deploy checks against the live Worker, then deploys the built config", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts.deploy).toBe(`tsx scripts/deploy-config.ts --check-live && wrangler deploy ${CFG}`);
  });

  it("update.sh checks before it touches the database, and uses the built config", () => {
    expect(update.indexOf("deploy:config -- --check-live")).toBeGreaterThan(-1);
    expect(update.indexOf("deploy:config -- --check-live")).toBeLessThan(update.indexOf("d1 migrations apply"));
    expect(configReaders(update).length).toBeGreaterThanOrEqual(2);
    for (const line of configReaders(update)) expect(line).toContain(CFG);
  });

  it("the wizard saves values to .dev.vars only, and its remote commands use the built config", () => {
    expect(wizard).not.toMatch(/set_jsonc|^save .* jsonc$/m);
    expect(wizard).toContain(`write_env ${DATABASE_ID_KEY} "$db_id"`);
    expect(configReaders(wizard).length).toBeGreaterThanOrEqual(4);
    for (const line of configReaders(wizard)) expect(line).toContain(CFG);
  });

  it("the runbook's commands use the built config", () => {
    expect(runbookCode).not.toMatch(/^npx wrangler deploy\s*$/m);
    for (const line of configReaders(runbookCode)) expect(line).toContain(CFG);
  });

  it(".dev.vars.example lists every value a deploy needs", () => {
    const example = read(".dev.vars.example");
    for (const key of [DATABASE_ID_KEY, ...REQUIRED_VARS, ...REQUIRED_SECRETS]) expect(example).toMatch(new RegExp(`^${key}=`, "m"));
  });
});
