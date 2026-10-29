import { describe, it, expect, afterEach, vi } from "vitest";
import worker, { type Env } from "../src/index.js";

const env: Env = {
  RELAY_SECRET: "shhh",
  GITHUB_TOKEN: "ghp_x",
  GITHUB_REPO: "acme/repo",
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://relay.test/", { method: "POST", body: JSON.stringify(body), headers }),
    env,
  );

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("relay fetch handler", () => {
  it("GET /health is public", async () => {
    const res = await worker.fetch(new Request("https://relay.test/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "eh-payroll-sync-relay" });
  });

  it("rejects a POST with no secret header", async () => {
    const res = await post({ kind: "health", ok: true, at: "t" });
    expect(res.status).toBe(401);
  });

  it("rejects a POST with the wrong secret", async () => {
    const res = await post({ kind: "health", ok: true, at: "t" }, { "x-eh-sync-secret": "nope" });
    expect(res.status).toBe(401);
  });

  it("rejects a non-POST, non-health request", async () => {
    const res = await worker.fetch(new Request("https://relay.test/", { method: "PUT" }), env);
    expect(res.status).toBe(405);
  });

  it("400s on invalid JSON", async () => {
    const res = await worker.fetch(
      new Request("https://relay.test/", {
        method: "POST",
        body: "{not json",
        headers: { "x-eh-sync-secret": "shhh" },
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("with the right secret, a system_alert creates a GitHub issue", async () => {
    const gh = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && u.includes("/issues?state=open")) return new Response("[]", { status: 200 });
      if (method === "POST" && u.endsWith("/repos/acme/repo/issues")) {
        return new Response(JSON.stringify({ number: 42, title: "t", state: "open", body: "b", html_url: "u" }), { status: 201 });
      }
      throw new Error(`unexpected ${method} ${u}`);
    }) as unknown as typeof fetch;
    globalThis.fetch = gh;

    const res = await post(
      { kind: "system_alert", client: "acme", ctUserId: 5, reason: "retries exhausted", at: "2026-09-02T00:00:00Z" },
      { "x-eh-sync-secret": "shhh" },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, issue: 42, deduped: false });
  });

  it("502s when GitHub is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await post(
      { kind: "system_alert", client: "acme", ctUserId: 5, reason: "x", at: "t" },
      { "x-eh-sync-secret": "shhh" },
    );
    expect(res.status).toBe(502);
  });
});
