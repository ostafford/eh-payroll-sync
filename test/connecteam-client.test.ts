import { describe, it, expect, vi } from "vitest";
import { ConnecteamClient } from "../src/connecteam/client.js";

type Route = { status: number; body?: unknown; headers?: Record<string, string> } | "throw";

function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    for (const [pattern, outcome] of Object.entries(routes)) {
      const [m, frag] = pattern.split(" ");
      if (m === method && u.includes(frag!)) {
        if (outcome === "throw") throw new Error("network down");
        return new Response(outcome.body === undefined ? "" : JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { "content-type": "application/json", ...(outcome.headers ?? {}) },
        });
      }
    }
    throw new Error(`unmatched ${method} ${u}`);
  }) as unknown as typeof fetch;
}

const wrap = (data: unknown) => ({ requestId: "r1", data });

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: "ct-key",
  customPublisherId: 777,
  baseUrl: "https://ct.test",
  fetchImpl,
});

describe("ConnecteamClient.listAssignments", () => {
  it("returns the assignments array", async () => {
    const f = fakeFetch({
      "GET /onboarding/v1/packs/5474/assignments": {
        status: 200,
        body: wrap({ assignments: [{ id: 1, userId: 10, status: "completed", isWaitingApproval: false }] }),
      },
    });
    const r = await new ConnecteamClient(cfg(f)).listAssignments(5474);
    expect(r).toEqual({ outcome: "ok", data: [{ id: 1, userId: 10, status: "completed", isWaitingApproval: false }] });
  });

  it("surfaces rate-limit headers on lastRateLimit", async () => {
    const f = fakeFetch({
      "GET /onboarding/v1/packs/5474/assignments": {
        status: 200,
        body: wrap({ assignments: [] }),
        headers: { "x-ratelimit-minute-remaining": "197", "x-ratelimit-minute-limit": "200", "x-ratelimit-day-remaining": "19000" },
      },
    });
    const c = new ConnecteamClient(cfg(f));
    await c.listAssignments(5474);
    expect(c.lastRateLimit).toEqual({ minuteRemaining: 197, minuteLimit: 200, dayRemaining: 19000 });
  });

  it("classifies a 500 as retryable", async () => {
    const f = fakeFetch({ "GET /onboarding/v1/packs/5474/assignments": { status: 503, body: "down" } });
    const r = await new ConnecteamClient(cfg(f)).listAssignments(5474);
    expect(r).toMatchObject({ outcome: "retryable", status: 503 });
  });
});

describe("ConnecteamClient.getUser", () => {
  it("picks the requested user out of the list response", async () => {
    const f = fakeFetch({
      "GET /users/v1/users?userIds=123": {
        status: 200,
        body: wrap({ users: [{ userId: 123, firstName: "Sam", customFields: [] }] }),
      },
    });
    const r = await new ConnecteamClient(cfg(f)).getUser(123);
    expect(r).toEqual({ outcome: "ok", data: { userId: 123, firstName: "Sam", customFields: [] } });
  });

  it("returns null when the user is not in the response", async () => {
    const f = fakeFetch({ "GET /users/v1/users?userIds=123": { status: 200, body: wrap({ users: [] }) } });
    expect(await new ConnecteamClient(cfg(f)).getUser(123)).toEqual({ outcome: "ok", data: null });
  });
});

describe("ConnecteamClient.listUsers", () => {
  it("pages through every active user, up to 500 at a time, until it has the total", async () => {
    const user = (userId: number) => ({ userId, firstName: "A", lastName: "B", customFields: [] });
    const f = fakeFetch({
      "GET /users/v1/users?limit=500&offset=0": {
        status: 200,
        // As the live API pages (demo account, 2026-11-10): `offset` is the next one to ask for.
        body: { ...wrap({ users: [user(1), user(2)] }), paging: { offset: 2, total: 3 } },
      },
      "GET /users/v1/users?limit=500&offset=2": {
        status: 200,
        body: { ...wrap({ users: [user(3)] }), paging: { offset: 3, total: 3 } },
      },
    });
    const r = await new ConnecteamClient(cfg(f)).listUsers();
    expect(r).toEqual({ outcome: "ok", data: [user(1), user(2), user(3)] });
  });

  it("stops at the first page that fails", async () => {
    const f = fakeFetch({ "GET /users/v1/users?limit=500&offset=0": { status: 503, body: "down" } });
    const r = await new ConnecteamClient(cfg(f)).listUsers();
    expect(r.outcome).toBe("retryable");
  });
});

