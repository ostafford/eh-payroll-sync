import { describe, it, expect, beforeEach } from "vitest";
import { handleTelemetry, type RelayDeps } from "../src/relay.js";
import type { GitHubIssues, Issue } from "../src/github.js";

/** In-memory GitHub Issues, enough to assert dedupe / create / close. */
function fakeGitHub() {
  const issues: Issue[] = [];
  const comments: Array<{ number: number; body: string }> = [];
  let seq = 100;
  const gh: GitHubIssues = {
    async findOpenByTitle(title) {
      return [...issues].reverse().find((i) => i.title === title && i.state === "open") ?? null;
    },
    async create({ title, body }) {
      const issue: Issue = { number: ++seq, title, state: "open", body, html_url: `https://github.test/i/${seq}` };
      issues.push(issue);
      return issue;
    },
    async comment(number, body) {
      comments.push({ number, body });
    },
    async update(number, patch) {
      const i = issues.find((x) => x.number === number);
      if (!i) throw new Error(`no issue ${number}`);
      if (patch.body !== undefined) i.body = patch.body;
      if (patch.state !== undefined) i.state = patch.state;
    },
  };
  return { gh, issues, comments };
}

let world: ReturnType<typeof fakeGitHub>;
let emails: Array<{ subject: string; text: string }>;
let deps: RelayDeps;

beforeEach(() => {
  world = fakeGitHub();
  emails = [];
  deps = {
    gh: world.gh,
    now: () => new Date("2026-09-02T00:00:00Z"),
    forwardEmail: async (subject, text) => {
      emails.push({ subject, text });
    },
  };
});

const alert = (over: Record<string, unknown> = {}) => ({
  kind: "system_alert",
  client: "acme",
  ctUserId: 500,
  reason: "retries exhausted (profile_update)",
  at: "2026-09-02T00:00:00Z",
  ...over,
});

describe("handleTelemetry — system_alert", () => {
  it("creates one GitHub issue on the first alert", async () => {
    const r = await handleTelemetry(alert(), deps);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, deduped: false });
    expect(world.issues).toHaveLength(1);
    expect(world.issues[0]!.title).toBe("[eh-payroll-sync] system alert — acme / user 500");
    expect(world.issues[0]!.body).toContain("retries exhausted");
    expect(emails).toHaveLength(1);
  });

  it("comments on the existing open issue for a repeat (client + user), no new issue", async () => {
    await handleTelemetry(alert(), deps);
    const r = await handleTelemetry(alert({ at: "2026-09-02T01:00:00Z" }), deps);
    expect(r.body).toMatchObject({ deduped: true, issue: world.issues[0]!.number });
    expect(world.issues).toHaveLength(1);
    expect(world.comments).toHaveLength(1);
    expect(world.comments[0]!.body).toContain("2026-09-02T01:00:00Z");
  });

  it("opens a separate issue for a different user", async () => {
    await handleTelemetry(alert({ ctUserId: 500 }), deps);
    await handleTelemetry(alert({ ctUserId: 777 }), deps);
    expect(world.issues.map((i) => i.title)).toEqual([
      "[eh-payroll-sync] system alert — acme / user 500",
      "[eh-payroll-sync] system alert — acme / user 777",
    ]);
  });

  it("opens a separate issue for a different client", async () => {
    await handleTelemetry(alert({ client: "acme" }), deps);
    await handleTelemetry(alert({ client: "globex" }), deps);
    expect(world.issues).toHaveLength(2);
  });

  it("re-opens/creates after the first issue was closed", async () => {
    await handleTelemetry(alert(), deps);
    world.issues[0]!.state = "closed";
    const r = await handleTelemetry(alert(), deps);
    expect(r.body).toMatchObject({ deduped: false });
    expect(world.issues).toHaveLength(2);
  });

  it("falls back to unknown-client when no slug is given", async () => {
    await handleTelemetry(alert({ client: "" }), deps);
    expect(world.issues[0]!.title).toContain("unknown-client");
  });

  it("does not fail the request when the email forward throws", async () => {
    deps.forwardEmail = async () => {
      throw new Error("smtp down");
    };
    const r = await handleTelemetry(alert(), deps);
    expect(r.status).toBe(202);
  });
});

describe("handleTelemetry — health", () => {
  const health = (over: Record<string, unknown> = {}) => ({
    kind: "health",
    client: "acme",
    ok: true,
    d1: "ok",
    fieldMap: "ok",
    ops: { queueBacklog: 0 },
    at: "2026-09-02T00:00:00Z",
    ...over,
  });

  it("ok:true with no open issue is a no-op", async () => {
    const r = await handleTelemetry(health(), deps);
    expect(r.body).toMatchObject({ noop: true });
    expect(world.issues).toHaveLength(0);
  });

  it("ok:false opens a health issue with the snapshot", async () => {
    const r = await handleTelemetry(health({ ok: false, d1: "error" }), deps);
    expect(r.body).toMatchObject({ updated: false });
    expect(world.issues).toHaveLength(1);
    expect(world.issues[0]!.title).toBe("[eh-payroll-sync] health — acme");
    expect(world.issues[0]!.body).toContain('"d1": "error"');
  });

  it("a second ok:false updates the same issue, not a new one", async () => {
    await handleTelemetry(health({ ok: false }), deps);
    const r = await handleTelemetry(health({ ok: false, at: "2026-09-02T06:00:00Z" }), deps);
    expect(r.body).toMatchObject({ updated: true });
    expect(world.issues).toHaveLength(1);
    expect(world.issues[0]!.body).toContain("2026-09-02T06:00:00Z");
  });

  it("ok:true after a failure comments 'recovered' and closes the issue", async () => {
    await handleTelemetry(health({ ok: false }), deps);
    const r = await handleTelemetry(health({ ok: true }), deps);
    expect(r.body).toMatchObject({ closed: true });
    expect(world.issues[0]!.state).toBe("closed");
    expect(world.comments.at(-1)!.body).toMatch(/[Rr]ecovered/);
  });
});

describe("handleTelemetry — bad input", () => {
  it("400 on an unrecognised body", async () => {
    for (const b of [null, {}, { kind: "nope" }, { kind: "system_alert" }, { kind: "health" }, 42]) {
      expect((await handleTelemetry(b, deps)).status).toBe(400);
    }
    expect(world.issues).toHaveLength(0);
  });
});
