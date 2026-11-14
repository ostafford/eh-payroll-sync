/**
 * Connecteam API client: read onboarding assignments and users, send chat
 * messages as the custom publisher. Auth is the `X-API-KEY` header.
 *
 * Verified against the live API (issue #3):
 *  - GET  /users/v1/users?userIds={id}                     (no single-user GET)
 *  - GET  /users/v1/users?limit=&offset=   active users only by default; limit <= 500;
 *         paging { offset: next offset, total } (#154, demo account 2026-11-10)
 *  - GET  /onboarding/v1/packs/{packId}/assignments
 *  - GET  /pay-rates/v1/pay-rates?userIds={id}&startDate=&endDate=  (dates required)
 *  - GET  /chat/v1/conversations
 *  - POST /chat/v1/conversations/privateMessage/{userId}   body { senderId, text }
 *  - POST /chat/v1/conversations/{conversationId}/message  body { senderId, text }
 *  - rate limit headers: x-ratelimit-minute-remaining / -limit, -day-remaining
 */
import { httpJson, type HttpResponse } from "../http/json.js";
import type {
  Conversation,
  CtResult,
  OnboardingAssignment,
  ConnecteamUser,
  PayRate,
  RateLimit,
} from "./types.js";

export interface CtClientConfig {
  apiKey: string;
  /**
   * Custom publisher id (from Settings -> Feed settings). Needed only to send
   * chat: a send without one reports `outcome: "error"` and sends nothing.
   * Leave it out for a read-only caller.
   */
  customPublisherId?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.connecteam.com";
const MAX_TEXT = 500;
const USERS_PAGE = 500;

/** A send from a client made without a custom publisher id. No HTTP call was made, so no status. */
const NO_PUBLISHER: CtResult<null> = { outcome: "error", status: 0, detail: "no custom publisher id: nothing sent" };

export class ConnecteamClient {
  readonly #base: string;
  readonly #apiKey: string;
  readonly #publisherId: number | undefined;
  readonly #fetch: typeof fetch;

  /** Rate-limit headers from the most recent call, for callers that back off. */
  lastRateLimit: RateLimit | null = null;

  constructor(cfg: CtClientConfig) {
    this.#base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.#apiKey = cfg.apiKey;
    this.#publisherId = cfg.customPublisherId;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResponse> {
    const r = await httpJson(
      { method, url: `${this.#base}${path}`, headers: { "X-API-KEY": this.#apiKey }, body },
      this.#fetch,
    );
    if (r.kind !== "retryable") this.lastRateLimit = readRateLimit(r.headers);
    return r;
  }

  async listAssignments(packId: number): Promise<CtResult<OnboardingAssignment[]>> {
    const r = await this.#call("GET", `/onboarding/v1/packs/${packId}/assignments`);
    return unwrap(r, (b) => (b as Wrapped<{ assignments: OnboardingAssignment[] }>).data.assignments);
  }

  async getUser(userId: number): Promise<CtResult<ConnecteamUser | null>> {
    const r = await this.#call("GET", `/users/v1/users?userIds=${userId}&limit=1&offset=0`);
    return unwrap(r, (b) => {
      const users = (b as Wrapped<{ users: ConnecteamUser[] }>).data.users;
      return users.find((u) => u.userId === userId) ?? null;
    });
  }

  /**
   * Every active user (the API leaves archived ones out unless asked), paging
   * until `paging.total`. 500 is the largest page the API accepts.
   */
  async listUsers(): Promise<CtResult<ConnecteamUser[]>> {
    const users: ConnecteamUser[] = [];
    for (let offset = 0; ; ) {
      const r = await this.#call("GET", `/users/v1/users?limit=${USERS_PAGE}&offset=${offset}`);
      const page = unwrap(r, (b) => {
        const body = b as Wrapped<{ users: ConnecteamUser[] }> & { paging: { offset: number; total: number } };
        return { users: body.data.users, next: body.paging.offset, total: body.paging.total };
      });
      if (page.outcome !== "ok") return page;
      users.push(...page.data.users);
      if (!page.data.users.length || page.data.next >= page.data.total) return { outcome: "ok", data: users };
      offset = page.data.next;
    }
  }

  /**
   * One user's effective pay rate for a date window (issue #42). `startDate` /
   * `endDate` are `YYYY-MM-DD` and both required - the API 400s without them.
   * Returns `null` when the user has no pay rate on file.
   */
  async getPayRate(
    userId: number,
    window: { startDate: string; endDate: string },
  ): Promise<CtResult<PayRate | null>> {
    const qs =
      `userIds=${userId}` +
      `&startDate=${encodeURIComponent(window.startDate)}` +
      `&endDate=${encodeURIComponent(window.endDate)}`;
    const r = await this.#call("GET", `/pay-rates/v1/pay-rates?${qs}`);
    return unwrap(r, (b) => {
      const rows =
        (b as Wrapped<{ payRatesByUsers?: Array<{ userId: number; payRate?: PayRate }> }>).data
          .payRatesByUsers ?? [];
      return rows.find((x) => x.userId === userId)?.payRate ?? null;
    });
  }

  async listConversations(): Promise<CtResult<Conversation[]>> {
    const r = await this.#call("GET", `/chat/v1/conversations`);
    return unwrap(r, (b) => (b as Wrapped<{ conversations: Conversation[] }>).data.conversations);
  }

  /** DM a user as the custom publisher. Text is clamped to 500 chars. */
  async sendDirectMessage(userId: number, text: string): Promise<CtResult<null>> {
    if (this.#publisherId === undefined) return NO_PUBLISHER;
    const r = await this.#call("POST", `/chat/v1/conversations/privateMessage/${userId}`, {
      senderId: this.#publisherId,
      text: clamp(text),
    });
    return unwrap(r, () => null);
  }

  /** Post to a team/channel conversation as the custom publisher. */
  async sendChannelMessage(conversationId: string, text: string): Promise<CtResult<null>> {
    if (this.#publisherId === undefined) return NO_PUBLISHER;
    const r = await this.#call("POST", `/chat/v1/conversations/${conversationId}/message`, {
      senderId: this.#publisherId,
      text: clamp(text),
    });
    return unwrap(r, () => null);
  }
}

interface Wrapped<T> {
  requestId: string;
  data: T;
}

function clamp(text: string): string {
  const t = text.trim();
  return t.length <= MAX_TEXT ? t : `${t.slice(0, MAX_TEXT - 1)}…`;
}

function readRateLimit(h: Headers): RateLimit {
  const num = (name: string): number | null => {
    const v = h.get(name);
    return v === null || v === "" ? null : Number(v);
  };
  return {
    minuteRemaining: num("x-ratelimit-minute-remaining"),
    minuteLimit: num("x-ratelimit-minute-limit"),
    dayRemaining: num("x-ratelimit-day-remaining"),
  };
}

function unwrap<T>(r: HttpResponse, pick: (body: unknown) => T): CtResult<T> {
  switch (r.kind) {
    case "success":
      try {
        return { outcome: "ok", data: pick(r.body) };
      } catch {
        return { outcome: "error", status: r.status, detail: "unexpected response shape" };
      }
    case "retryable":
      return { outcome: "retryable", status: r.status, detail: r.detail };
    case "validation":
    case "client_error":
      return {
        outcome: "error",
        status: r.status,
        detail: typeof r.body === "string" ? r.body : JSON.stringify(r.body).slice(0, 300),
      };
  }
}
