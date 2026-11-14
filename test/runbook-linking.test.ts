/**
 * The linking docs (#158): the RUNBOOK's "Rolling out linking on a live
 * deployment" and docs/linking-rehearsal.md. Every npm script, script file,
 * `/health` field and D1 database they name must exist, so a rename can't
 * leave the rollout or the rehearsal pointing at nothing.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildHealth } from "../src/health.js";

const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p: string) => readFileSync(path(p), "utf8");

const runbook = read("docs/RUNBOOK.md");
const rehearsal = read("docs/linking-rehearsal.md");
const scripts = Object.keys((JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts);
const database = /"database_name":\s*"([^"]+)"/.exec(read("wrangler.jsonc"))?.[1];

/** The rollout section: from its heading to the next `## ` heading. */
const rollout = (() => {
  const start = runbook.search(/^## Rolling out linking on a live deployment/m);
  if (start < 0) return "";
  const rest = runbook.slice(runbook.indexOf("\n", start) + 1);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
})();

const docs = { "RUNBOOK rollout section": rollout, "linking-rehearsal.md": rehearsal };

const all = (re: RegExp, text: string) => [...new Set([...text.matchAll(re)].map((m) => m[1]!))];

describe("linking docs", () => {
  it("has the rollout section, and it links to the rehearsal checklist", () => {
    expect(rollout).not.toBe("");
    expect(rollout).toContain("(linking-rehearsal.md)");
  });

  for (const [name, text] of Object.entries(docs)) {
    it(`${name}: every npm script it runs exists`, () => {
      const named = all(/npm run (?:--silent )?([\w:-]+)/g, text);
      expect(named.length).toBeGreaterThan(0);
      for (const s of named) expect(scripts, `npm run ${s}`).toContain(s);
    });

    it(`${name}: every script file it runs exists`, () => {
      for (const f of all(/\.\/(scripts\/[\w.-]+\.sh)/g, text)) expect(existsSync(path(f)), f).toBe(true);
    });

    it(`${name}: every /health field it names is one /health returns`, async () => {
      const db = { prepare: () => ({ first: async () => ({}), all: async () => ({ results: [] }) }) };
      const { ops } = await buildHealth({ DB: db, FIELD_MAP_CLIENT: "_example", EH_BUSINESS_ID: "" });
      const named = all(/`ops\.(\w+)`/g, text);
      for (const f of named) expect(Object.keys(ops!), `ops.${f}`).toContain(f);
    });

    it(`${name}: its D1 commands name the database wrangler.jsonc declares`, () => {
      expect(database).toBeTruthy();
      for (const db of all(/wrangler d1 execute ([\w-]+)/g, text)) expect(db).toBe(database);
    });
  }

  it("the rehearsal checklist names no real employee data: no email address or TFN-like number", () => {
    expect(rehearsal).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(rehearsal).not.toMatch(/\b\d{8,9}\b/);
  });
});
