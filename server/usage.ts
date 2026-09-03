/**
 * The account's REAL quota — server/usage.ts.
 *
 * `server/block.ts` prices tokens with weights fitted to four 429 events, against a limit it had
 * to invent. This module replaces the number, not the guess: it calls the same endpoint the CLI's
 * own `/usage` reads, `https://api.anthropic.com/api/oauth/usage`, and reports exactly what the
 * account was told. Verified live 2026-08-26 — response recorded in `usage-bar/project.md`.
 *
 * ── TWO SHAPES, BOTH UNDOCUMENTED ─────────────────────────────────────────────────────────
 *
 * The body carries a `limits` array (`kind: "session" | "weekly_all" | "weekly_scoped"`, each
 * with its own `percent`/`severity`/`resets_at`) AND flat `five_hour`/`seven_day` objects
 * (`utilization`/`resets_at`, no severity). Both are present in the one real response seen so
 * far, and neither is documented anywhere public, so `readQuota` prefers `limits` — it already
 * carries severity, so the badge does not have to re-derive thresholds — and falls back to the
 * flat objects only for whatever `limits` does not cover.
 *
 * ── THE TOKEN ─────────────────────────────────────────────────────────────────────────────
 *
 * Read from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` on every poll, not
 * cached for the process lifetime: `expiresAt` in that file is hours out and the CLI refreshes
 * it underneath us. A 401 triggers exactly one re-read-and-retry, not a cache invalidation
 * scheme — the file is cheap to read and the CLI, not this module, owns the refresh.
 *
 * ── NEVER THROWS ──────────────────────────────────────────────────────────────────────────
 *
 * A missing credentials file, an unreachable host, a 401 that survives the retry, a body that
 * doesn't parse — every one of these degrades to `stale: true` and the last GOOD reading, never
 * to an exception and never to the fitted estimate. A wrong number presented as current is the
 * defect this build exists to remove; a crash would be worse.
 *
 * ── STUBBED FOR THE PINS ──────────────────────────────────────────────────────────────────
 *
 * `LOOM_QUOTA_STUB=<path>` reads the body from that file instead of fetching — no credentials
 * read, no network — and `LOOM_QUOTA_FAIL=1` behaves exactly as a failed fetch, so the
 * degrade-honestly scenario can be driven from a pin. Same pattern as `LOOM_BAR_ARCHIVE` in
 * `bar.ts`. Both are read PER POLL, not captured at module load, so a pin can flip them between
 * runs of the same process.
 */

