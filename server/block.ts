/**
 * The 5-hour usage BLOCK — the unit the limit is actually charged in.
 *
 * One definition, used by the live meter (`server/bar.ts`) and by the offline report
 * (`bar-report.ts`). It lived only in the report until 2026-08-08; two copies of a rule this
 * fiddly would have drifted the first time either was touched.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────
 *
 *     block start = first BILLABLE API call after the previous block expired,
 *                   ROUNDED DOWN to the 10-minute mark
 *     block end   = start + 5h        (the "resets HH:MM" a 429 reports)
 *
 * Reconstructed from the four 429s in the archive: all four reported reset times come back to
 * the minute. NOT a rolling window — a rolling scan slides to find the worst 5 hours, which is
 * a boundary the bar never uses.
 *
 * ── THE WEIGHTS ───────────────────────────────────────────────────────────────────────────
 *
 * The bar is not a token count: a 129.9M-token block survived while a 118.0M one tripped, and
 * the survivor lost only on OUTPUT. Fitted over 1,350 candidate weightings, exactly 3 separate
 * the exhausted blocks from the survivors, all agreeing on the shape
 *
 *     cache read : fresh input : cache write : output   ≈   1 : 20 : 10 : 100
 *
 * and all with SONNET UNDISCOUNTED. Treat the shape as the finding and the coefficients as
 * approximate: n=4, and the separating margin is 1.6%. The rationale and the caveats in full
 * live in `bar-report.ts`; this module is the arithmetic only.
 */

/** ms. */
export const BLOCK_MS = 5 * 60 * 60 * 1000;
/** The block start is floored to this. */
export const ROUND_MS = 10 * 60 * 1000;

/**
 * Where the limit sits, in weighted units. Measured as an interval, not a number: the highest
 * block that survived scored 9.0M and the lowest that tripped scored 9.1M. The meter uses the
 * LOW end deliberately — a meter that reads 100% while the bar still has room costs a pause;
 * one that reads 95% at the moment of a 429 costs the trust that makes it worth showing.
 */
export const LIMIT = 9.0e6;

export const W = { read: 0.05, input: 1, write: 0.5, output: 5 } as const;
export const MODEL_W: Readonly<Record<string, number>> = {
  opus: 1,
  // Not a placeholder. Every separating weighting priced Sonnet at parity with Opus, and the
  // 08-07 15:40 block — 37% Sonnet by tokens — tripped at the same weighted total as the
  // pure-Opus blocks. Switching models saves money; it does not buy bar headroom.
  sonnet: 1,
  fable: 2,
  haiku: 1,
  other: 1,
};

export interface Call {
  ts: number;
  model: string;
  read: number;
  write: number;
  input: number;
  output: number;
}

export interface Block {
  start: number;
  end: number;
  /** Weighted units drawn so far. */
  bar: number;
  /** Raw tokens, all four components summed — what a token counter would have said. */
  raw: number;
  calls: number;
  /** Weighted units from the output component alone; ~24% of a real block. */
  output: number;
  /** Mean billable input per call — the context size the reads are paying for. */
  context: number;
}

/** The weight key, not the full model id. */
export function family(model: string): string {
  for (const key of ["opus", "sonnet", "fable", "haiku"]) if (model.includes(key)) return key;
  return "other";
}

/** What one call draws off the bar. */
export function barOf(call: Call): number {
  const raw =
    call.read * W.read + call.write * W.write + call.input * W.input + call.output * W.output;
  return raw * (MODEL_W[call.model] ?? 1);
}

/** Billable input — the part that decides whether a call may OPEN a block. */
export function billableOf(call: Call): number {
  return call.read + call.write + call.input;
}

/**
 * Group calls into blocks. `calls` need not be sorted; the caller's order is not trusted,
 * because the index that feeds the live meter appends per file rather than per instant.
 */
export function blocksOf(calls: readonly Call[]): Block[] {
  const sorted = [...calls].sort((a, b) => a.ts - b.ts);
  const blocks: Block[] = [];
  for (const call of sorted) {
    // A call with no billable input is synthetic — the 429 record itself, meta rows. It must
    // never OPEN a block, or an error message anchors the next five hours in the wrong place.
    if (billableOf(call) === 0) continue;
    let open = blocks[blocks.length - 1];
    if (open === undefined || call.ts >= open.end) {
      const start = Math.floor(call.ts / ROUND_MS) * ROUND_MS;
      open = { start, end: start + BLOCK_MS, bar: 0, raw: 0, calls: 0, output: 0, context: 0 };
      blocks.push(open);
    }
    open.bar += barOf(call);
    open.raw += call.read + call.write + call.input + call.output;
    open.output += call.output * W.output * (MODEL_W[call.model] ?? 1);
    open.context += billableOf(call);
    open.calls++;
  }
  for (const block of blocks) block.context = Math.round(block.context / Math.max(block.calls, 1));
  return blocks;
}

/**
 * How many more calls this block has room for, at the cost the block has been running at.
 * The headline number: a call costs ~9,500 units almost regardless of what it does (context
 * x 0.05 + output x 5), so the budget is ~900 calls and it is worth saying out loud.
 */
export function callsLeft(block: Block): number {
  const per = block.bar / Math.max(block.calls, 1);
  if (per <= 0) return 0;
  return Math.max(0, Math.round((LIMIT - block.bar) / per));
}
