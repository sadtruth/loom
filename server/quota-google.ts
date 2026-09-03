/**
 * Google AI Pro quota reader — server/quota-google.ts.
 *
 * Reads quota limits for Google AI Pro subscriptions (Gemini models and third-party models)
 * via the Antigravity CLI's `/usage` slash command:
 *   /home/user/resilio/docs/Projects/other-models/gemini-for-cheap/agy.sh --model gemini-3.7-flash-high -p "/usage"
 *
 * ── PARSING SPECIFICATION ────────────────────────────────────────────────────────────────
 * Output format is tab-separated lines:
 *   Gemini Models\tWeekly Limit Remaining\t38%\t2026-09-06T09:42:54Z
 *   Gemini Models\tFive Hour Limit Remaining\t78%\t2026-09-01T17:48:30Z
 *   Claude and GPT models\tWeekly Limit Remaining\t74%\t2026-09-06T10:19:25Z
 *   Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-01T20:38:38Z
 *
 * Each line reports percent REMAINING (not spent). The parser converts this into percent USED
 * (100 - percentRemaining) so that the limits bar draws a consistent metric across all providers.
 *
 * ── NEVER THROWS AND NEVER BLOCKS ────────────────────────────────────────────────────────
 * Modelled on server/usage.ts:
 * 1. A failed or slow reading degrades to the last good one with stale: true.
 * 2. Subprocess execution is capped with a timeout (15s).
 * 3. Machine-wide caching and single-flight polling lock prevents redundant subprocess spawns.
 * 4. Polling gap is at least 60 seconds (configurable via LOOM_QUOTA_POLL_MS).
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { GoogleAccount, GooglePool } from "./models.ts";

export type { GoogleAccount, GooglePool };

export interface GoogleWindow {
  /** Percent remaining reported by CLI (0..100). */
  percentRemaining: number;
  /** Percent used (100 - percentRemaining), clamped to 0..100. */
  percentUsed: number;
  /** epoch ms when this window resets, or null if unstated. */
  resetsAt: number | null;
}

export interface GooglePoolQuota {
  fiveHour: GoogleWindow | null;
  weekly: GoogleWindow | null;
}

export interface GoogleQuota {
  gemini: GooglePoolQuota | null;
  thirdparty: GooglePoolQuota | null;
  /** epoch ms when this reading was taken. */
  at: number;
}

export const AGY_LAUNCHER = "/home/user/resilio/docs/Projects/other-models/gemini-for-cheap/agy.sh";
const POLL_MS = 60_000;
const SUBPROCESS_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

function pollGapMs(): number {
  const raw = Number(process.env["LOOM_QUOTA_POLL_MS"] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : POLL_MS;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function parseIso(v: string | undefined): number | null {
  if (!v || v.trim().length === 0) return null;
  const ms = Date.parse(v.trim());
  return Number.isNaN(ms) ? null : ms;
}

function matchPool(raw: string): GooglePool | null {
  const norm = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm === "geminimodels" || norm === "gemini") return "gemini";
  if (
    norm === "claudeandgptmodels" ||
    norm === "claudeandgpt" ||
    norm === "thirdparty" ||
    norm === "thirdpartymodels"
  ) {
    return "thirdparty";
  }
  return null;
}

function matchWindow(raw: string): "fiveHour" | "weekly" | null {
  const norm = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm.includes("fivehour") || norm.includes("5hour")) return "fiveHour";
  if (norm.includes("weekly") || norm.includes("7day") || norm.includes("sevenday")) return "weekly";
  return null;
}

/**
 * PURE parser. Never throws on malformed or partial output.
 * Splits on tabs, matches pool and window by name, and ignores unknown lines.
 */