import { mkdirSync, openSync, closeSync, unlinkSync, statSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Severity = "normal" | "warning" | "critical";

export interface QuotaWindow {
  /** 0..100. */
  percent: number;
  /** epoch ms; null when the endpoint gave no reset time. */
  resetsAt: number | null;
  severity: Severity;
}

export interface ScopedWindow {
  /** e.g. "Fable" — from limits[].scope.model.display_name. */
  label: string;
  percent: number;
  resetsAt: number | null;
}

export interface Quota {
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  scoped: ScopedWindow[];
  /** epoch ms this reading was taken. */
  at: number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Observed via `claude --version` on this box, 2026-08-26. Not load-bearing on the endpoint
 *  accepting it — the account's own CLI sends the same shape — only on being honest about who
 *  is asking. */
const USER_AGENT = "claude-cli/2.1.234 (external, cli)";
/** Poll at most this often; a chatty client must not turn the badge into a fetch loop. */
const POLL_MS = 60_000;
/** How often a poll is allowed. `LOOM_QUOTA_POLL_MS` exists for the pins: a spec that swaps the
 *  stub file to drive the warning/critical/stale states cannot wait a real minute per step, and
 *  read PER CALL for the same reason the stub paths are — one test process, several states. */
function pollGapMs(): number {
  const raw = Number(process.env["LOOM_QUOTA_POLL_MS"] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : POLL_MS;
}

function credentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

function epochOf(v: unknown): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

const SEVERITIES: readonly Severity[] = ["normal", "warning", "critical"];
function severityOf(v: unknown): Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "normal";
}

/** A `limits[]` entry already carrying `percent`/`severity`/`resets_at` — the friendlier shape. */
function windowFromLimit(entry: Record<string, unknown>): QuotaWindow | null {
  const percent = num(entry["percent"]);
  if (percent === null) return null;
  return { percent: clampPct(percent), resetsAt: epochOf(entry["resets_at"]), severity: severityOf(entry["severity"]) };
}

/** The flat `five_hour`/`seven_day` object — `utilization` instead of `percent`, no severity. */
function windowFromFlat(entry: unknown): QuotaWindow | null {
  if (!isRecord(entry)) return null;
  const percent = num(entry["utilization"]);
  if (percent === null) return null;
  return { percent: clampPct(percent), resetsAt: epochOf(entry["resets_at"]), severity: "normal" };
}

function scopedFrom(entry: Record<string, unknown>): ScopedWindow | null {
  const percent = num(entry["percent"]);
  if (percent === null) return null;
  const scope = entry["scope"];
  const model = isRecord(scope) ? scope["model"] : undefined;
  const label = isRecord(model) && typeof model["display_name"] === "string" ? model["display_name"] : "?";
  return { label, percent: clampPct(percent), resetsAt: epochOf(entry["resets_at"]) };
}

/**
 * PURE. Never throws on a malformed or partial body; returns null when nothing is usable.
 * Prefers `limits[]` — `kind: "session"` for the five-hour window, `"weekly_all"` for the weekly
 * one, `"weekly_scoped"` rows become `scoped` — and falls back to the flat `five_hour`/
 * `seven_day` objects only where `limits` did not resolve a window. On disagreement between the
 * two shapes, `limits` wins outright: the fallback is never consulted once `limits` has spoken
 * for a window, even if what it found looks stranger than the flat number.
 */
export function readQuota(body: unknown, at: number): Quota | null {
  try {
    if (!isRecord(body)) return null;

    let fiveHour: QuotaWindow | null = null;
    let weekly: QuotaWindow | null = null;
    const scoped: ScopedWindow[] = [];

    const limits = body["limits"];
    if (Array.isArray(limits)) {
      for (const raw of limits) {
        if (!isRecord(raw)) continue;
        const kind = raw["kind"];
        if (kind === "session") fiveHour ??= windowFromLimit(raw);
        else if (kind === "weekly_all") weekly ??= windowFromLimit(raw);
        else if (kind === "weekly_scoped") {
          const s = scopedFrom(raw);
          if (s !== null) scoped.push(s);
        }
      }
    }

    if (fiveHour === null) fiveHour = windowFromFlat(body["five_hour"]);
    if (weekly === null) weekly = windowFromFlat(body["seven_day"]);

    if (fiveHour === null && weekly === null && scoped.length === 0) return null;
    return { fiveHour, weekly, scoped, at };
  } catch {
    return null;
  }
}

async function readTokenFromFile(): Promise<string | null> {
  try {
    const text = await Bun.file(credentialsPath()).text();
    const data = JSON.parse(text) as unknown;
    if (!isRecord(data)) return null;
    const oauth = data["claudeAiOauth"];
    if (!isRecord(oauth)) return null;
    const token = oauth["accessToken"];
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

type FetchResult =
  | { ok: true; body: unknown }
  /** `retryAfterMs` is the endpoint's own `Retry-After`, when it sent one. */
  | { ok: false; status: number; retryAfterMs: number | null };

async function fetchOnce(token: string): Promise<FetchResult> {
  const res = await fetch(USAGE_URL, {
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const after = Number(res.headers.get("retry-after") ?? "");
    return { ok: false, status: res.status, retryAfterMs: Number.isFinite(after) && after > 0 ? after * 1000 : null };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, status: res.status, retryAfterMs: null };
  }
}

/**
 * ONE poll per machine, however many server processes are running.
 *
 * Development runs a loom SERVER per branch worktree — eight processes on this machine the day
 * this was written, on ports 4173 and 4303-4350 — and each polled `/api/oauth/usage` on its own
 * 60-second timer against the same account. The endpoint rate-limits, so the badge flickered
 * between a good reading and none at all: `HTTP 429 ... reading again after HTTP 429`, over and
 * over. User, 2026-08-29: *"there should be just one poll every 60s"*.
 *
 * So the reading lives in one file every server process on the machine shares. A poll is due only
 * when THAT file is older than the gap, and the process that finds it due takes an exclusive lock
 * (`wx`, which fails rather than truncates if another holds it) before going to the network.
 * Whoever loses the race simply reads what the winner wrote a moment later. The file is written
 * temp-then-rename, so a reader never sees half a body.
 *
 * A pin gets its own path through `LOOM_QUOTA_CACHE`, and `LOOM_QUOTA_STUB` skips the whole
 * mechanism — a fixture archive must not share state with the live one.
 */
function cachePath(): string {
  const override = process.env["LOOM_QUOTA_CACHE"];
  if (override !== undefined && override.length > 0) return override;
  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "loom", "quota.json");
}

/** A lock older than this was left by a loom that died mid-poll; ignore it. */
const LOCK_STALE_MS = 30_000;

export interface SharedReading {
  /** ms epoch the body was fetched. */
  at: number;
  /** The endpoint's body, exactly as it answered — parsed by `readQuota` like any other. */
  body: unknown;
}

export function readShared(): SharedReading | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const at = (raw as { at?: unknown }).at;
    if (typeof at !== "number") return null;
    return { at, body: (raw as { body?: unknown }).body };
  } catch {
    return null;
  }
}

export function writeShared(reading: SharedReading): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(reading));
    renameSync(tmp, path);
  } catch {
    // A machine-shared cache is an optimisation, never a requirement: if it cannot be written,
    // this process simply polls on its own timer as it did before.
  }
}

/** Take the machine-wide poll lock, or report that another loom holds it. */
export function claimPoll(): boolean {
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
      // Someone else cleared it between our two calls; they are polling, we are not.
    }
    return false;
  }
}

export function releasePoll(): void {
  try {
    unlinkSync(`${cachePath()}.lock`);
  } catch {
    // Already gone.
  }
}

