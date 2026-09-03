/**
 * Google Jules quota reader — server/quota-jules.ts.
 *
 * Jules exposes no direct quota endpoint (/quota, /usage, /limits all 404).
 * We count sessions created within the last 24 hours against a daily ceiling of 100.
 *
 * ── KEYS ─────────────────────────────────────────────────────────────────────────────────
 * Two keys exist:
 *   - Key 1: tools/jules/.key (or JULES_API_KEY environment variable)
 *   - Key 2: tools/jules/.key2
 * Each key has an allowance of 100 sessions per rolling 24-hour window.
 *
 * ── NEVER THROWS AND NEVER BLOCKS ────────────────────────────────────────────────────────
 * Modelled on server/usage.ts:
 * 1. A failed or slow reading degrades to the last good one with stale: true.
 * 2. Fetches are bounded by a 5-second timeout.
 * 3. Machine-wide caching and single-flight lock prevents duplicate polls across worktrees.
 * 4. Polling gap is at least 60 seconds (configurable via LOOM_QUOTA_POLL_MS).
 * 5. Stubs supported via LOOM_QUOTA_STUB_JULES / LOOM_QUOTA_STUB / LOOM_QUOTA_FAIL.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface JulesQuota {
  /** Sessions created in the last 24 hours. */
  used: number;
  /** Daily ceiling (100). */
  ceiling: number;
  /** Percent used (0..100). */
  percentUsed: number;
  /** Percent remaining (0..100). */
  percentRemaining: number;
  /** epoch ms when the oldest session in the 24h window rolls off, or null if 0 sessions. */
  resetsAt: number | null;
  /** epoch ms when this reading was taken. */
  at: number;
}

export const JULES_CEILING = 100;
export const JULES_WINDOW_MS = 24 * 60 * 60 * 1000;
const JULES_API_URL = "https://jules.googleapis.com/v1alpha/sessions";
const POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function pollGapMs(): number {
  const raw = Number(process.env["LOOM_QUOTA_POLL_MS"] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : POLL_MS;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolves API key for Jules without throwing or calling process.exit.
 */
export function resolveJulesKey(keyIndex: 1 | 2 = 1): string | null {
  if (keyIndex === 2) {
    const envKey2 = process.env.JULES_API_KEY_2?.trim();
    if (envKey2 && envKey2.length > 0) return envKey2;
  } else {
    const envKey = process.env.JULES_API_KEY?.trim();
    if (envKey && envKey.length > 0) return envKey;
  }

  const keyFileName = keyIndex === 2 ? ".key2" : ".key";
  const candidatePaths = [
    resolve(process.cwd(), `tools/jules/${keyFileName}`),
    resolve(process.cwd(), `../jules/${keyFileName}`),
    join(homedir(), `resilio/docs/Projects/Personal Claude/tools/jules/${keyFileName}`),
    join(homedir(), `looms/gpro/docs/Projects/Personal Claude/tools/jules/${keyFileName}`),
  ];

  for (const path of candidatePaths) {
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf-8").trim();
        if (text.length > 0) return text;
      }
    } catch {
      // Ignore filesystem read errors and try next candidate
    }
  }

  return null;
}

/**
 * PURE parser. Counts sessions within the last 24-hour window from the given `now` timestamp.
 * Returns null if the body is not recognizable as a Jules API response or array of sessions.
 */
export function parseJulesSessions(body: unknown, now: number, ceiling = JULES_CEILING): JulesQuota | null {
  try {
    let rawList: unknown[] | null = null;

    if (Array.isArray(body)) {
      rawList = body;
    } else if (isRecord(body)) {
      if (Array.isArray(body["sessions"])) {
        rawList = body["sessions"];
      } else if (Array.isArray(body["items"])) {
        rawList = body["items"];
      } else {
        // Look for any array value inside the record
        for (const val of Object.values(body)) {
          if (Array.isArray(val)) {
            rawList = val;
            break;
          }
        }
      }
    }

    if (rawList === null) return null;

    const windowStart = now - JULES_WINDOW_MS;
    // Allow slight future clock skew (up to 1 minute in the future)
    const windowEnd = now + 60_000;

    let used = 0;
    let oldestTimestamp: number | null = null;

    for (const item of rawList) {
      if (!isRecord(item)) continue;
      const rawTime =
        item["createTime"] ??
        item["create_time"] ??
        item["createdAt"] ??
        item["created_at"] ??
        item["time"];

      if (typeof rawTime !== "string" || rawTime.length === 0) continue;
      const epoch = Date.parse(rawTime);
      if (Number.isNaN(epoch)) continue;

      if (epoch >= windowStart && epoch <= windowEnd) {
        used++;
        if (oldestTimestamp === null || epoch < oldestTimestamp) {
          oldestTimestamp = epoch;
        }
      }
    }

    const effectiveCeiling = ceiling > 0 ? ceiling : JULES_CEILING;
    const percentUsed = clampPct((used / effectiveCeiling) * 100);
    const percentRemaining = clampPct(((effectiveCeiling - used) / effectiveCeiling) * 100);
    const resetsAt = oldestTimestamp !== null ? oldestTimestamp + JULES_WINDOW_MS : null;

    return {
      used,
      ceiling: effectiveCeiling,
      percentUsed,
      percentRemaining,
      resetsAt,
      at: now,
    };
  } catch {
    return null;
  }
}

function cachePath(keyIndex: 1 | 2): string {
  const override = process.env["LOOM_QUOTA_CACHE_JULES"] ?? process.env["LOOM_QUOTA_CACHE"];
  if (override !== undefined && override.length > 0) return `${override}.jules-${keyIndex}`;
  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "loom", `quota-jules-key${keyIndex}.json`);
}