export function parseGoogleUsage(raw: string, at: number): GoogleQuota | null {
  try {
    if (typeof raw !== "string" || raw.trim().length === 0) return null;

    let geminiFiveHour: GoogleWindow | null = null;
    let geminiWeekly: GoogleWindow | null = null;
    let thirdpartyFiveHour: GoogleWindow | null = null;
    let thirdpartyWeekly: GoogleWindow | null = null;

    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Quota:")) continue;

      // Primary parsing: split on tabs
      let parts = line.split(/\t+/).map((p) => p.trim()).filter((s) => s.length > 0);
      if (parts.length < 3) {
        // Fallback: split on 2 or more whitespace characters if tabs were replaced
        parts = line.split(/\s{2,}/).map((p) => p.trim()).filter((s) => s.length > 0);
      }
      if (parts.length < 3) continue;

      const poolStr = parts[0];
      const winStr = parts[1];
      const pctStr = parts[2];
      const resetStr = parts[3];

      if (!poolStr || !winStr || !pctStr) continue;

      const pool = matchPool(poolStr);
      const win = matchWindow(winStr);
      if (!pool || !win) continue;

      const numericStr = pctStr.replace("%", "").trim();
      const pctNum = Number(numericStr);
      if (!Number.isFinite(pctNum)) continue;

      const percentRemaining = clampPct(pctNum);
      const percentUsed = clampPct(100 - percentRemaining);
      const resetsAt = parseIso(resetStr);

      const winObj: GoogleWindow = { percentRemaining, percentUsed, resetsAt };

      if (pool === "gemini") {
        if (win === "fiveHour") geminiFiveHour ??= winObj;
        else if (win === "weekly") geminiWeekly ??= winObj;
      } else if (pool === "thirdparty") {
        if (win === "fiveHour") thirdpartyFiveHour ??= winObj;
        else if (win === "weekly") thirdpartyWeekly ??= winObj;
      }
    }

    const hasGemini = geminiFiveHour !== null || geminiWeekly !== null;
    const hasThirdparty = thirdpartyFiveHour !== null || thirdpartyWeekly !== null;

    if (!hasGemini && !hasThirdparty) return null;

    return {
      gemini: hasGemini ? { fiveHour: geminiFiveHour, weekly: geminiWeekly } : null,
      thirdparty: hasThirdparty ? { fiveHour: thirdpartyFiveHour, weekly: thirdpartyWeekly } : null,
      at,
    };
  } catch {
    return null;
  }
}

function cachePath(account: GoogleAccount): string {
  const override = process.env["LOOM_QUOTA_CACHE_GOOGLE"] ?? process.env["LOOM_QUOTA_CACHE"];
  if (override !== undefined && override.length > 0) return `${override}.${account}`;
  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "loom", `quota-google-${account}.json`);
}

export interface SharedGoogleReading {
  at: number;
  raw: string;
}

export function readSharedGoogle(account: GoogleAccount): SharedGoogleReading | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath(account), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const at = (raw as { at?: unknown }).at;
    const text = (raw as { raw?: unknown }).raw;
    if (typeof at !== "number" || typeof text !== "string") return null;
    return { at, raw: text };
  } catch {
    return null;
  }
}

export function writeSharedGoogle(account: GoogleAccount, reading: SharedGoogleReading): void {
  try {
    const path = cachePath(account);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(reading));
    renameSync(tmp, path);
  } catch {
    // Non-fatal cache write failure
  }
}

