import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CreateSessionOptions, CreateSessionPayload } from "./types.ts";

export const BASE_URL = "https://jules.googleapis.com/v1alpha";

/**
 * Resolves the Google Jules API key.
 * 1. Checks environment variable JULES_API_KEY.
 * 2. Checks tools/jules/.key file (trimmed).
 * If not found, prints a one-line error and exits with code 3.
 * NEVER prints the key.
 */
export function resolveApiKey(): string {
  const envKey = process.env.JULES_API_KEY?.trim();
  if (envKey && envKey.length > 0) {
    return envKey;
  }

  // Check .key file in the script's directory
  const scriptDirKey = join(import.meta.dir, ".key");
  if (existsSync(scriptDirKey)) {
    try {
      const content = readFileSync(scriptDirKey, "utf-8").trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // Ignore read errors and proceed to check next path
    }
  }

  // Check tools/jules/.key relative to current working directory
  const cwdKey = resolve(process.cwd(), "tools/jules/.key");
  if (existsSync(cwdKey)) {
    try {
      const content = readFileSync(cwdKey, "utf-8").trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // Ignore read errors
    }
  }

  console.error(
    "Error: No API key found. Set JULES_API_KEY environment variable or write your key to tools/jules/.key. Create an API key at https://jules.google/settings"
  );
  process.exit(3);
}

/**
 * Normalizes session ID or resource path into a valid API resource path.
 * e.g. "123" -> "sessions/123"
 *      "sessions/123" -> "sessions/123"
 */
export function normalizeSessionPath(id: string): string {
  const clean = id.trim().replace(/^\/+/, "");
  if (clean.startsWith("sessions/") || clean.includes("/sessions/")) {
    return clean;
  }
  return `sessions/${clean}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  body?: any;
  params?: Record<string, string | number | boolean | undefined>;
}

export class JulesClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl = BASE_URL) {
    this.apiKey = apiKey ?? resolveApiKey();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Executes an HTTP request to the Jules API with exponential backoff for 429/5xx errors.
   */
  async request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method || "GET";
    const cleanPath = path.replace(/^\/+/, "");

    // Build URL with query params
    const url = new URL(`${this.baseUrl}/${cleanPath}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      "x-goog-api-key": this.apiKey,
      Accept: "application/json",
    };

    let bodyStr: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const maxRetries = 3;
    let attempt = 0;

    while (true) {
      let response: Response | undefined;
      let networkError: any;

      try {
        response = await fetch(url.toString(), {
          method,
          headers,
          body: bodyStr,
        });
      } catch (err) {
        networkError = err;
      }

      // If we got a successful 2xx response
      if (response && response.ok) {
        const text = await response.text();
        if (!text || text.trim().length === 0) {
          return {} as T;
        }
        try {
          return JSON.parse(text) as T;
        } catch {
          return text as unknown as T;
        }
      }

      // Check if retryable (429, 5xx, or network error)
      const status = response ? response.status : 0;
      const isRetryable =
        status === 429 || (status >= 500 && status <= 599) || (networkError !== undefined);

      if (isRetryable && attempt < maxRetries) {
        attempt++;
        const backoffMs = Math.min(500 * Math.pow(2, attempt) + Math.random() * 200, 10000);
        await new Promise((res) => setTimeout(res, backoffMs));
        continue;
      }

      // Non-retryable or retries exhausted: print HTTP status and body, then exit non-zero
      if (response) {
        const text = await response.text();
        const statusText = response.statusText ? ` ${response.statusText}` : "";
        console.error(`HTTP ${response.status}${statusText}:`);
        try {
          const json = JSON.parse(text);
          console.error(JSON.stringify(json, null, 2));
        } catch {
          console.error(text);
        }
        process.exit(1);
      } else {
        console.error(`Network error: ${networkError?.message || String(networkError)}`);
        process.exit(1);
      }
    }
  }

  /**
   * List connected GitHub sources.
   * GET /sources
   */
  async listSources(): Promise<any> {
    return this.request("sources");
  }

  /**
   * Create a new session.
   * POST /sessions
   */
  async createSession(opts: CreateSessionOptions): Promise<any> {
    const payload: CreateSessionPayload = {
      prompt: opts.prompt,
    };

    if (opts.title) {
      payload.title = opts.title;
    }

    if (opts.plan) {
      payload.requirePlanApproval = true;
    }

    if (!opts.noPr) {
      payload.automationMode = "AUTO_CREATE_PR";
    }

    if (opts.source || opts.branch) {
      const sourceContext: NonNullable<CreateSessionPayload["sourceContext"]> = {};
      if (opts.source) {
        sourceContext.source = opts.source;
      }
      if (opts.branch) {
        sourceContext.githubRepoContext = {
          startingBranch: opts.branch,
        };
      }
      payload.sourceContext = sourceContext;
    }

    return this.request("sessions", {
      method: "POST",
      body: payload,
    });
  }

  /**
   * Get session details.
   * GET /sessions/{id}
   */
  async getSession(id: string): Promise<any> {
    const path = normalizeSessionPath(id);
    return this.request(path);
  }

  /**
   * Delete a session.
   * DELETE /sessions/{id}
   */
  async deleteSession(id: string): Promise<any> {
    const path = normalizeSessionPath(id);
    return this.request(path, {
      method: "DELETE",
    });
  }

  /**
   * Send a message to a session.
   * POST /sessions/{id}:sendMessage
   */
  async sendMessage(id: string, promptText: string): Promise<any> {
    const path = `${normalizeSessionPath(id)}:sendMessage`;
    return this.request(path, {
      method: "POST",
      body: {
        prompt: promptText,
      },
    });
  }

  /**
   * Approve plan for a session.
   * POST /sessions/{id}:approvePlan
   */
  async approvePlan(id: string): Promise<any> {
    const path = `${normalizeSessionPath(id)}:approvePlan`;
    return this.request(path, {
      method: "POST",
      body: {},
    });
  }

  /**
   * List recent sessions.
   * GET /sessions?pageSize=N
   */
  async listSessions(pageSize?: number): Promise<any> {
    return this.request("sessions", {
      params: pageSize !== undefined ? { pageSize } : undefined,
    });
  }

  /**
   * Get activity log for a session.
   * GET /sessions/{id}/activities?pageSize=30&pageToken=...
   */
  async getActivities(id: string, pageSize = 30, pageToken?: string): Promise<any> {
    const path = `${normalizeSessionPath(id)}/activities`;
    return this.request(path, {
      params: { pageSize, pageToken },
    });
  }

  /**
   * Get all activities for a session by paging through until nextPageToken is empty.
   */
  async getAllActivities(id: string, pageSize = 100): Promise<{ activities: any[] }> {
    const allActivities: any[] = [];
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();

    do {
      if (pageToken) {
        if (seenTokens.has(pageToken)) {
          break;
        }
        seenTokens.add(pageToken);
      }

      const resp = await this.getActivities(id, pageSize, pageToken);
      if (resp && typeof resp === "object") {
        const pageItems = Array.isArray(resp.activities)
          ? resp.activities
          : Array.isArray(resp.items)
          ? resp.items
          : Array.isArray(resp.events)
          ? resp.events
          : Array.isArray(resp)
          ? resp
          : [];
        allActivities.push(...pageItems);
        pageToken = resp.nextPageToken || resp.next_page_token;
      } else {
        break;
      }
    } while (pageToken);

    return { activities: allActivities };
  }
}