export interface SharedJulesReading {
  at: number;
  body: unknown;
}

export function readSharedJules(keyIndex: 1 | 2): SharedJulesReading | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath(keyIndex), "utf8"));
    if (!isRecord(raw)) return null;
    const at = raw["at"];
    if (typeof at !== "number") return null;
    return { at, body: raw["body"] };
  } catch {
    return null;
  }
}

export function writeSharedJules(keyIndex: 1 | 2, reading: SharedJulesReading): void {
  try {
    const path = cachePath(keyIndex);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(reading));
    renameSync(tmp, path);
  } catch {
    // Non-fatal cache write failure
  }
}

export function claimJulesPoll(keyIndex: 1 | 2): boolean {
  const lock = `${cachePath(keyIndex)}.lock`;
  try {
    mkdirSync(dirname(lock), { recursive: true });
    closeSync(openSync(lock, "wx"));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lock);
        closeSync(openSync(lock, "wx"));
        return true;
      }
    } catch {
      // Cleared concurrently
    }
    return false;
  }
}

export function releaseJulesPoll(keyIndex: 1 | 2): void {
  try {
    unlinkSync(`${cachePath(keyIndex)}.lock`);
  } catch {
    // Already gone
  }
}

interface JulesState {
  lastGood: JulesQuota | null;
  stale: boolean;
  lastAttempt: number;
  inflight: Promise<void> | null;
  lastFailure: string | null;
}

const julesStates = new Map<1 | 2, JulesState>([
  [1, { lastGood: null, stale: false, lastAttempt: 0, inflight: null, lastFailure: null }],
  [2, { lastGood: null, stale: false, lastAttempt: 0, inflight: null, lastFailure: null }],
]);

function getState(keyIndex: 1 | 2): JulesState {
  let s = julesStates.get(keyIndex);
  if (!s) {
    s = { lastGood: null, stale: false, lastAttempt: 0, inflight: null, lastFailure: null };
    julesStates.set(keyIndex, s);
  }
  return s;
}

async function fetchJulesSessions(apiKey: string): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  try {
    const url = new URL(JULES_API_URL);
    url.searchParams.set("pageSize", "100");

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "x-goog-api-key": apiKey,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }

    const text = await res.text();
    if (!text || text.trim().length === 0) {
      return { ok: true, body: { sessions: [] } };
    }

    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: "invalid JSON response from Jules API" };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? `${err.name}: ${err.message}` : "network error" };
  }
}

async function pollJules(keyIndex: 1 | 2, now: number): Promise<void> {
  const state = getState(keyIndex);
  try {
    if (process.env["LOOM_QUOTA_FAIL"]) {
      state.stale = true;
      state.lastFailure = "LOOM_QUOTA_FAIL is set";
      return;
    }

    const stubPath =
      process.env[`LOOM_QUOTA_STUB_JULES_KEY${keyIndex}`] ??
      process.env["LOOM_QUOTA_STUB_JULES"] ??
      process.env["LOOM_QUOTA_STUB"];

    let body: unknown;
    let readingAt = now;

    if (stubPath !== undefined && stubPath.length > 0) {
      try {
        const fileContent = await Bun.file(stubPath).text();
        const parsed = JSON.parse(fileContent) as unknown;
        if (isRecord(parsed) && "jules" in parsed) {
          body = parsed["jules"];
        } else {
          body = parsed;
        }
      } catch {
        state.stale = true;
        state.lastFailure = `stub at ${stubPath} could not be read or parsed`;
        return;
      }
    } else {
      const shared = readSharedJules(keyIndex);
      if (shared !== null && now - shared.at < pollGapMs()) {
        body = shared.body;
        readingAt = shared.at;
      } else if (!claimJulesPoll(keyIndex)) {
        if (shared !== null) {
          body = shared.body;
          readingAt = shared.at;
        } else {
          return;
        }
      } else {
        try {
          const key = resolveJulesKey(keyIndex);
          if (!key) {
            state.stale = true;
            state.lastFailure = `no Jules API key found for key${keyIndex}`;
            return;
          }
          const res = await fetchJulesSessions(key);
          if (!res.ok) {
            state.stale = true;
            state.lastFailure = res.error;
            return;
          }
          body = res.body;
          writeSharedJules(keyIndex, { at: now, body });
        } finally {
          releaseJulesPoll(keyIndex);
        }
      }
    }

    const quota = parseJulesSessions(body, readingAt);
    if (quota === null) {
      state.stale = true;
      state.lastFailure = "response carried no sessions list";
      return;
    }

    state.lastGood = quota;
    state.stale = false;
    state.lastFailure = null;
  } catch (err) {
    state.stale = true;
    state.lastFailure = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
  }
}

export async function readCurrentJulesQuota(
  keyIndex: 1 | 2 = 1,
  now = Date.now()
): Promise<{ quota: JulesQuota | null; stale: boolean; reason?: string | null }> {
  const state = getState(keyIndex);
  if (state.inflight !== null) {
    await state.inflight;
  } else if (now - state.lastAttempt >= pollGapMs()) {
    state.lastAttempt = now;
    state.inflight = pollJules(keyIndex, now).finally(() => {
      state.inflight = null;
    });
    await state.inflight;
  }
  return {
    quota: state.lastGood,
    stale: state.stale,
    reason: state.lastFailure,
  };
}

export function resetJulesQuotaState(): void {
  for (const s of julesStates.values()) {
    s.lastGood = null;
    s.stale = false;
    s.lastAttempt = 0;
    s.inflight = null;
    s.lastFailure = null;
  }
}
