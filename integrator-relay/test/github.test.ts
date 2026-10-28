import { describe, it, expect, vi } from "vitest";
import { GitHubRestIssues } from "../src/github.js";

function fakeFetch(routes: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({
      url: String(url),
      method: (i.method ?? "GET").toUpperCase(),
      body: i.body ? JSON.parse(i.body as string) : undefined,
      headers: (i.headers ?? {}) as Record<string, string>,
    });
    const r = routes(String(url), i);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const cfg = (fetchImpl: typeof fetch) => ({ repo: "acme/repo", token: "ghp_x", fetchImpl });

describe("GitHubRestIssues", () => {
  it("sends bearer auth, the API version and a user-agent", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: [] }));
    await new GitHubRestIssues(cfg(fn)).findOpenByTitle("x");
    expect(calls[0]!.headers.authorization).toBe("Bearer ghp_x");
    expect(calls[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(calls[0]!.headers["user-agent"]).toBeTruthy();
  });

  it("findOpenByTitle lists open eh-relay issues and matches the title exactly", async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url).toContain("/repos/acme/repo/issues?state=open&labels=eh-relay");
      return {
        body: [
          { number: 2, title: "[eh-payroll-sync] system alert — acme / user 5", state: "open", body: "", html_url: "u2" },
          { number: 1, title: "something else", state: "open", body: "", html_url: "u1" },
        ],
      };
    });
    const hit = await new GitHubRestIssues(cfg(fn)).findOpenByTitle("[eh-payroll-sync] system alert — acme / user 5");
    expect(hit?.number).toBe(2);
    const miss = await new GitHubRestIssues(cfg(fn)).findOpenByTitle("[eh-payroll-sync] system alert — acme / user 9");
    expect(miss).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("create POSTs title/body/labels", async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201, body: { number: 7, title: "t", state: "open", body: "b", html_url: "u" } }));
    const issue = await new GitHubRestIssues(cfg(fn)).create({ title: "t", body: "b", labels: ["eh-relay", "system-alert"] });
    expect(issue.number).toBe(7);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/repo/issues");
    expect(calls[0]!.body).toEqual({ title: "t", body: "b", labels: ["eh-relay", "system-alert"] });
  });

  it("comment and update hit the right endpoints", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    const gh = new GitHubRestIssues(cfg(fn));
    await gh.comment(7, "hi");
    await gh.update(7, { state: "closed" });
    expect(calls[0]!).toMatchObject({ method: "POST", url: "https://api.github.com/repos/acme/repo/issues/7/comments", body: { body: "hi" } });
    expect(calls[1]!).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/acme/repo/issues/7", body: { state: "closed" } });
  });

  it("throws with status + snippet on a GitHub error", async () => {
    const { fn } = fakeFetch(() => ({ status: 403, body: { message: "Resource not accessible by personal access token" } }));
    await expect(new GitHubRestIssues(cfg(fn)).create({ title: "t", body: "b", labels: [] })).rejects.toThrow(/403.*not accessible/s);
  });
});
