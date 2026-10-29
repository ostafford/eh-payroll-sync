/**
 * The tiny slice of the GitHub Issues REST API the relay needs. Kept behind an
 * interface so {@link ../test/relay.test.ts} runs with a fake and no network.
 *
 * Auth: a fine-grained PAT with "Issues: Read and write" on the one repo. It
 * lives only in this Worker's secrets - never in a client deployment.
 */

export interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string;
  html_url: string;
}

export interface GitHubIssues {
  /** The newest OPEN issue whose title matches exactly, or null. */
  findOpenByTitle(title: string): Promise<Issue | null>;
  create(input: { title: string; body: string; labels: string[] }): Promise<Issue>;
  comment(issueNumber: number, body: string): Promise<void>;
  update(issueNumber: number, patch: { body?: string; state?: "open" | "closed" }): Promise<void>;
}

export class GitHubRestIssues implements GitHubIssues {
  readonly #repo: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(cfg: { repo: string; token: string; fetchImpl?: typeof fetch }) {
    this.#repo = cfg.repo;
    this.#headers = {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "eh-payroll-sync-relay",
    };
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  async #json(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.#fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { ...this.#headers, ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GitHub ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /**
   * List (not search) so a just-created issue is visible immediately - the
   * search index lags by seconds, which would spawn duplicates on a burst.
   */
  async findOpenByTitle(title: string): Promise<Issue | null> {
    const rows = (await this.#json(
      `/repos/${this.#repo}/issues?state=open&labels=eh-relay&per_page=100&sort=created&direction=desc`,
    )) as Issue[];
    return rows.find((r) => r.title === title) ?? null;
  }

  async create(input: { title: string; body: string; labels: string[] }): Promise<Issue> {
    return (await this.#json(`/repos/${this.#repo}/issues`, {
      method: "POST",
      body: JSON.stringify(input),
    })) as Issue;
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    await this.#json(`/repos/${this.#repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async update(issueNumber: number, patch: { body?: string; state?: "open" | "closed" }): Promise<void> {
    await this.#json(`/repos/${this.#repo}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }
}
