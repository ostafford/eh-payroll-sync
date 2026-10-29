/**
 * The runbook's emergency stop: pausing the sync queue's delivery holds every
 * EH write and every message without losing a job. Its commands must name the
 * queue wrangler.jsonc actually declares, so a rename can't leave the stop
 * pointing at a queue that doesn't exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const wrangler = read("wrangler.jsonc");
const runbook = read("docs/RUNBOOK.md");

const syncQueue = /"binding":\s*"SYNC_QUEUE",\s*"queue":\s*"([^"]+)"/.exec(wrangler)?.[1];

/** The "Emergency stop" section: from its heading to the next heading of any level. */
const stop = (() => {
  const start = runbook.search(/^### Emergency stop/m);
  if (start < 0) return "";
  // Skip the heading line itself, or it would match as the next heading.
  const rest = runbook.slice(runbook.indexOf("\n", start) + 1);
  const end = rest.search(/^#{2,3} /m);
  return end < 0 ? rest : rest.slice(0, end);
})();

describe("runbook emergency stop section", () => {
  it("exists", () => {
    expect(stop).not.toBe("");
  });

  it("found the sync queue in wrangler.jsonc to check against", () => {
    expect(syncQueue).toBeTruthy();
  });

  it("pauses and resumes delivery on the sync queue", () => {
    expect(stop).toContain(`wrangler queues pause-delivery ${syncQueue}`);
    expect(stop).toContain(`wrangler queues resume-delivery ${syncQueue}`);
  });

  it("warns that held jobs expire after the queue's retention period", () => {
    // Cloudflare: paused messages still expire at the retention period (default 4 days).
    expect(stop).toMatch(/4 days/);
  });

  it("never gives purging, which deletes the held jobs, as a command to run", () => {
    expect(stop).not.toMatch(/^\s*(npx )?wrangler queues purge/m);
  });
});
