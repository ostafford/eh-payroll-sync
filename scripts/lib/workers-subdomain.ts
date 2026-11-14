/**
 * The account's workers.dev subdomain (#194). A brand-new Cloudflare account
 * has none, and `wrangler deploy` then asks to register one; run from the
 * wizard it can't answer, so the deploy failed after every secret was stored.
 * The wizard checks at the Cloudflare account stage instead, and registers
 * one here when there isn't one.
 *
 * The calls and error codes are the ones wrangler's own registration uses
 * (wrangler 4.160, `registerSubdomain`):
 *  - GET  /accounts/{id}/workers/subdomain          -> { subdomain }, or error 10007: none yet
 *  - GET  /accounts/{id}/workers/subdomains/{name}  -> error 10032: available, 10031: taken
 *  - PUT  /accounts/{id}/workers/subdomain { subdomain } -> registers it
 *
 * The API is passed in, so this is tested without Cloudflare.
 */

/** One Cloudflare API v4 response, as far as this needs it. */
export type CfResponse =
  | { ok: true; result: unknown }
  | { ok: false; code: number | null; message: string };

export type CfApi = (method: "GET" | "PUT", path: string, body?: unknown) => Promise<CfResponse>;

export const NO_SUBDOMAIN = 10007;
export const NAME_AVAILABLE = 10032;
export const NAME_TAKEN = 10031;

/** Wrangler's rule: lowercase letters, digits and hyphens, 1–63 long, not starting or ending with a hyphen. */
const VALID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const NAME_RULES =
  "lowercase letters, digits and hyphens, up to 63 characters, not starting or ending with a hyphen; it must be unused across all of Cloudflare";

/** Where to see or change it by hand, as a dashboard path: wrangler's deep link 404s (#194). */
export const DASHBOARD_PATH = "Cloudflare dashboard > Workers & Pages > Account details > Subdomain";

/** The account's subdomain, or null when it has none yet. Throws on any other answer. */
export async function readSubdomain(api: CfApi, accountId: string): Promise<string | null> {
  const r = await api("GET", `/accounts/${accountId}/workers/subdomain`);
  if (r.ok) {
    const name = (r.result as { subdomain?: unknown } | null)?.subdomain;
    if (typeof name === "string" && name) return name;
    return null;
  }
  if (r.code === NO_SUBDOMAIN) return null;
  throw new Error(`Couldn't read the account's workers.dev subdomain: ${r.message}`);
}

export type RegisterResult = { ok: true; subdomain: string } | { ok: false; reason: string };

/** Register `name` as the account's subdomain: checked locally, then for availability, then registered. */
export async function registerSubdomain(api: CfApi, accountId: string, input: string): Promise<RegisterResult> {
  const name = input.trim();
  if (!VALID.test(name)) return { ok: false, reason: `"${name}" isn't a valid name: use ${NAME_RULES}.` };

  const check = await api("GET", `/accounts/${accountId}/workers/subdomains/${name}`);
  if (!check.ok && check.code === NAME_TAKEN) return { ok: false, reason: `"${name}" is already taken. Try another.` };
  if (!check.ok && check.code !== NAME_AVAILABLE) {
    return { ok: false, reason: `Couldn't check whether "${name}" is free: ${check.message}` };
  }

  const put = await api("PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain: name });
  if (put.ok) {
    const got = (put.result as { subdomain?: unknown } | null)?.subdomain;
    return { ok: true, subdomain: typeof got === "string" && got ? got : name };
  }
  if (put.code === NAME_TAKEN) return { ok: false, reason: `"${name}" is already taken. Try another.` };
  return { ok: false, reason: `Cloudflare didn't register "${name}": ${put.message}` };
}

/**
 * Ask for names until one registers. A blank answer stops, returning null.
 * `say` prints each reason a name didn't work.
 */
export async function registerUntilDone(
  api: CfApi,
  accountId: string,
  ask: () => Promise<string>,
  say: (line: string) => void,
): Promise<string | null> {
  for (;;) {
    const name = (await ask()).trim();
    if (!name) return null;
    const r = await registerSubdomain(api, accountId, name);
    if (r.ok) return r.subdomain;
    say(r.reason);
  }
}

/** Parse a Cloudflare v4 JSON body into a {@link CfResponse}. */
export function toCfResponse(status: number, body: unknown): CfResponse {
  const b = (body ?? {}) as { success?: unknown; result?: unknown; errors?: Array<{ code?: unknown; message?: unknown }> };
  if (status >= 200 && status < 300 && b.success !== false) return { ok: true, result: b.result ?? null };
  const first = Array.isArray(b.errors) ? b.errors[0] : undefined;
  return {
    ok: false,
    code: typeof first?.code === "number" ? first.code : null,
    message: typeof first?.message === "string" && first.message ? first.message : `HTTP ${status}`,
  };
}
