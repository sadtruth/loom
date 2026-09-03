/**
 * What one turn cost, with no DOM and no imports.
 *
 * It lives alone for the reason `signature.ts` does: BOTH of them need it, and `render.ts` already
 * imports `signature.ts`, so putting it in `render.ts` would have made the dependency run in a
 * circle. That is not a style point — the figure is drawn from `scale`, which changes on every
 * `/api/bar` poll, so `turnSignature` must be able to see the RENDERED text or SPEC 211 leaves a
 * stale percentage on screen with the row it belongs to unchanged (usage-bar, 2026-08-26, caught
 * by the client worker before it shipped).
 *
 * Zero imports and one exported surface, so a caller can use it without reading it.
 */

/** Mirrors `MessageUsage` in `server/transcript.ts`; the two are hand-kept, as `Message` is. */
export interface MessageUsage {
  /** Dedupe key. One API call writes one transcript record PER CONTENT BLOCK, all sharing this. */
  requestId: string;
  /** Weighted units, priced server-side with `block.ts`'s own weights. */
  units: number;
  /** Cache-read tokens. */
  read: number;
  /** Cache-write tokens, so `read / (read + write)` is available without a second endpoint. */
  write: number;
  /** read + cache_creation + input — the whole prompt this call paid for. */
  ctx: number;
  /** Lifetime of the ephemeral bucket this call wrote, in ms; null when it wrote none. */
  ttlMs: number | null;
}

/** `12,000` -> `"12k"`, under a thousand unchanged — the cost tooltip's own compact form. Mirrors
 *  `thousands()` in app.ts; not shared because that module is the entry point and this one is not
 *  allowed to import it (the dependency would run the wrong way). */
function thousands(tokens: number): string {
  return tokens >= 1000 ? `${String(Math.round(tokens / 1000))}k` : String(tokens);
}

/**
 * Raw sum of a turn's `usage`, deduped by `requestId` — the exact arithmetic `sumUsage` in
 * `server/transcript.ts` performs. Reimplemented here because this module cannot import from
 * `server/`; `tests/props/turn-usage.props.test.ts` pins the two equal for any generated turn.
 * A turn holds one row per content block of a tool loop, all sharing one `requestId`, so summing
 * every row instead of every CALL overcounts a multi-block call as many times as it has blocks.
 */
export function sumTurnUsage(turn: readonly { usage?: MessageUsage }[]): {
  units: number;
  read: number;
  ctx: number;
  calls: number;
  /** Smallest per-call `read/ctx`, or null when every deduped call had `ctx === 0`. */
  worstCache: number | null;
} {
  const seen = new Set<string>();
  let units = 0;
  let read = 0;
  let ctx = 0;
  let calls = 0;
  let worstCache: number | null = null;
  for (const m of turn) {
    const u = m.usage;
    if (u === undefined || seen.has(u.requestId)) continue;
    seen.add(u.requestId);
    units += u.units;
    read += u.read;
    ctx += u.ctx;
    calls += 1;
    if (u.ctx > 0) {
      const hit = u.read / u.ctx;
      if (worstCache === null || hit < worstCache) worstCache = hit;
    }
  }
  return { units, read, ctx, calls, worstCache };
}

/** Starting point, not a finding: lit without hovering once a turn is at least this share of the
 *  5-hour window. Set to 0.45 from one session's data, then raised to 2.0 on 2026-08-26 after
 *  looking at the real thing: a working session's turns run 0.7-3.5%, so 0.45 lit nearly all of
 *  them and "quiet unless it ate a lot" stopped meaning anything. Raise it again if it still
 *  talks too much — the cache rule below is the one that catches real problems. */
const LOUD_PERCENT = 2.0;
/** Starting point, not a finding: lit without hovering when any call in the turn hit under this
 *  much cache. */
const LOUD_CACHE_HIT = 0.5;

/** The turn-cost figure `renderTurn` appends to `.msg-head`, or null when there is nothing honest
 *  to show — every row lacked `usage`, or `scale` is 0 because `/api/bar` has not answered with a
 *  usable quota yet. Never NaN, never a bare `0.00%` standing in for "no data" (usage-bar,
 *  2026-08-26: most historical transcripts have no usage captured, so this is the common case). */
export function turnCostLabel(
  turn: readonly { usage?: MessageUsage }[],
  scale: number,
): { text: string; title: string; loud: boolean } | null {
  const sum = sumTurnUsage(turn);
  if (sum.calls === 0 || scale === 0) return null;

  const percent = sum.units * scale;
  const cacheHit = sum.ctx > 0 ? sum.read / sum.ctx : null;
  const text =
    cacheHit === null ? `${percent.toFixed(2)}%` : `${percent.toFixed(2)}% · ${String(Math.round(cacheHit * 100))}% cache`;

  const meanCtx = sum.ctx / sum.calls;
  const worstText = sum.worstCache === null ? "n/a" : `${String(Math.round(sum.worstCache * 100))}%`;
  const title = `${String(sum.calls)} call${sum.calls === 1 ? "" : "s"} · mean context ${thousands(meanCtx)} · worst cache ${worstText}`;

  const loud = percent >= LOUD_PERCENT || (sum.worstCache !== null && sum.worstCache < LOUD_CACHE_HIT);
  return { text, title, loud };
}
