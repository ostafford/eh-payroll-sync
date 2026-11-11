/**
 * Employment Hero Payroll (AU) API client. Narrow surface: look an employee up
 * by external id, and create-or-update by external id. Auth is HTTP Basic with
 * the API key as the username. Every call returns an {@link EhResult} so callers
 * branch on outcome rather than catching.
 *
 * Confirmed against the live API (issue #2):
 *  - GET .../employee/unstructured/externalid/{id}  -> 200 full record, or 404
 *  - GET .../employee/unstructured?$filter=...       -> 200 [records], terminated ones included (#131, #141)
 *  - POST .../employee/unstructured                 -> 201 { id, status, detailedStatus, operationType }
 *  - PUT  .../employee/unstructured/{id}            -> 200 same envelope
 *  - validation failures are HTTP 400 with { message: "Field: reason\n..." }
 *  - DELETE .../employee/{id}                       -> 200  (test cleanup only)
 */
import { httpJson, type HttpResponse } from "../http/json.js";
import { parseValidationBody, type EhFieldError } from "./errors.js";
import type { EhEmployee, EhEmployeePayload, EhWriteResult } from "./types.js";

export type EhResult<T> =
  | { outcome: "ok"; data: T }
  | { outcome: "validation"; issues: EhFieldError[]; status: number }
  | { outcome: "retryable"; status: number | null; detail: string }
  | { outcome: "client_error"; status: number; detail: string };

export interface EhClientConfig {
  apiKey: string;
  businessId: string;
  /** Defaults to the AU production host. Override for tests. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.yourpayroll.com.au/api/v2";

export class EhPayrollClient {
  readonly #base: string;
  readonly #businessId: string;
  readonly #auth: string;
  readonly #fetch: typeof fetch;

  constructor(cfg: EhClientConfig) {
    this.#base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#businessId = cfg.businessId;
    this.#auth = `Basic ${btoa(`${cfg.apiKey}:`)}`;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  #url(path: string): string {
    return `${this.#base}/business/${this.#businessId}${path}`;
  }

  #get(path: string) {
    return httpJson({ method: "GET", url: this.#url(path), headers: { authorization: this.#auth } }, this.#fetch);
  }

  #write(method: "POST" | "PUT", path: string, body: EhEmployeePayload) {
    return httpJson({ method, url: this.#url(path), headers: { authorization: this.#auth }, body }, this.#fetch);
  }

  async getByExternalId(externalId: string): Promise<EhResult<EhEmployee | null>> {
    const r = await this.#get(`/employee/unstructured/externalid/${encodeURIComponent(externalId)}`);
    if (r.kind === "success") return { outcome: "ok", data: (r.body as EhEmployee) ?? null };
    if (r.kind === "client_error" && r.status === 404) return { outcome: "ok", data: null };
    return toResult(r);
  }

  /** One employee by EH id, or `data: null` when EH has none (a link's target, ADR-0009). */
  async getEmployee(employeeId: string): Promise<EhResult<EhEmployee | null>> {
    const r = await this.#get(`/employee/unstructured/${encodeURIComponent(employeeId)}`);
    if (r.kind === "success") return { outcome: "ok", data: (r.body as EhEmployee) ?? null };
    if (r.kind === "client_error" && r.status === 404) return { outcome: "ok", data: null };
    return toResult(r);
  }

  /**
   * Set only the Payroll ID (`externalId`) on an existing employee: the link
   * (ADR-0009). A partial PUT keeps every other value EH holds (#135).
   */
  async setExternalId(employeeId: string, externalId: string): Promise<EhResult<null>> {
    const r = await this.#write("PUT", `/employee/unstructured/${encodeURIComponent(employeeId)}`, { externalId });
    return r.kind === "success" ? { outcome: "ok", data: null } : toResult(r);
  }

