/**
 * Multi-provider budget aggregator — server/budgets.ts.
 *
 * Aggregates quota across all four BUDGET_IDS defined in server/models.ts:
 *   1. "anthropic"      — Anthropic OAuth 5-hour window from server/usage.ts
 *   2. "g1:gemini"       — Google AI Pro (google-account-1) Gemini models pool
 *   3. "g1:thirdparty"   — Google AI Pro (google-account-1) Claude & GPT models pool
 *   4. "jules"           — Jules daily session count against 200 ceiling
 *
 * ── PERCENT CONVENTION: PERCENT USED ─────────────────────────────────────────────────────
 * All budgets report percent USED (0..100):
 *   - 0%   = completely unused / 100% remaining
 *   - 100% = quota fully exhausted / 0% remaining
 * This matches Anthropic's utilization metric, Jules session consumption, and the height of
 * the micro-meter bars in the limits UI.
 *
 * ── FAULT ISOLATION ──────────────────────────────────────────────────────────────────────
 * Every provider is queried independently. Failure in one provider leaves all other budgets
 * fully readable and unaffected.
 */

import { BUDGET_IDS, PRIMARY_GOOGLE_ACCOUNT, type BudgetId } from "./models.ts";
import { readCurrentGoogleQuota, resetGoogleQuotaState, type GoogleAccount } from "./quota-google.ts";
import { readCurrentJulesQuota, resetJulesQuotaState } from "./quota-jules.ts";
import { readCurrentQuota, resetQuotaState } from "./usage.ts";

export type BudgetAvailability = "ok" | "stale" | "unavailable";

export interface BudgetWindowBreakdown {
  percent: number;
  resetsAt: number | null;
  severity?: "normal" | "warning" | "critical" | null;
}

export interface BudgetEntry {
  /** The budget id: "anthropic" | "g1:gemini" | "g1:thirdparty" | "jules" */
  id: BudgetId;
  /**
   * Percent USED (0..100).
   * Unified convention: all budgets report percent USED.
   */
  percent: number | null;
  /** Indicator of the convention used. */
  percentKind: "used";
  /** epoch ms when this budget window resets, or null if unknown / none. */
  resetsAt: number | null;
  /** Severity when provided by upstream provider (e.g. Anthropic). */
  severity?: "normal" | "warning" | "critical" | null;
  /** Absolute counts when available (e.g. Jules 25/200). */
  absolute: { used: number; limit: number } | null;
  /** Availability state: "ok" | "stale" | "unavailable". */
  status: BudgetAvailability;
  /** One-line explanation when status is not "ok". */
  reason: string | null;
  /** epoch ms when this reading was taken, or null if unavailable. */
  at: number | null;
  /** Five-hour window breakdown when available (e.g. Google pools). */
  fiveHour?: BudgetWindowBreakdown | null;
  /** Weekly window breakdown when available (e.g. Google pools). */
  weekly?: BudgetWindowBreakdown | null;
}

export interface BudgetsReport {
  budgets: Record<BudgetId, BudgetEntry>;
  list: BudgetEntry[];
  at: number;
}

function unavailableBudget(id: BudgetId, reason: string): BudgetEntry {
  return {
    id,
    percent: null,
    percentKind: "used",
    resetsAt: null,
    severity: null,
    absolute: null,
    status: "unavailable",
    reason,
    at: null,
    fiveHour: null,
    weekly: null,
  };
}

async function getAnthropicBudget(now: number): Promise<BudgetEntry> {
  try {
    const { quota, stale } = await readCurrentQuota(now);
    if (!quota) {
      return unavailableBudget("anthropic", stale ? "Anthropic usage endpoint failed" : "Anthropic quota not polled yet");
    }

    const fiveHour = quota.fiveHour;
    if (!fiveHour) {
      return unavailableBudget("anthropic", "No five-hour limit found in Anthropic usage response");
    }

    return {
      id: "anthropic",
      percent: fiveHour.percent,
      percentKind: "used",
      resetsAt: fiveHour.resetsAt,
      severity: fiveHour.severity,
      absolute: null,
      status: stale ? "stale" : "ok",
      reason: stale ? "Anthropic usage endpoint unreachable, showing last good reading" : null,
      at: quota.at,
      fiveHour: { percent: fiveHour.percent, resetsAt: fiveHour.resetsAt, severity: fiveHour.severity },
      weekly: quota.weekly ? { percent: quota.weekly.percent, resetsAt: quota.weekly.resetsAt, severity: quota.weekly.severity } : null,
    };
  } catch (err) {
    return unavailableBudget("anthropic", err instanceof Error ? err.message : "failed to read Anthropic quota");
  }
}