let lastGood: Quota | null = null;
let stale = false;
let lastAttempt = 0;
/** Guards against two overlapping polls; a second caller during a poll reads its result. */
let inflight: Promise<void> | null = null;
/**
 * How long to wait before the next attempt, when the endpoint has asked us to slow down.
 *
 * The account rate-limits this endpoint, and more than one loom server runs here — a worktree per
 * branch, each polling every 60 seconds against the same quota. The result was a badge that
 * flickered between a good reading and no reading, with nothing on screen saying why (2026-08-29,
 * found the moment `failed()` started logging: a run of `HTTP 429 ... reading again after HTTP
 * 429`). A 429 answered by another attempt 60 seconds later is not a retry, it is the same
 * mistake on a timer; this doubles the gap on each one, up to ten minutes, and drops it the moment
 * a read succeeds. The endpoint's own `Retry-After` wins when it sends one.
 */
let backoffMs = 0;
const BACKOFF_CEILING_MS = 10 * 60_000;

/**
 * Why the last poll failed, so a missing percentage can be diagnosed from the log instead of
 * guessed at. Every failure path used to return silently — the badge said nothing and so did the
 * server, and the only way to learn that the token had expired was to call the endpoint by hand
 * (2026-08-29).
 */
let lastFailure: string | null = null;

function failed(reason: string): void {
  stale = true;
  if (lastFailure !== reason) {
    lastFailure = reason;
    console.log(`[loom] usage endpoint: ${reason} — showing the last good reading, if any`);
  }
}

async function poll(now: number): Promise<void> {
  try {
    // Checked PER POLL, never cached at module load — a pin flips these between runs of the
    // same long-lived test process.
    if (process.env["LOOM_QUOTA_FAIL"]) {
      failed("LOOM_QUOTA_FAIL is set");
      return;
    }
    const stubPath = process.env["LOOM_QUOTA_STUB"];
    let body: unknown;
    let readingAt = now;
    if (stubPath !== undefined && stubPath.length > 0) {
      try {
        body = JSON.parse(await Bun.file(stubPath).text());
      } catch {
        failed(`stub at ${stubPath} did not parse`);
        return;
      }
    } else {
      // Someone on this machine may have read it already; the network is the last resort, not the
      // first move.
      const shared = readShared();
      if (shared !== null && now - shared.at < pollGapMs()) {
        body = shared.body;
        readingAt = shared.at;
      } else if (!claimPoll()) {
        // Another server process is on the wire right now. Its answer lands in the shared file within the
        // second; until it does, whatever we already have stands.
        if (shared !== null) {
          body = shared.body;
          readingAt = shared.at;
        } else return;
      } else {
        try {
          let token = await readTokenFromFile();
          if (token === null) {
            failed(`no accessToken in ${credentialsPath()}`);
            return;
          }
          let res = await fetchOnce(token);
          if (!res.ok && (res.status === 401 || res.status === 403)) {
            // The CLI refreshes the file underneath us; one re-read-and-retry, not a cache.
            token = await readTokenFromFile();
            res = token !== null ? await fetchOnce(token) : { ok: false, status: res.status, retryAfterMs: null };
          }
          if (!res.ok) {
            if (res.status === 429 || res.status >= 500) {
              const asked = res.retryAfterMs;
              backoffMs = asked ?? Math.min(Math.max(backoffMs * 2, pollGapMs() * 2), BACKOFF_CEILING_MS);
            }
            failed(`HTTP ${String(res.status)}`);
            return;
          }
          body = res.body;
          writeShared({ at: now, body });
        } finally {
          releasePoll();
        }
      }
    }
    const quota = readQuota(body, readingAt);
    if (quota === null) {
      failed("response carried no limits this module understands");
      return;
    }
    lastGood = quota;
    stale = false;
    backoffMs = 0;
    if (lastFailure !== null) {
      console.log(`[loom] usage endpoint: reading again after ${lastFailure}`);
      lastFailure = null;
    }
  } catch (err) {
    // Never throw out of the module: a network error, a torn body, anything unforeseen is
    // "stale", not a crash. It IS logged, though — silence is what made this undiagnosable.
    failed(err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
  }
}

/**
 * The last GOOD reading, polled at most once every `POLL_MS`. `stale` is true when the most
 * recent attempt failed — `quota` is then the last good reading, not a current one, and the
 * caller (`bar.ts`) must show it as such rather than silently keep drawing it as live.
 */
export async function readCurrentQuota(now = Date.now()): Promise<{ quota: Quota | null; stale: boolean }> {
  if (inflight !== null) await inflight;
  else if (now - lastAttempt >= Math.max(pollGapMs(), backoffMs)) {
    lastAttempt = now;
    inflight = poll(now).finally(() => {
      inflight = null;
    });
    await inflight;
  }
  return { quota: lastGood, stale };
}

/** Test seam: drop the polled state so a spec can point LOOM_QUOTA_STUB/FAIL at a fresh case. */
export function resetQuotaState(): void {
  lastGood = null;
  stale = false;
  lastAttempt = 0;
  inflight = null;
}
