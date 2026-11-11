import { describe, it, expect, vi } from "vitest";
import { EhPayrollClient } from "../src/eh/client.js";

/** A fake fetch: match on `${method} ${url-substring}`, return a Response (or throw). */
function fakeFetch(routes: Record<string, { status: number; body?: unknown } | "throw">) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const u = String(url);
    for (const [pattern, outcome] of Object.entries(routes)) {
      const [m, frag] = pattern.split(" ");
      if (m === method && u.includes(frag!)) {
        if (outcome === "throw") throw new Error("network down");
        return new Response(outcome.body === undefined ? "" : JSON.stringify(outcome.body), {
          status: outcome.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`unmatched ${method} ${u}`);
  }) as unknown as typeof fetch;
}

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: "test-key",
  businessId: "555455",
  baseUrl: "https://eh.test/api/v2",
  fetchImpl,
});

const EMP = { id: 987, externalId: "17760356", firstName: "Samuel", surname: "Rivera", status: "Active" };

describe("EhPayrollClient.getByExternalId", () => {
  it("returns the employee on 200", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/17760356": { status: 200, body: EMP } })));
    const r = await c.getByExternalId("17760356");
    expect(r).toEqual({ outcome: "ok", data: EMP });
  });

  it("returns data:null on 404 (no such external id)", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/nope": { status: 404, body: { message: "Not found" } } })));
    expect(await c.getByExternalId("nope")).toEqual({ outcome: "ok", data: null });
  });

  it("classifies 5xx as retryable", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/x": { status: 503, body: "upstream" } })));
    const r = await c.getByExternalId("x");
    expect(r.outcome).toBe("retryable");
    expect(r).toMatchObject({ status: 503 });
  });

  it("classifies a network failure as retryable with no status", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "GET /externalid/x": "throw" })));
    const r = await c.getByExternalId("x");
    expect(r).toMatchObject({ outcome: "retryable", status: null });
  });

  it("sends HTTP Basic auth with the api key as username", async () => {
    const f = fakeFetch({ "GET /externalid/17760356": { status: 200, body: EMP } });
    await new EhPayrollClient(cfg(f)).getByExternalId("17760356");
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("test-key:")}`);
  });
});

describe("EhPayrollClient.findEmployees", () => {
  it("sends the $filter URL-encoded and returns the rows", async () => {
    const f = fakeFetch({ "GET /employee/unstructured?$filter=": { status: 200, body: [EMP] } });
    const r = await new EhPayrollClient(cfg(f)).findEmployees("emailAddress eq 'a+b@x.com'");
    expect(r).toEqual({ outcome: "ok", data: [EMP] });
    const [url] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe(
      "https://eh.test/api/v2/business/555455/employee/unstructured?$filter=emailAddress%20eq%20'a%2Bb%40x.com'",
    );
  });

  it("classifies a 429 as retryable", async () => {
    const f = fakeFetch({ "GET /employee/unstructured?$filter=": { status: 429, body: "slow down" } });
    expect(await new EhPayrollClient(cfg(f)).findEmployees("x eq 'y'")).toMatchObject({ outcome: "retryable", status: 429 });
  });
});

describe("EhPayrollClient.getEmployee", () => {
  it("returns the employee by EH id, or null on 404", async () => {
    const f = fakeFetch({
      "GET /employee/unstructured/987": { status: 200, body: EMP },
      "GET /employee/unstructured/404": { status: 404, body: { message: "Not found" } },
    });
    const c = new EhPayrollClient(cfg(f));
    expect(await c.getEmployee("987")).toEqual({ outcome: "ok", data: EMP });
    expect(await c.getEmployee("404")).toEqual({ outcome: "ok", data: null });
  });
});

describe("EhPayrollClient.setExternalId", () => {
  it("PUTs the Payroll ID and nothing else to the EH id (ADR-0009)", async () => {
    const f = fakeFetch({ "PUT /employee/unstructured/40213": { status: 200, body: { id: 40213, status: "Active" } } });
    expect(await new EhPayrollClient(cfg(f)).setExternalId("40213", "17760356")).toEqual({ outcome: "ok", data: null });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe("https://eh.test/api/v2/business/555455/employee/unstructured/40213");
    expect(JSON.parse(init.body as string)).toEqual({ externalId: "17760356" });
  });

  it("classifies a 503 as retryable", async () => {
    const f = fakeFetch({ "PUT /employee/unstructured/40213": { status: 503, body: "down" } });
    expect(await new EhPayrollClient(cfg(f)).setExternalId("40213", "1")).toMatchObject({ outcome: "retryable" });
  });
});

describe("EhPayrollClient.upsertByExternalId", () => {
  const CREATE_ENVELOPE = { id: 987, status: "Incomplete", detailedStatus: "Basic Details are incomplete", operationType: "Create" };

  it("POSTs a create when no record has the external id, injecting externalId", async () => {
    const f = fakeFetch({
      "GET /externalid/17760356": { status: 404 },
      "POST /employee/unstructured": { status: 201, body: CREATE_ENVELOPE },
    });
    const c = new EhPayrollClient(cfg(f));
    const r = await c.upsertByExternalId("17760356", { firstName: "Samuel", surname: "Rivera" });
    expect(r).toEqual({
      outcome: "ok",
      data: { id: 987, status: "Incomplete", detailedStatus: "Basic Details are incomplete", operationType: "Create", created: true },
    });

    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [postUrl, postInit] = calls[1]!;
    // EH's own merge is off on every create (ADR-0010).
    expect(String(postUrl)).toMatch(/\/business\/555455\/employee\/unstructured\?matchType=None$/);
    expect(JSON.parse(postInit.body as string)).toMatchObject({ externalId: "17760356", surname: "Rivera" });
  });

  it("PUTs an update to the existing employee id when the external id resolves", async () => {
    const f = fakeFetch({
      "GET /externalid/17760356": { status: 200, body: EMP },
      "PUT /employee/unstructured/987": { status: 200, body: { id: 987, status: "Active", detailedStatus: null, operationType: null } },
    });
    const c = new EhPayrollClient(cfg(f));
    const r = await c.upsertByExternalId("17760356", { surname: "Rivera-Chen" });
    expect(r).toMatchObject({ outcome: "ok", data: { id: 987, created: false, status: "Active" } });
  });

  it("uses a record already in hand instead of looking it up again (#102)", async () => {
    const f = fakeFetch({
      "PUT /employee/unstructured/987": { status: 200, body: { id: 987, status: "Active", detailedStatus: null, operationType: null } },
      "POST /employee/unstructured": { status: 201, body: CREATE_ENVELOPE },
    });
    const c = new EhPayrollClient(cfg(f));
    expect(await c.upsertByExternalId("17760356", { surname: "X" }, EMP)).toMatchObject({ data: { created: false } });
    expect(await c.upsertByExternalId("17760356", { surname: "X" }, null)).toMatchObject({ data: { created: true } });
    const methods = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, init]) => init.method);
    expect(methods).toEqual(["PUT", "POST"]); // no GET
  });

  it("surfaces a 400 validation body as a parsed validation result and does not throw", async () => {
    const f = fakeFetch({
      "GET /externalid/17760356": { status: 404 },
      "POST /employee/unstructured": {
        status: 400,
        body: { message: "BankAccount1: BSB must contain 6 digits only\nBankAccount1: BSB is invalid" },
      },
    });
    const r = await new EhPayrollClient(cfg(f)).upsertByExternalId("17760356", { bankAccount1_BSB: "12345" });
    expect(r).toEqual({
      outcome: "validation",
      status: 400,
      issues: [
        { field: "BankAccount1", reason: "BSB must contain 6 digits only" },
        { field: "BankAccount1", reason: "BSB is invalid" },
      ],
    });
  });

  it("propagates a retryable lookup failure without attempting a write", async () => {
    const f = fakeFetch({ "GET /externalid/17760356": { status: 500, body: "boom" } });
    const r = await new EhPayrollClient(cfg(f)).upsertByExternalId("17760356", { surname: "X" });
    expect(r.outcome).toBe("retryable");
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe("EhPayrollClient.deleteEmployee", () => {
  it.each([429, 503])("reports a %i as retryable, so test cleanup tries again (#177)", async (status) => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "DELETE /employee/987": { status } })));
    expect(await c.deleteEmployee(987)).toMatchObject({ outcome: "retryable", status });
  });

  it("reports a 404 as a client error", async () => {
    const c = new EhPayrollClient(cfg(fakeFetch({ "DELETE /employee/987": { status: 404 } })));
    expect(await c.deleteEmployee(987)).toMatchObject({ outcome: "client_error", status: 404 });
  });
});