function resolveGooglePoolEntry(
  id: BudgetId,
  pool: { fiveHour: { percentUsed: number; resetsAt: number | null } | null; weekly: { percentUsed: number; resetsAt: number | null } | null } | null | undefined,
  stale: boolean,
  reason: string | null | undefined,
  at: number,
  missingMsg: string
): BudgetEntry {
  const fiveHour = pool?.fiveHour
    ? { percent: pool.fiveHour.percentUsed, resetsAt: pool.fiveHour.resetsAt }
    : null;
  const weekly = pool?.weekly
    ? { percent: pool.weekly.percentUsed, resetsAt: pool.weekly.resetsAt }
    : null;

  let winner: BudgetWindowBreakdown | null = null;
  if (fiveHour && weekly) {
    winner = fiveHour.percent >= weekly.percent ? fiveHour : weekly;
  } else {
    winner = fiveHour ?? weekly ?? null;
  }

  if (winner === null) {
    return unavailableBudget(id, missingMsg);
  }

  return {
    id,
    percent: winner.percent,
    percentKind: "used",
    resetsAt: winner.resetsAt,
    absolute: null,
    status: stale ? "stale" : "ok",
    reason: stale ? (reason ?? "Google /usage failed, showing last good reading") : null,
    at,
    fiveHour,
    weekly,
  };
}

async function getGoogleBudgets(
  accountKey: "g1" | "g2",
  account: GoogleAccount,
  now: number
): Promise<{ gemini: BudgetEntry; thirdparty: BudgetEntry }> {
  const geminiId = `${accountKey}:gemini` as BudgetId;
  const thirdpartyId = `${accountKey}:thirdparty` as BudgetId;

  try {
    const { quota, stale, reason } = await readCurrentGoogleQuota(account, now);
    if (!quota) {
      const defaultReason = reason ?? "Google quota unavailable";
      return {
        gemini: unavailableBudget(geminiId, defaultReason),
        thirdparty: unavailableBudget(thirdpartyId, defaultReason),
      };
    }

    const geminiEntry = resolveGooglePoolEntry(
      geminiId,
      quota.gemini,
      stale,
      reason,
      quota.at,
      "No Gemini limits in Google usage output"
    );

    const thirdpartyEntry = resolveGooglePoolEntry(
      thirdpartyId,
      quota.thirdparty,
      stale,
      reason,
      quota.at,
      "No Claude/GPT limits in Google usage output"
    );

    return { gemini: geminiEntry, thirdparty: thirdpartyEntry };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to read Google quota";
    return {
      gemini: unavailableBudget(geminiId, msg),
      thirdparty: unavailableBudget(thirdpartyId, msg),
    };
  }
}

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

