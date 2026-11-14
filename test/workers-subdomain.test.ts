/**
 * The workers.dev subdomain check (#194), against a fake Cloudflare API that
 * answers with the codes wrangler's own registration handles.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  NAME_AVAILABLE,
  NAME_TAKEN,
  NO_SUBDOMAIN,
  readSubdomain,
  registerSubdomain,
  registerUntilDone,
  toCfResponse,
  type CfApi,
  type CfResponse,
} from "../scripts/lib/workers-subdomain.js";

const fail = (code: number, message = `error ${code}`): CfResponse => ({ ok: false, code, message });

/** A fake API: `taken` names are unavailable; a PUT registers anything else. */
function fakeCf(opts: { current?: string | null; taken?: string[]; putFails?: CfResponse } = {}) {
  const calls: string[] = [];
  let current = opts.current ?? null;
  const api: CfApi = async (method, path, body) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    if (method === "GET" && path.endsWith("/workers/subdomain")) {
      return current ? { ok: true, result: { subdomain: current } } : fail(NO_SUBDOMAIN);
    }
    if (method === "GET") {
      const name = path.split("/").pop()!;
      return opts.taken?.includes(name) ? fail(NAME_TAKEN) : fail(NAME_AVAILABLE);
    }
    if (opts.putFails) return opts.putFails;
    current = (body as { subdomain: string }).subdomain;
    return { ok: true, result: { subdomain: current } };
  };
  return { api, calls };
}

describe("readSubdomain", () => {
  it("returns the account's subdomain", async () => {
    expect(await readSubdomain(fakeCf({ current: "acme" }).api, "acc")).toBe("acme");
  });

  it("returns null for a new account with none (10007)", async () => {
    expect(await readSubdomain(fakeCf().api, "acc")).toBeNull();
  });

  it("throws on any other answer, rather than offering to register", async () => {
    const api: CfApi = async () => fail(10000, "Authentication error");
    await expect(readSubdomain(api, "acc")).rejects.toThrow("Authentication error");
  });
});

describe("registerSubdomain", () => {
  it("checks the name is free, then registers it", async () => {
    const cf = fakeCf();
    expect(await registerSubdomain(cf.api, "acc", " acme-payroll ")).toEqual({ ok: true, subdomain: "acme-payroll" });
    expect(cf.calls).toEqual([
      "GET /accounts/acc/workers/subdomains/acme-payroll",
      'PUT /accounts/acc/workers/subdomain {"subdomain":"acme-payroll"}',
    ]);
  });

  it("refuses an invalid name before asking Cloudflare", async () => {
    for (const bad of ["Acme", "acme_payroll", "-acme", "acme-", "a".repeat(64), ""]) {
      const cf = fakeCf();
      const r = await registerSubdomain(cf.api, "acc", bad);
      expect(r.ok, bad).toBe(false);
      expect(cf.calls, bad).toEqual([]);
    }
  });

  it("says a taken name is taken, and registers nothing", async () => {
    const cf = fakeCf({ taken: ["acme"] });
    expect(await registerSubdomain(cf.api, "acc", "acme")).toEqual({ ok: false, reason: '"acme" is already taken. Try another.' });
    expect(cf.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  it("passes on Cloudflare's reason when the register itself fails", async () => {
    const cf = fakeCf({ putFails: fail(10013, "Subdomain rejected") });
    expect(await registerSubdomain(cf.api, "acc", "acme")).toEqual({ ok: false, reason: 'Cloudflare didn\'t register "acme": Subdomain rejected' });
  });
});

describe("registerUntilDone", () => {
  it("asks again after an invalid or taken name, until one registers", async () => {
    const cf = fakeCf({ taken: ["acme"] });
    const answers = ["Acme Ltd", "acme", "acme-payroll"];
    const said: string[] = [];
    const got = await registerUntilDone(cf.api, "acc", async () => answers.shift()!, (l) => said.push(l));
    expect(got).toBe("acme-payroll");
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("isn't a valid name");
    expect(said[1]).toContain("already taken");
  });

  it("stops on a blank answer, registering nothing", async () => {
    const cf = fakeCf();
    expect(await registerUntilDone(cf.api, "acc", async () => "  ", () => {})).toBeNull();
    expect(cf.calls).toEqual([]);
  });
});

describe("toCfResponse", () => {
  it("reads a success and a v4 error body", () => {
    expect(toCfResponse(200, { success: true, result: { subdomain: "x" } })).toEqual({ ok: true, result: { subdomain: "x" } });
    expect(toCfResponse(404, { success: false, errors: [{ code: 10007, message: "no subdomain" }] })).toEqual({
      ok: false,
      code: 10007,
      message: "no subdomain",
    });
    expect(toCfResponse(500, null)).toEqual({ ok: false, code: null, message: "HTTP 500" });
  });
});

describe("the wizard", () => {
  const wizard = readFileSync("scripts/setup-wizard.sh", "utf8");

  it("checks the subdomain at the Cloudflare account stage, before any secret is stored or anything is provisioned", () => {
    const check = wizard.indexOf("npm run --silent workers-subdomain");
    expect(check).toBeGreaterThan(wizard.indexOf('stage "Cloudflare account"'));
    expect(check).toBeLessThan(wizard.indexOf('stage "Connecteam: API key"'));
    // The first call, at the start of a line; the helper's definition comes earlier.
    expect(wizard.indexOf("\nput_secret ")).toBeGreaterThan(-1);
    expect(check).toBeLessThan(wizard.indexOf("\nput_secret "));
    expect(check).toBeLessThan(wizard.indexOf("d1 create"));
  });

  it("stops if the account still has no subdomain", () => {
    const at = wizard.indexOf("npm run --silent workers-subdomain");
    expect(wizard.slice(at, at + 300)).toMatch(/\|\| \{ fail .*; exit 1; \}/);
  });
});