  /**
   * Every employee matching an OData `$filter` on the unstructured endpoint,
   * terminated ones included (#141). For the Pre-create check (ADR-0010); the
   * rows carry full values (TFN unmasked), so never log or store them.
   */
  async findEmployees(filter: string): Promise<EhResult<EhEmployee[]>> {
    const r = await this.#get(`/employee/unstructured?$filter=${encodeURIComponent(filter)}`);
    if (r.kind === "success") return { outcome: "ok", data: Array.isArray(r.body) ? (r.body as EhEmployee[]) : [] };
    return toResult(r);
  }

  /**
   * Create the employee if no record carries this external id, otherwise update
   * the existing one. `externalId` is written into the payload so a fresh create
   * is linked from the start. A create goes out with `matchType=None`, so EH
   * never merges it into an existing employee (ADR-0010): the caller runs the
   * Pre-create check first. Returns the write envelope - call
   * {@link getByExternalId} afterwards for a field-level read-back.
   *
   * Pass `current` (a {@link getByExternalId} result already in hand, `null`
   * for none) to skip looking the record up again.
   */
  async upsertByExternalId(
    externalId: string,
    payload: EhEmployeePayload,
    current?: EhEmployee | null,
  ): Promise<EhResult<EhWriteResult>> {
    const existing: EhResult<EhEmployee | null> =
      current === undefined ? await this.getByExternalId(externalId) : { outcome: "ok", data: current };
    if (existing.outcome !== "ok") return existing;

    const body: EhEmployeePayload = { ...payload, externalId };
    const created = existing.data === null;
    const r = created
      ? await this.#write("POST", `/employee/unstructured?matchType=None`, body)
      : await this.#write("PUT", `/employee/unstructured/${existing.data!.id}`, body);

    if (r.kind === "success") {
      const env = (r.body ?? {}) as Record<string, unknown>;
      return {
        outcome: "ok",
        data: {
          id: typeof env.id === "number" ? env.id : existing.data?.id ?? 0,
          status: typeof env.status === "string" ? env.status : null,
          detailedStatus: typeof env.detailedStatus === "string" ? env.detailedStatus : null,
          operationType: typeof env.operationType === "string" ? env.operationType : null,
          created,
        },
      };
    }
    return toResult(r);
  }

  /** Test-support only: permanently delete an employee. Never used in the sync path. */
  async deleteEmployee(employeeId: number): Promise<EhResult<null>> {
    const del = await this.#fetch(this.#url(`/employee/${employeeId}`), {
      method: "DELETE",
      headers: { authorization: this.#auth },
    });
    if (del.ok) return { outcome: "ok", data: null };
    const detail = `delete failed (${del.status})`;
    return del.status === 429 || del.status >= 500
      ? { outcome: "retryable", status: del.status, detail }
      : { outcome: "client_error", status: del.status, detail };
  }
}

function toResult(r: HttpResponse): EhResult<never> {
  switch (r.kind) {
    case "validation":
      return { outcome: "validation", issues: parseValidationBody(r.body), status: r.status };
    case "client_error":
      // EH returns validation failures as 400 with a { message } body.
      if ((r.status === 400 || r.status === 422) && looksLikeValidation(r.body)) {
        return { outcome: "validation", issues: parseValidationBody(r.body), status: r.status };
      }
      return {
        outcome: "client_error",
        status: r.status,
        detail: typeof r.body === "string" ? r.body : JSON.stringify(r.body).slice(0, 300),
      };
    case "retryable":
      return { outcome: "retryable", status: r.status, detail: r.detail };
    case "success":
      return { outcome: "retryable", status: r.status, detail: "unexpected success routed as error" };
  }
}

function looksLikeValidation(body: unknown): boolean {
  if (typeof body === "string") return body.trim() !== "";
  if (body !== null && typeof body === "object") {
    const o = body as Record<string, unknown>;
    return typeof o.message === "string" || typeof o.Message === "string" || Object.values(o).some(Array.isArray);
  }
  return false;
}
