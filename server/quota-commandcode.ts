/**
 * Command Code quota reader — server/quota-commandcode.ts.
 *
 * The box's Claude Code runs on Command Code's subscription (see CLAUDE.md, "Backend (box)"), and
 * that subscription paces usage three ways: a monthly credit pool, a rolling 5-hour cap and a
 * rolling weekly cap. This module reads all three from the same two routes the vendor's own CLI
 * uses, found in `command-code` 1.93.2 (`dist/cli.mjs`, `fetchUsageData`):
 *
 *   GET https://api.commandcode.ai/alpha/billing/credits
 *   GET https://api.commandcode.ai/alpha/billing/subscriptions
 *
 * ── THE ARITHMETIC, TAKEN FROM THE CLI, NOT INVENTED ──────────────────────────────────────
 *
 * `credits.monthlyCredits` is what is LEFT of the month, not what is spent. The pool it is left of
 * comes from the plan id: the CLI carries the table below and computes
 * `percent = (pool - remaining) / pool`. The two rolling windows arrive already spent, as
 * `{used, cap, resetAt}` in credits, so they need no table: 0.46 of 14 today.
 *
 * ── NEVER THROWS AND NEVER BLOCKS ────────────────────────────────────────────────────────
 *
 * Same contract as `quota-google.ts`: one poll per machine every 60 s behind a lock, last GOOD
 * reading kept and marked stale on failure, subprocess-free but time-bounded fetches, and a
 * missing key is "unavailable with a reason", never an exception.
 *
 * ── STUBBED FOR THE PINS ─────────────────────────────────────────────────────────────────
 *
 * `LOOM_QUOTA_STUB_COMMANDCODE=<path>` reads JSON `{credits, subscription}` from that file instead
 * of fetching, and `LOOM_QUOTA_FAIL=1` behaves as a failed poll. Both are read PER POLL.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CommandCodeWindow {
  /** Credits spent inside this window, as the endpoint reports them. */
  used: number;
  /** Credits the window allows. */
  cap: number;
  /** 0..100, clamped. */
  percentUsed: number;
  /** epoch ms when the window resets, or null when unstated. */
  resetsAt: number | null;
  exceeded: boolean;
}

export interface CommandCodeQuota {
  fiveHour: CommandCodeWindow | null;
  weekly: CommandCodeWindow | null;
  /** Null when the plan id is not one this module knows a pool for. */
  monthly: CommandCodeWindow | null;
  /** The vendor's plan id, e.g. "individual-goat". */
  plan: string | null;
  /** Credits left in the monthly pool, as reported (null when absent). */
  monthlyRemaining: number | null;
  /** The monthly pool size the plan grants (null when the plan is unknown). */
  monthlyPool: number | null;
  at: number;
}

/**
 * Monthly credits per plan, transcribed from the CLI's own table. Longest key first when matching,
 * because `individual-go` is a prefix of nothing but `individual-go-v1` is a prefix of nothing;
 * the sort is what keeps `go-v1` from being read as `go`.
 */
