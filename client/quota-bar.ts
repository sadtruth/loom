/**
 * Usage bar, cache bar, tooltip formatting, and duration formatters.
 */

import { el } from "./render.ts";
import { CACHE_LOW, cacheFraction, cacheTooltip, type CacheWindow } from "./rowicon.ts";
import { state, ui } from "./store.ts";
import type { BarReading, CacheState, Quota } from "./types.ts";

/** The width of the bar's track, in the icon's own 14px slot — the fill is a fraction of this. */
export const CACHE_BAR_PX = 13;

/**
 * Paint the hour under an icon, from the only two numbers the client already has (SPEC 258).
 *
 * Returns what the tooltip should say about it, or the empty string when nothing is drawn — and
 * when nothing is drawn, neither fill nor TRACK is left behind, so a cold row is exactly the row it
 * was before this feature existed. Used both when the icon is built and by the tick, so a row that
 * has been on screen for forty minutes is drawn exactly like one that just appeared.
 */
export function drawCacheBar(dot: HTMLElement, win: CacheWindow | null, now: number): string {
  const frac = cacheFraction(win, now);
  if (frac <= 0 || win === null) {
    dot.querySelector(".cache-track")?.remove();
    dot.querySelector(".cache-fill")?.remove();
    delete dot.dataset["cacheAt"];
    delete dot.dataset["cacheTtl"];
    return "";
  }
  // The two numbers ride ON the node, so the tick needs no map of its own and stays correct across
  // a redraw that replaced every row (SPEC 262).
  dot.dataset["cacheAt"] = String(win.at);
  dot.dataset["cacheTtl"] = String(win.ttlMs);
  let track = dot.querySelector<HTMLElement>(".cache-track");
  if (track === null) {
    track = document.createElement("i");
    track.className = "cache-track";
    dot.append(track);
  }
  let fill = dot.querySelector<HTMLElement>(".cache-fill");
  if (fill === null) {
    fill = document.createElement("i");
    fill.className = "cache-fill";
    dot.append(fill);
  }
  // A floor of 1.4px: the last minutes of an hour are under a pixel wide, and a bar that thins to
  // nothing before it is spent would say "cold" while the window is still warm.
  fill.style.width = `${Math.max(1.4, CACHE_BAR_PX * frac).toFixed(2)}px`;
  fill.classList.toggle("low", frac < CACHE_LOW);
  return cacheTooltip(win, now) ?? "";
}

/**
 * The hour empties client-side, from the two numbers the row is already carrying — no request
 * between ticks, which is the record's own test of whether this feature is honest. Walks the live
 * DOM rather than a map of nodes, so it is right whether or not a redraw has happened since.
 */
export function tickCacheBars(): void {
  const now = Date.now();
  for (const dot of document.querySelectorAll<HTMLElement>(".tree-dot[data-cache-at]")) {
    const at = Number(dot.dataset["cacheAt"]);
    const ttlMs = Number(dot.dataset["cacheTtl"]);
    const win = Number.isFinite(at) && Number.isFinite(ttlMs) ? { at, ttlMs } : null;
    const told = drawCacheBar(dot, win, now);
    // Rewrite only the cache sentence, leaving whatever else the icon was saying about itself.
    const parts = dot.title.split(" · ").filter((part) => part.length > 0 && !part.startsWith("cached for"));
    if (told.length > 0) parts.push(told);
    dot.title = parts.join(" · ");
  }
}

export function thousands(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Local clock time, because a reset at "12:40Z" is not a time he can act on. */
export function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Same, with the weekday — the weekly reset is usually days out, and a bare time lies about which
 *  day it falls on. */
export function clockOfDay(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** `"55m"` under the hour, `"2h44m"` above it — the badge's own compact clock. It lives in a 300px
 *  column with room for one line, so it spells nothing out the way `minutes()` used to. */
export function compactDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 60) return `${String(total)}m`;
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${String(hours)}h${String(mins).padStart(2, "0")}m`;
}

/**
 * A share of the 5-hour window, as a percentage. Under 1% rounds to one decimal rather than to
 * "0%" — a session that has drawn a fifth of a percent has drawn something, and saying zero is
 * the same class of lie the fitted estimate told.
 */
export function percentOfWindow(percent: number): string {
  if (percent >= 1) return `${String(Math.round(percent))}%`;
  return `${percent.toFixed(1)}%`;
}

/**
 * How old a reading has to be before its age is worth a word.
 *
 * The endpoint is polled every 20s and a single failed poll is nothing: the badge used to announce
 * "stale — last read 2m ago, showing the last good reading" across the top of the tooltip, which
 * User read as the SESSION being stale and which was, at two minutes, not even true — *"2 minutes
 * isnt really that stale ... its not the most important information to be the first line"*
 * (2026-08-29). Under this, a failed poll passes in silence, as it should.
 */
export const AGED_MS = 8 * 60_000;

/** `"reading 12m old"`, or null while the number on screen is recent enough to just be the number. */
export function agedNote(bar: BarReading | null, quota: Quota): string | null {
  if (bar?.stale !== true) return null;
  const age = Date.now() - quota.at;
  return age >= AGED_MS ? `reading ${compactDuration(age)} old` : null;
}

/**
 * "40 min", "7 h", "3 days" — one way of saying how long ago, used by the active-projects list.
 * It went missing when the usage-bar build replaced the old `#cache-state` row that had been its
 * only other caller, and came back when master's active-age list merged in and could not compile
 * without it (2026-08-29).
 */
export function minutes(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 90) return `${String(Math.max(1, mins))} min`;
  const hours = Math.round(mins / 60);
  return hours < 36 ? `${String(hours)} h` : `${String(Math.round(hours / 24))} days`;
}

