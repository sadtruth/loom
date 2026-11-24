/**
 * Multi-provider budget aggregator — server/budgets.ts.
 *
 * Aggregates quota across the three pools the limits panel draws (BUDGET_IDS in server/models.ts):
 *   1. "commandcode"   — the Command Code subscription: monthly credits, 5-hour and weekly windows
 *   2. "g1:gemini"     — Google AI Pro (google-account-1) Gemini models pool
 *   3. "g1:thirdparty" — Google AI Pro (google-account-1) Claude & GPT models pool
 *
 * Anthropic's own OAuth window and Jules' daily task count left this list on 2026-11-24: the box
 * runs on Command Code, and Jules is winding down (User: *"you can remove jules budget checking
 * since jules is winding down. You can also remove claude group anthropic models checking."*).
 * `server/usage.ts` still polls Anthropic for the legacy `/api/bar` reading, which is a different
 * surface and untouched here.
 *
 * ── PERCENT CONVENTION: PERCENT USED ─────────────────────────────────────────────────────
 * All budgets report percent USED (0..100):
 *   - 0%   = completely unused / 100% remaining
 *   - 100% = quota fully exhausted / 0% remaining
 * This matches Command Code's computed utilization, Jules' retired session consumption and the
 * height of the micro-meter bars in the limits UI.
 *
 * ── FAULT ISOLATION ──────────────────────────────────────────────────────────────────────
 * Every provider is queried independently. Failure in one provider leaves all other budgets
 * fully readable and unaffected.
 */

import { BUDGET_IDS, PRIMARY_GOOGLE_ACCOUNT, type BudgetId } from "./models.ts";
import { readCurrentCommandCodeQuota, resetCommandCodeQuotaState } from "./quota-commandcode.ts";
import { readCurrentGoogleQuota, resetGoogleQuotaState, type GoogleAccount } from "./quota-google.ts";

export type BudgetAvailability = "ok" | "stale" | "unavailable";

export interface BudgetWindowBreakdown {
  percent: number;
  resetsAt: number | null;
  severity?: "normal" | "warning" | "critical" | null;
}

export interface BudgetEntry {
  /** The budget id: "commandcode" | "g1:gemini" | "g1:thirdparty" */
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
  /** Absolute counts when available. */
  absolute: { used: number; limit: number } | null;
  /** Availability state: "ok" | "stale" | "unavailable". */
  status: BudgetAvailability;
  /** One-line explanation when status is not "ok". */
  reason: string | null;
  /** epoch ms when this reading was taken, or null if unavailable. */
  at: number | null;
  /** Five-hour window breakdown when available (Command Code, Google pools). */
  fiveHour?: BudgetWindowBreakdown | null;
  /** Weekly window breakdown when available (Command Code, Google pools). */
  weekly?: BudgetWindowBreakdown | null;
  /** Monthly window breakdown when available (Command Code only). */
  monthly?: BudgetWindowBreakdown | null;
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
    monthly: null,
  };
}

function windowOf(w: { percentUsed: number; resetsAt: number | null } | null): BudgetWindowBreakdown | null {
  return w === null ? null : { percent: w.percentUsed, resetsAt: w.resetsAt };
}

/**
 * Command Code's headline is the window that binds first — the largest percent used of the three.
 * Anthropic's entry used to report its 5-hour window alone and the panel then had to explain a
 * weekly limit that actually ran out; the worst window needs no explaining.
 */
async function getCommandCodeBudget(now: number): Promise<BudgetEntry> {
  try {
    const { quota, stale, reason } = await readCurrentCommandCodeQuota(now);
    if (!quota) {
      return unavailableBudget("commandcode", reason ?? "Command Code quota unavailable");
    }

    const fiveHour = windowOf(quota.fiveHour);
    const weekly = windowOf(quota.weekly);
    const monthly = windowOf(quota.monthly);
    const windows = [fiveHour, weekly, monthly].filter((w): w is BudgetWindowBreakdown => w !== null);
    if (windows.length === 0) {
      return unavailableBudget("commandcode", "No recognized windows in the Command Code response");
    }

    let winner = windows[0] as BudgetWindowBreakdown;
    for (const w of windows) if (w.percent > winner.percent) winner = w;

    return {
      id: "commandcode",
      percent: winner.percent,
      percentKind: "used",
      resetsAt: winner.resetsAt,
      severity: null,
      absolute: null,
      status: stale ? "stale" : "ok",
      reason: stale ? (reason ?? "Command Code endpoint unreachable, showing last good reading") : null,
      at: quota.at,
      fiveHour,
      weekly,
      monthly,
    };
  } catch (err) {
    return unavailableBudget("commandcode", err instanceof Error ? err.message : "failed to read Command Code quota");
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
  const fiveHour = windowOf(pool?.fiveHour ?? null);
  const weekly = windowOf(pool?.weekly ?? null);

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
    monthly: null,
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

/**
 * Aggregates all provider budgets concurrently.
 * Guaranteed never to throw.
 */
export async function readCurrentBudgets(now = Date.now()): Promise<BudgetsReport> {
  const [commandCodeRes, g1Res] = await Promise.allSettled([
    getCommandCodeBudget(now),
    getGoogleBudgets("g1", PRIMARY_GOOGLE_ACCOUNT, now),
  ]);

  const commandCode =
    commandCodeRes.status === "fulfilled"
      ? commandCodeRes.value
      : unavailableBudget("commandcode", "Command Code reading rejected");

  const g1 =
    g1Res.status === "fulfilled"
      ? g1Res.value
      : {
          gemini: unavailableBudget("g1:gemini", "G1 reading rejected"),
          thirdparty: unavailableBudget("g1:thirdparty", "G1 reading rejected"),
        };

  const map: Record<BudgetId, BudgetEntry> = {
    commandcode: commandCode,
    "g1:gemini": g1.gemini,
    "g1:thirdparty": g1.thirdparty,
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
  resetCommandCodeQuotaState();
  resetGoogleQuotaState();
}