export function claimGooglePoll(account: GoogleAccount): boolean {
  const lock = `${cachePath(account)}.lock`;
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

export function releaseGooglePoll(account: GoogleAccount): void {
  try {
    unlinkSync(`${cachePath(account)}.lock`);
  } catch {
    // Already gone
  }
}

interface AccountState {
  lastGood: GoogleQuota | null;
  stale: boolean;
  lastAttempt: number;
  inflight: Promise<void> | null;
  lastFailure: string | null;
}

const accountStates = new Map<GoogleAccount, AccountState>([
  ["google-account-1", { lastGood: null, stale: false, lastAttempt: 0, inflight: null, lastFailure: null }],
]);

function getState(account: GoogleAccount): AccountState {
  let s = accountStates.get(account);
  if (!s) {
    s = { lastGood: null, stale: false, lastAttempt: 0, inflight: null, lastFailure: null };
    accountStates.set(account, s);
  }
  return s;
}

async function runUsageCli(account: GoogleAccount): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const profile = (account as string) !== "google-account-1" ? (account as string) : undefined;
    const proc = Bun.spawn([AGY_LAUNCHER, "--model", "gemini-3.7-flash-high", "-p", "/usage"], {
      ...(profile ? { env: { ...process.env, AGY_PROFILE: profile } } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = new Promise<{ ok: false; error: string }>((resolve) =>
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Process may have already exited
        }
        resolve({ ok: false, error: `CLI timeout after ${SUBPROCESS_TIMEOUT_MS}ms` });
      }, SUBPROCESS_TIMEOUT_MS)
    );

    const execPromise = (async () => {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (exitCode !== 0) {
        return { ok: false as const, error: `CLI exited ${exitCode}: ${stderr.trim() || stdout.trim() || "no output"}` };
      }
      return { ok: true as const, stdout };
    })();

    return await Promise.race([execPromise, timeout]);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : "spawn failed" };
  }
}

async function pollAccount(account: GoogleAccount, now: number): Promise<void> {
  const state = getState(account);
  try {
    if (process.env["LOOM_QUOTA_FAIL"]) {
      state.stale = true;
      state.lastFailure = "LOOM_QUOTA_FAIL is set";
      return;
    }

    const stubPath =
      process.env[`LOOM_QUOTA_STUB_GOOGLE_${account.toUpperCase()}`] ??
      ((account as string) === "google-account-1" ? process.env["LOOM_QUOTA_STUB_G1"] : process.env["LOOM_QUOTA_STUB_G2"]) ??
      process.env["LOOM_QUOTA_STUB_GOOGLE"] ??
      process.env["LOOM_QUOTA_STUB"];

    let rawText: string;
    let readingAt = now;

    if (stubPath !== undefined && stubPath.length > 0) {
      try {
        const fileContent = await Bun.file(stubPath).text();
        try {
          const parsed = JSON.parse(fileContent) as unknown;
          if (typeof parsed === "object" && parsed !== null && "google" in parsed) {
            rawText = String((parsed as { google: unknown }).google);
          } else if (typeof parsed === "string") {
            rawText = parsed;
          } else {
            rawText = fileContent;
          }
        } catch {
          rawText = fileContent;
        }
      } catch {
        state.stale = true;
        state.lastFailure = `stub at ${stubPath} could not be read`;
        return;
      }
    } else {
      const shared = readSharedGoogle(account);
      if (shared !== null && now - shared.at < pollGapMs()) {
        rawText = shared.raw;
        readingAt = shared.at;
      } else if (!claimGooglePoll(account)) {
        if (shared !== null) {
          rawText = shared.raw;
          readingAt = shared.at;
        } else {
          return;
        }
      } else {
        try {
          const res = await runUsageCli(account);
          if (!res.ok) {
            state.stale = true;
            state.lastFailure = res.error;
            return;
          }
          rawText = res.stdout;
          writeSharedGoogle(account, { at: now, raw: rawText });
        } finally {
          releaseGooglePoll(account);
        }
      }
    }

    const quota = parseGoogleUsage(rawText, readingAt);
    if (quota === null) {
      state.stale = true;
      state.lastFailure = "output carried no recognized quota limits";
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

export async function readCurrentGoogleQuota(
  account: GoogleAccount = "google-account-1",
  now = Date.now()
): Promise<{ quota: GoogleQuota | null; stale: boolean; reason?: string | null }> {
  const state = getState(account);
  if (state.inflight !== null) {
    await state.inflight;
  } else if (now - state.lastAttempt >= pollGapMs()) {
    state.lastAttempt = now;
    state.inflight = pollAccount(account, now).finally(() => {
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

export function resetGoogleQuotaState(): void {
  for (const s of accountStates.values()) {
    s.lastGood = null;
    s.stale = false;
    s.lastAttempt = 0;
    s.inflight = null;
    s.lastFailure = null;
  }
}