/** One labelled figure in the badge's tooltip. */
export interface TipRow {
  label: string;
  value: string;
  className?: string;
}

/** One headed group of them. */
export interface TipSection {
  heading: string;
  rows: TipRow[];
}

export type BudgetId =
  | "anthropic"
  | "g1:gemini"
  | "g1:thirdparty"
  | "jules";

export type BudgetAvailability = "ok" | "stale" | "unavailable";

export interface BudgetWindowBreakdown {
  percent: number;
  resetsAt: number | null;
  severity?: "normal" | "warning" | "critical" | null;
}

export interface BudgetEntry {
  id: BudgetId;
  percent: number | null;
  percentKind: "used";
  resetsAt: number | null;
  severity?: "normal" | "warning" | "critical" | null;
  absolute: { used: number; limit: number } | null;
  status: BudgetAvailability;
  reason: string | null;
  at: number | null;
  fiveHour?: BudgetWindowBreakdown | null;
  weekly?: BudgetWindowBreakdown | null;
}

export interface BudgetsReport {
  budgets: Record<BudgetId, BudgetEntry>;
  list: BudgetEntry[];
  at: number;
}

export const BUDGET_ORDER: readonly BudgetId[] = [
  "anthropic",
  "g1:gemini",
  "g1:thirdparty",
  "jules",
];

export function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

export function budgetLabel(id: BudgetId): string {
  switch (id) {
    case "anthropic":
      return "Claude (Anthropic)";
    case "g1:gemini":
      return "G1 gemini (Flash/Pro)";
    case "g1:thirdparty":
      return "G1 claude (Sonnet/Opus 4.6)";
    case "jules":
      return "Jules tasks";
  }
}

export function currentActiveBudgetId(): BudgetId {
  let modelId = ui.pickModel.value;
  if (state.sessionId.length > 0 && !state.pendingNew) {
    const cur = state.sessions.find((s) => s.id === state.sessionId);
    if (cur !== undefined && cur.pick !== null) {
      modelId = cur.pick.model;
    }
  }
  const spec = state.models.find((m) => m.id === modelId);
  if (spec !== undefined) {
    if (spec.family === "claude") return "anthropic";
    return `g1:${spec.pool ?? "gemini"}` as BudgetId;
  }
  if (state.activeFamily === "google") {
    return modelId.includes("claude") || modelId.includes("gpt") ? "g1:thirdparty" : "g1:gemini";
  }
  return "anthropic";
}

/**
 * What the badge cannot fit on its one line, as SECTIONS OF LABELLED FIGURES rather than a block
 * of pre-formatted text.
 *
 * It was a single `\n`-joined string with two-space indents, drawn in a `white-space: pre` box —
 * which clipped its own first line and looked, in User's words on 2026-08-29, *"pretty bad"*.
 * Text cannot be laid out; rows can. The renderer below puts each label left and each value right,
 * so the numbers line up in a column and the long ones wrap instead of running off the edge.
 */