async function getJulesBudget(now: number): Promise<BudgetEntry> {
  try {
    const [k1, k2] = await Promise.all([
      readCurrentJulesQuota(1, now),
      readCurrentJulesQuota(2, now),
    ]);

    if (!k1.quota && !k2.quota) {
      const reason =
        k1.reason && k2.reason
          ? `key 1: ${k1.reason}; key 2: ${k2.reason}`
          : (k1.reason ?? k2.reason ?? "Jules quota unavailable");
      return unavailableBudget("jules", reason);
    }

    if (k1.quota && k2.quota) {
      const used = k1.quota.used + k2.quota.used;
      const limit = k1.quota.ceiling + k2.quota.ceiling;
      const percent = clampPct((used / (limit > 0 ? limit : 200)) * 100);
      const stale = k1.stale || k2.stale;
      let reason: string | null = null;
      if (k1.stale && k2.stale) {
        reason =
          k1.reason && k2.reason
            ? `key 1: ${k1.reason}; key 2: ${k2.reason}`
            : (k1.reason ?? k2.reason ?? "Jules API unreachable, showing last good reading");
      } else if (k1.stale) {
        reason = k1.reason ?? "key 1 Jules API unreachable, showing last good reading";
      } else if (k2.stale) {
        reason = k2.reason ?? "key 2 Jules API unreachable, showing last good reading";
      }

      let resetsAt: number | null = null;
      if (k1.quota.resetsAt !== null && k2.quota.resetsAt !== null) {
        resetsAt = Math.min(k1.quota.resetsAt, k2.quota.resetsAt);
      } else {
        resetsAt = k1.quota.resetsAt ?? k2.quota.resetsAt;
      }

      return {
        id: "jules",
        percent,
        percentKind: "used",
        resetsAt,
        absolute: {
          used,
          limit,
        },
        status: stale ? "stale" : "ok",
        reason,
        at: Math.max(k1.quota.at, k2.quota.at),
      };
    }

    // Single-key success (fault isolation)
    if (k1.quota && !k2.quota) {
      const used = k1.quota.used;
      const limit = k1.quota.ceiling;
      const percent = clampPct((used / (limit > 0 ? limit : 100)) * 100);
      return {
        id: "jules",
        percent,
        percentKind: "used",
        resetsAt: k1.quota.resetsAt,
        absolute: {
          used,
          limit,
        },
        status: "stale",
        reason: k2.reason ? `key 2 unavailable (${k2.reason}), showing key 1 only` : "key 2 unavailable, showing key 1 only",
        at: k1.quota.at,
      };
    }

    const k2Quota = k2.quota!;
    const used = k2Quota.used;
    const limit = k2Quota.ceiling;
    const percent = clampPct((used / (limit > 0 ? limit : 100)) * 100);
    return {
      id: "jules",
      percent,
      percentKind: "used",
      resetsAt: k2Quota.resetsAt,
      absolute: {
        used,
        limit,
      },
      status: "stale",
      reason: k1.reason ? `key 1 unavailable (${k1.reason}), showing key 2 only` : "key 1 unavailable, showing key 2 only",
      at: k2Quota.at,
    };
  } catch (err) {
    return unavailableBudget("jules", err instanceof Error ? err.message : "failed to read Jules quota");
  }
}

/**
 * Aggregates all four provider budgets concurrently.
 * Guaranteed never to throw.
 */
export async function readCurrentBudgets(now = Date.now()): Promise<BudgetsReport> {
  const [anthropicRes, g1Res, julesRes] = await Promise.allSettled([
    getAnthropicBudget(now),
    getGoogleBudgets("g1", PRIMARY_GOOGLE_ACCOUNT, now),
    getJulesBudget(now),
  ]);

  const anthropic =
    anthropicRes.status === "fulfilled"
      ? anthropicRes.value
      : unavailableBudget("anthropic", "Anthropic reading rejected");

  const g1 =
    g1Res.status === "fulfilled"
      ? g1Res.value
      : {
          gemini: unavailableBudget("g1:gemini", "G1 reading rejected"),
          thirdparty: unavailableBudget("g1:thirdparty", "G1 reading rejected"),
        };

  const jules =
    julesRes.status === "fulfilled"
      ? julesRes.value
      : unavailableBudget("jules", "Jules reading rejected");

  const map: Record<BudgetId, BudgetEntry> = {
    anthropic,
    "g1:gemini": g1.gemini,
    "g1:thirdparty": g1.thirdparty,
    jules,
  };

  const list: BudgetEntry[] = BUDGET_IDS.map((id) => map[id]);

  return {
    budgets: map,
    list,
    at: now,
  };
}

/**
 * Test seam: resets state across all quota readers.
 */
export function resetBudgetsState(): void {
  resetQuotaState();
  resetGoogleQuotaState();
  resetJulesQuotaState();
}
