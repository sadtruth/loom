/**
 * Service worker behaviour properties (client/sw.js, R5).
 *
 * sw-1: network answers  → response is returned and stored in cache.
 * sw-2: network throws, shell cached → cached shell is returned.
 * sw-3: network throws, nothing cached → 503 response.
 * sw-4: non-navigate request → respondWith is never called.
 * sw-5: activate drops stale SHELL caches only — never the snapshot cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── sandbox helpers ──────────────────────────────────────────────────

/** Minimal Response stand-in that records whether it was cloned. */
function makeResponse(status = 200): Response {
  return new Response("body", { status });
}

function buildSandbox() {
  const handlers: Record<string, ((event: unknown) => void)[]> = {};
  const cacheStore = new Map<string, Response>();

  const fakeCache = {
    put: async (req: Request | string, res: Response) => {
      const key = typeof req === "string" ? req : req.url;
      cacheStore.set(key, res);
    },
    match: async (req: Request | string): Promise<Response | undefined> => {
      const key = typeof req === "string" ? req : req.url;
      return cacheStore.get(key);
    },
  };

  const g = globalThis as Record<string, unknown>;

  g["self"] = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      (handlers[type] ??= []).push(fn);
    },
    skipWaiting() {},
    clients: { claim: async () => {} },
  };

  g["caches"] = {
    open: async () => fakeCache,
    keys: async () => [],
    delete: async () => true,
  };

  return {
    handlers,
    cacheStore,
    fakeCache,
    cleanup() {
      delete g["self"];
      delete g["caches"];
      delete g["fetch"];
    },
  };
}

// Load the SW source once; each test re-runs it in the sandbox via dynamic import cache busting.
// Because Bun caches dynamic imports, we inline-eval the source instead.
const SW_PATH = join(import.meta.dir, "../../client/sw.js");
const swSource = readFileSync(SW_PATH, "utf8");

/** Run the SW source in the current globalThis sandbox and return captured handlers. */
function loadSW(sandbox: ReturnType<typeof buildSandbox>) {
  // eslint-disable-next-line no-new-func
  const fn = new Function(swSource);
  fn();
  return sandbox.handlers;
}

// ── tests ────────────────────────────────────────────────────────────

describe("sw: network-first navigation fetch", () => {
  let sandbox: ReturnType<typeof buildSandbox>;

  beforeEach(() => {
    sandbox = buildSandbox();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function makeNavEvent(url = "http://x/") {
    let captured: Promise<Response> | null = null;
    return {
      request: { mode: "navigate" as const, url },
      respondWith(p: Promise<Response>) {
        captured = p;
      },
      get captured() {
        return captured;
      },
    };
  }

  test("sw-1: network answers → response returned and stored in cache", async () => {
    const networkRes = makeResponse(200);
    (globalThis as Record<string, unknown>)["fetch"] = async () => networkRes;

    const handlers = loadSW(sandbox);
    const fetchHandlers = handlers["fetch"] ?? [];
    expect(fetchHandlers.length).toBeGreaterThan(0);

    const event = makeNavEvent("http://x/");
    for (const h of fetchHandlers) h(event);

    const result = await event.captured!;
    expect(result.status).toBe(200);

    // Stored in cache
    const cached = await sandbox.fakeCache.match({ url: "http://x/" } as Request);
    expect(cached).toBeDefined();
  });

  test("sw-2: network throws, shell cached → cached shell returned", async () => {
    // Pre-populate the cache
    const shell = makeResponse(200);
    await sandbox.fakeCache.put({ url: "http://x/" } as Request, shell);
    (globalThis as Record<string, unknown>)["fetch"] = async () => {
      throw new Error("offline");
    };

    const handlers = loadSW(sandbox);
    const fetchHandlers = handlers["fetch"] ?? [];

    const event = makeNavEvent("http://x/");
    for (const h of fetchHandlers) h(event);

    const result = await event.captured!;
    expect(result.status).toBe(200);
  });

  test("sw-3: network throws, nothing cached → 503", async () => {
    (globalThis as Record<string, unknown>)["fetch"] = async () => {
      throw new Error("offline");
    };

    const handlers = loadSW(sandbox);
    const fetchHandlers = handlers["fetch"] ?? [];

    const event = makeNavEvent("http://x/");
    for (const h of fetchHandlers) h(event);

    const result = await event.captured!;
    expect(result.status).toBe(503);
  });

  test("sw-4: non-navigate request → respondWith never called", async () => {
    (globalThis as Record<string, unknown>)["fetch"] = async () => makeResponse(200);

    const handlers = loadSW(sandbox);
    const fetchHandlers = handlers["fetch"] ?? [];

    let captured: unknown = undefined;
    const event = {
      request: { mode: "cors" as const, url: "http://x/chunk.js" },
      respondWith(p: unknown) { captured = p; },
    };
    for (const h of fetchHandlers) h(event);

    // Must NOT have called respondWith
    expect(captured).toBeUndefined();
  });

  test("sw-5: activate deletes stale shell caches and leaves loom-snap alone", async () => {
    const present = ["loom-shell-v1", "loom-shell-v2", "loom-snap", "something-else"];
    const deleted: string[] = [];
    (globalThis as Record<string, unknown>)["caches"] = {
      open: async () => sandbox.fakeCache,
      keys: async () => present,
      delete: async (k: string) => {
        deleted.push(k);
        return true;
      },
    };

    const handlers = loadSW(sandbox);
    let waited: Promise<unknown> | null = null;
    for (const h of handlers["activate"] ?? []) {
      h({
        waitUntil(p: Promise<unknown>) {
          waited = p;
        },
      });
    }
    await waited;

    expect(deleted).toEqual(["loom-shell-v1"]);
  });
});