export function buildBarTooltip(
  bar: BarReading | null,
  cache: CacheState | null,
): { note: string | null; sections: TipSection[] } {
  const quota = bar?.quota ?? null;
  const note = quota === null ? "no reading yet" : agedNote(bar, quota);

  const sections: TipSection[] = [];
  if (quota !== null && quota.fiveHour !== null) {
    const fh = quota.fiveHour;
    const rows: TipRow[] = [{ label: "used", value: `${String(Math.round(fh.percent))}%` }];
    // Share of the window, said in the same unit the window itself is said in — a percentage. It
    // was once printed as "N pts" against the fitted weights, which named a unit User never
    // asked for and could not read (2026-08-29). The rival-session line went with it: nothing in
    // the frame asks who else is drawing, only how much of the window is mine.
    if (bar !== null && bar.session !== null) {
      rows.push({ label: "this session", value: percentOfWindow(bar.session.percent) });
    }
    if (fh.resetsAt !== null) {
      rows.push({ label: "resets", value: `${clockOf(fh.resetsAt)} · ${compactDuration(fh.resetsAt - Date.now())}` });
    }
    sections.push({ heading: "5-hour window", rows });
  }
  if (quota !== null && quota.weekly !== null) {
    const wk = quota.weekly;
    const rows: TipRow[] = [{ label: "all models", value: `${String(Math.round(wk.percent))}%` }];
    for (const scope of quota.scoped) {
      rows.push({ label: scope.label, value: `${String(Math.round(scope.percent))}%` });
    }
    if (wk.resetsAt !== null) rows.push({ label: "resets", value: clockOfDay(wk.resetsAt) });
    sections.push({ heading: "weekly", rows });
  }
  if (cache !== null) {
    const rows: TipRow[] = [{ label: "context", value: `${cache.context.toLocaleString()} tokens` }];
    rows.push({ label: "last turn reused", value: `${String(Math.round(cache.reuse * 100))}%` });
    if (cache.ttlMs !== null) {
      const expires = cache.at + cache.ttlMs;
      const left = expires - Date.now();
      rows.push({
        label: "expires",
        value: `${clockOf(expires)} · ${left > 0 ? compactDuration(left) : `${compactDuration(-left)} ago`}`,
      });
    }
    rows.push({ label: "if it goes cold", value: `rewrites ${thousands(cache.context)}` });
    sections.push({ heading: "prompt cache", rows });
  }
  return { note, sections };
}

/** Builds the expanded 6-pool breakdown panel tooltip from BudgetsReport data. */
export function buildBudgetsTooltip(
  budgets: BudgetsReport,
  activeId: BudgetId,
  cache: CacheState | null,
): { note: string | null; rightNote: string | null; sections: TipSection[] } {
  const sections: TipSection[] = [];
  const now = Date.now();

  // There is no separate "active pool" section. It said the same thing twice: the pool list below
  // already marks the active one with its own arrow, and the context figure it carried is the
  // prompt-cache section's first row (2026-09-02: *"remove the active pool section since it dupes
  // the other section which already points an arrow to active model in this session"*).

  // All pools — the count comes from the data, never from a number typed here. It said
  //    "6 budgets" over four rows for an hour after the second Google account was removed.
  const poolRows: TipRow[] = [];
  for (const id of BUDGET_ORDER) {
    const entry = budgets.budgets[id];
    const isActive = id === activeId;
    const isUnavail = !entry || entry.status === "unavailable";

    if (isUnavail) {
      poolRows.push({
        label: budgetLabel(id),
        value: `unavailable (${entry?.reason ?? "not configured"})`,
        className: "unavailable" + (isActive ? " active-pool" : ""),
      });
      continue;
    }

    if (id === "jules") {
      const usedStr = entry.absolute
        ? `${entry.absolute.used} / ${entry.absolute.limit} today (${Math.round(entry.percent ?? 0)}%)`
        : `${Math.round(entry.percent ?? 0)}%`;
      const resetStr = entry.resetsAt !== null ? ` · resets ${compactDuration(entry.resetsAt - now)}` : "";
      poolRows.push({
        label: budgetLabel(id),
        value: `${usedStr}${resetStr}`,
        className: isActive ? "active-pool" : undefined,
      });
    } else {
      // Anthropic and the Google pools draw the same way: a headline row, then the two windows
      // under it. Anthropic used to skip the windows, so its WEEKLY limit — the one that actually
      // runs out — appeared nowhere in the panel, though the server has always sent it
      // (User, 2026-09-02: *"it shows also weekly anthropic limit, you missed it"*).
      const pct = Math.round(entry.percent ?? 0);
      const resetStr = entry.resetsAt !== null ? `resets ${compactDuration(entry.resetsAt - now)}` : (pct === 0 ? "unused" : "");
      poolRows.push({
        label: id === "anthropic" ? "Claude (Anthropic sub)" : budgetLabel(id),
        value: resetStr ? `${pct}% · ${resetStr}` : `${pct}%`,
        className: isActive ? "active-pool" : undefined,
      });

      if (entry.fiveHour) {
        const fhPct = Math.round(entry.fiveHour.percent);
        const fhReset = entry.fiveHour.resetsAt !== null ? `resets ${compactDuration(entry.fiveHour.resetsAt - now)}` : "—";
        poolRows.push({
          label: "↳ 5h window",
          value: `${fhPct}% · ${fhReset}`,
          className: "sub-row",
        });
      }
      if (entry.weekly) {
        const wkPct = Math.round(entry.weekly.percent);
        const wkReset = entry.weekly.resetsAt !== null ? `resets ${clockOfDay(entry.weekly.resetsAt)}` : "—";
        poolRows.push({
          label: "↳ weekly",
          value: `${wkPct}% · ${wkReset}`,
          className: "sub-row",
        });
      }
    }
  }

  sections.push({
    heading: `all pools (${poolRows.filter((r) => r.className !== "sub-row").length} budgets)`,
    rows: poolRows,
  });

  // 3. Prompt cache
  if (cache !== null) {
    const cacheRows: TipRow[] = [
      { label: "context", value: `${cache.context.toLocaleString()} tokens` },
      { label: "last turn reused", value: `${Math.round(cache.reuse * 100)}%` },
    ];
    if (cache.ttlMs !== null) {
      const expires = cache.at + cache.ttlMs;
      const left = expires - now;
      cacheRows.push({
        label: "expires",
        value: `${clockOf(expires)} · ${left > 0 ? compactDuration(left) : `${compactDuration(-left)} ago`}`,
      });
    }
    cacheRows.push({ label: "if it goes cold", value: `rewrites ${thousands(cache.context)}` });
    sections.push({ heading: "prompt cache", rows: cacheRows });
  }

  let note: string | null = null;
  const age = now - budgets.at;
  if (age >= AGED_MS) {
    note = `reading ${compactDuration(age)} old`;
  }

  return {
    note,
    rightNote: null,
    sections,
  };
}