export const PLAN_CREDITS: Readonly<Record<string, number>> = {
  "individual-go": 10,
  "individual-go-v1": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

const PLAN_KEYS = Object.keys(PLAN_CREDITS).sort((a, b) => b.length - a.length);

const API_BASE = "https://api.commandcode.ai";
const CREDITS_PATH = "/alpha/billing/credits";
const SUBSCRIPTION_PATH = "/alpha/billing/subscriptions";
const POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
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

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The endpoint sends epoch ms; an ISO string is accepted too, so a format change degrades to a
 *  missing reset time rather than to a parse failure that hides the percentages. */
function epochOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** The pool a plan id grants, or null — never a guessed number. */
export function planPool(planId: string | null): number | null {
  if (planId === null) return null;
  const norm = planId.trim().toLowerCase().replace(/_/g, "-");
  const hit = PLAN_KEYS.find((key) => norm.startsWith(key));
  return hit === undefined ? null : PLAN_CREDITS[hit] ?? null;
}

function windowFrom(raw: unknown): CommandCodeWindow | null {
  if (!isRecord(raw)) return null;
  const used = num(raw["used"]);
  const cap = num(raw["cap"]);
  if (used === null || cap === null) return null;
  return {
    used,
    cap,
    // A zero cap is "no window", not "100% used": the plan has no limit to be measured against.
    percentUsed: cap > 0 ? clampPct((used / cap) * 100) : 0,
    resetsAt: epochOf(raw["resetAt"]),
    exceeded: raw["exceeded"] === true,
  };
}

/**
 * PURE. Never throws on a partial or malformed pair of bodies; returns null when neither body is
 * usable. `credits` is the body of `/alpha/billing/credits`, `subscription` the body of
 * `/alpha/billing/subscriptions` (either may be absent).
 */
export function parseCommandCodeLimits(
  credits: unknown,
  subscription: unknown,
  at: number
): CommandCodeQuota | null {
  try {
    if (!isRecord(credits) && !isRecord(subscription)) return null;

    const planRaw = isRecord(subscription) && isRecord(subscription["data"]) ? subscription["data"]["planId"] : undefined;
    const plan = typeof planRaw === "string" && planRaw.length > 0 ? planRaw : null;

    const periodEnd =
      isRecord(subscription) && isRecord(subscription["data"])
        ? epochOf(subscription["data"]["currentPeriodEnd"])
        : null;

    let fiveHour: CommandCodeWindow | null = null;
    let weekly: CommandCodeWindow | null = null;
    let monthlyRemaining: number | null = null;

    if (isRecord(credits)) {
      const limits = credits["windowLimits"];
      if (isRecord(limits)) {
        fiveHour = windowFrom(limits["fiveHour"]);
        weekly = windowFrom(limits["weekly"]);
      }
      const wallet = credits["credits"];
      if (isRecord(wallet)) monthlyRemaining = num(wallet["monthlyCredits"]);
    }

    const monthlyPool = planPool(plan);
    let monthly: CommandCodeWindow | null = null;
    if (monthlyRemaining !== null && monthlyPool !== null && monthlyPool > 0) {
      const remaining = Math.max(0, monthlyRemaining);
      const used = Math.max(0, monthlyPool - remaining);
      monthly = {
        used,
        cap: monthlyPool,
        percentUsed: clampPct((used / monthlyPool) * 100),
        resetsAt: periodEnd,
        exceeded: used >= monthlyPool,
      };
    }

    if (fiveHour === null && weekly === null && monthly === null) return null;
    return { fiveHour, weekly, monthly, plan, monthlyRemaining, monthlyPool, at };
  } catch {
    return null;
  }
}

/** The key the CLI itself uses: the environment, else the box's Claude Code settings. */
function apiKey(): string | null {
  const fromEnv = process.env["COMMANDCODE_API_KEY"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  try {
    const path = join(process.env["HOME"] ?? homedir(), ".claude", "settings.json");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed["env"])) return null;
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) {
      const value = parsed["env"][key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // No key is "unavailable with a reason", not a crash.
  }
  return null;
}

function cachePath(): string {
  const override = process.env["LOOM_QUOTA_CACHE"];
  if (override !== undefined && override.length > 0) return `${override}.commandcode`;
  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "loom", "quota-commandcode.json");
}

export interface SharedCommandCode {
  at: number;
  credits: unknown;
  subscription: unknown;
}

export function readSharedCommandCode(): SharedCommandCode | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (!isRecord(raw)) return null;
    const at = num(raw["at"]);
    if (at === null) return null;
    return { at, credits: raw["credits"], subscription: raw["subscription"] };
  } catch {
    return null;
  }
}

function writeSharedCommandCode(reading: SharedCommandCode): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(reading));
    renameSync(tmp, path);
  } catch {
    // A shared cache is an optimisation, never a requirement.
  }
}

function claimPoll(): boolean {
  const lock = `${cachePath()}.lock`;
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
      // Someone else released it between the two calls; they are polling, we are not.
    }
    return false;
  }
}