describe("ConnecteamClient.getPayRate", () => {
  it("sends the required date window and returns the user's payRate", async () => {
    const f = fakeFetch({
      "GET /pay-rates/v1/pay-rates": {
        status: 200,
        body: wrap({
          payRatesByUsers: [
            { userId: 123, payRate: { rateType: "hourly", defaultRate: 35, isDefaultRateEnabled: true } },
            { userId: 999, payRate: { rateType: "yearly", defaultRate: 90000, isDefaultRateEnabled: true } },
          ],
        }),
      },
    });
    const r = await new ConnecteamClient(cfg(f)).getPayRate(123, { startDate: "2026-09-10", endDate: "2026-09-10" });
    expect(r).toEqual({
      outcome: "ok",
      data: { rateType: "hourly", defaultRate: 35, isDefaultRateEnabled: true },
    });
    const [url] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://ct.test/pay-rates/v1/pay-rates?userIds=123&startDate=2026-09-10&endDate=2026-09-10",
    );
  });

  it("returns null when the user has no pay rate on file", async () => {
    const f = fakeFetch({
      "GET /pay-rates/v1/pay-rates": { status: 200, body: wrap({ payRatesByUsers: [] }) },
    });
    expect(
      await new ConnecteamClient(cfg(f)).getPayRate(123, { startDate: "2026-09-10", endDate: "2026-09-10" }),
    ).toEqual({ outcome: "ok", data: null });
  });

  it("classifies a 503 as retryable", async () => {
    const f = fakeFetch({ "GET /pay-rates/v1/pay-rates": { status: 503, body: "down" } });
    const r = await new ConnecteamClient(cfg(f)).getPayRate(123, { startDate: "2026-09-10", endDate: "2026-09-10" });
    expect(r.outcome).toBe("retryable");
  });
});

describe("ConnecteamClient messaging", () => {
  it("DMs a user as the custom publisher", async () => {
    const f = fakeFetch({ "POST /chat/v1/conversations/privateMessage/55": { status: 200, body: wrap({}) } });
    const r = await new ConnecteamClient(cfg(f)).sendDirectMessage(55, "  Please fix your BSB.  ");
    expect(r).toEqual({ outcome: "ok", data: null });

    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({ senderId: 777, text: "Please fix your BSB." });
  });

  it("clamps message text to 500 characters", async () => {
    const f = fakeFetch({ "POST /chat/v1/conversations/privateMessage/55": { status: 200, body: wrap({}) } });
    await new ConnecteamClient(cfg(f)).sendDirectMessage(55, "x".repeat(600));
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sent = JSON.parse(init.body as string).text as string;
    expect(sent).toHaveLength(500);
    expect(sent.endsWith("…")).toBe(true);
  });

  it("posts to a channel conversation as the custom publisher", async () => {
    const f = fakeFetch({ "POST /chat/v1/conversations/abc-123/message": { status: 200, body: wrap({}) } });
    const r = await new ConnecteamClient(cfg(f)).sendChannelMessage("abc-123", "Needs a person: SMSF super.");
    expect(r).toEqual({ outcome: "ok", data: null });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("https://ct.test/chat/v1/conversations/abc-123/message");
    expect(JSON.parse(init.body as string)).toEqual({ senderId: 777, text: "Needs a person: SMSF super." });
  });

  it("reports an API error as outcome:error", async () => {
    const f = fakeFetch({ "POST /chat/v1/conversations/privateMessage/55": { status: 400, body: { detail: "bad senderId" } } });
    const r = await new ConnecteamClient(cfg(f)).sendDirectMessage(55, "hi");
    expect(r).toMatchObject({ outcome: "error", status: 400 });
  });
});