/** Draw the tooltip model into `#bar-tip`. Rebuilt on every `drawBadge`, which is cheap: a dozen
 *  rows, and only while the badge is on screen. */
export function drawBarTooltip(model: { note: string | null; rightNote?: string | null; sections: TipSection[] }): void {
  ui.barTip.replaceChildren();
  for (const section of model.sections) {
    ui.barTip.append(el("div", "tip-head", section.heading));
    for (const row of section.rows) {
      const line = el("div", row.className ? `tip-row ${row.className}` : "tip-row");
      line.append(el("span", "tip-label", row.label), el("span", "tip-value", row.value));
      ui.barTip.append(line);
    }
  }
  if (model.note !== null || (model.rightNote !== undefined && model.rightNote !== null)) {
    const noteEl = el("div", "tip-note");
    if (model.rightNote !== undefined && model.rightNote !== null) {
      noteEl.append(el("span", "", model.note ?? ""), el("span", "", model.rightNote));
    } else if (model.note !== null) {
      noteEl.textContent = model.note;
    }
    ui.barTip.append(noteEl);
  }
}

export function updateMicroBars(budgets: BudgetsReport, activeId: BudgetId): void {
  const microMap: Record<BudgetId, HTMLElement> = {
    anthropic: ui.mbClaude,
    "g1:gemini": ui.mbG1Gem,
    "g1:thirdparty": ui.mbG1Cla,
    jules: ui.mbJules,
  };

  for (const id of BUDGET_ORDER) {
    const barEl = microMap[id];
    if (!barEl) continue;
    const entry = budgets.budgets[id];
    const isActive = id === activeId;
    const isUnavailable = !entry || entry.status === "unavailable";
    const isStale = entry?.status === "stale";
    const pct = isUnavailable ? 0 : clampPct(entry.percent ?? 0);
    const isWarm = !isUnavailable && !isStale && pct >= 75 && pct < 90;
    const isHot = !isUnavailable && !isStale && pct >= 90;

    barEl.classList.toggle("active", isActive);
    barEl.classList.toggle("warn", isWarm);
    barEl.classList.toggle("hot", isHot);
    barEl.classList.toggle("unavailable", isUnavailable);
    barEl.classList.toggle("stale", isStale);
    if (id === "jules") barEl.classList.add("jules");

    const fill = barEl.querySelector<HTMLElement>("i");
    if (fill) {
      fill.style.height = `${pct}%`;
    }

    if (isUnavailable) {
      barEl.title = `${budgetLabel(id)}: unavailable (${entry?.reason ?? "not configured"})${isActive ? " [Active Session]" : ""}`;
    } else if (id === "jules" && entry.absolute) {
      barEl.title = `Jules: ${entry.absolute.used}/${entry.absolute.limit} tasks (${Math.round(pct)}%)${isActive ? " [Active Session]" : ""}`;
    } else {
      barEl.title = `${budgetLabel(id)}: ${Math.round(pct)}%${isActive ? " [Active Session]" : ""}`;
    }
  }
}