function releasePoll(): void {
  try {
    unlinkSync(`${cachePath()}.lock`);
  } catch {
    // Already gone.
  }
}

type FetchResult = { ok: true; body: unknown } | { ok: false; error: string };

async function getJson(path: string, key: string): Promise<FetchResult> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `${path} answered HTTP ${String(res.status)}` };
    return { ok: true, body: (await res.json()) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : "fetch failed" };
  }
}

interface State {
  lastGood: CommandCodeQuota | null;
  stale: boolean;
  lastAttempt: number;
  inflight: Promise<void> | null;
  lastFailure: string | null;
}

const state: State = { lastGood: null, stale: false, lastAttempt: 0, inflight: null, lastFailure: null };

function failed(reason: string): void {
  state.stale = true;
  // Logged once per distinct reason, not once per poll: the badge going quiet with nothing in the
  // log is how a missing key spent a day looking like a broken panel (same lesson as usage.ts).
  if (state.lastFailure !== reason) console.log(`[loom] command code quota: ${reason}`);
  state.lastFailure = reason;
}

async function poll(now: number): Promise<void> {
  try {
    if (process.env["LOOM_QUOTA_FAIL"]) {
      failed("LOOM_QUOTA_FAIL is set");
      return;
    }

    const stubPath = process.env["LOOM_QUOTA_STUB_COMMANDCODE"];
    let credits: unknown;
    let subscription: unknown;
    let readingAt = now;

    if (stubPath !== undefined && stubPath.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await Bun.file(stubPath).text());
      } catch {
        failed(`stub at ${stubPath} did not parse`);
        return;
      }
      if (!isRecord(parsed)) {
        failed(`stub at ${stubPath} is not an object`);
        return;
      }
      credits = parsed["credits"];
      subscription = parsed["subscription"];
    } else {
      const shared = readSharedCommandCode();
      if (shared !== null && now - shared.at < pollGapMs()) {
        credits = shared.credits;
        subscription = shared.subscription;
        readingAt = shared.at;
      } else if (!claimPoll()) {
        if (shared === null) return;
        credits = shared.credits;
        subscription = shared.subscription;
        readingAt = shared.at;
      } else {
        try {
          const key = apiKey();
          if (key === null) {
            failed("no Command Code key (COMMANDCODE_API_KEY or ~/.claude/settings.json)");
            return;
          }
          const [creditsRes, subRes] = await Promise.all([getJson(CREDITS_PATH, key), getJson(SUBSCRIPTION_PATH, key)]);
          if (!creditsRes.ok) {
            failed(creditsRes.error);
            return;
          }
          credits = creditsRes.body;
          subscription = subRes.ok ? subRes.body : null;
          writeSharedCommandCode({ at: now, credits, subscription });
        } finally {
          releasePoll();
        }
      }
    }

    const quota = parseCommandCodeLimits(credits, subscription, readingAt);
    if (quota === null) {
      failed("budget response carried no recognizable limits");
      return;
    }
    state.lastGood = quota;
    state.stale = false;
    if (state.lastFailure !== null) console.log(`[loom] command code quota: reading again after ${state.lastFailure}`);
    state.lastFailure = null;
  } catch (err) {
    failed(err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
  }
}

export async function readCurrentCommandCodeQuota(
  now = Date.now()
): Promise<{ quota: CommandCodeQuota | null; stale: boolean; reason?: string | null }> {
  if (state.inflight !== null) await state.inflight;
  else if (now - state.lastAttempt >= pollGapMs()) {
    state.lastAttempt = now;
    state.inflight = poll(now).finally(() => {
      state.inflight = null;
    });
    await state.inflight;
  }
  return { quota: state.lastGood, stale: state.stale, reason: state.lastFailure };
}

export function resetCommandCodeQuotaState(): void {
  state.lastGood = null;
  state.stale = false;
  state.lastAttempt = 0;
  state.inflight = null;
  state.lastFailure = null;
}
