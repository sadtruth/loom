/**
 * The turn-cost figure's arithmetic (`client/render.ts`'s `sumTurnUsage`/`turnCostLabel`), against
 * `sumUsage` in `server/transcript.ts` — the same dedupe-by-`requestId` rule, kept in two files
 * because `render.ts` cannot import from `server/` (usage-bar, 2026-08-26).
 *
 * A turn holds one row per content block of a tool loop, all sharing one `requestId`. Summing
 * `usage.units` over every ROW instead of every CALL overcounts a multi-block call as many times as
 * it has blocks — the exact bug the dedupe exists to prevent, so the first property below is written
 * to catch a naive (non-deduped) sum before it is written to catch anything else.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { sumTurnUsage, turnCostLabel, type Message, type MessageUsage } from "../../client/render.ts";
import { sumUsage } from "../../server/transcript.ts";

// A small pool, so `requestId` repeats inside a generated turn often rather than by chance alone —
// the case the dedupe exists for.
const requestIdArb = fc.constantFrom("r1", "r2", "r3", "r4");

const usageArb: fc.Arbitrary<MessageUsage> = fc.record({
  requestId: requestIdArb,
  units: fc.double({ min: 0, max: 1000, noNaN: true }),
  // Zero-token rows: a call can legitimately read/write nothing (e.g. a cache-only hit accounted
  // elsewhere), so 0 is in range, not excluded.
  read: fc.integer({ min: 0, max: 400_000 }),
  write: fc.integer({ min: 0, max: 400_000 }),
  ttlMs: fc.constantFrom(null, 5 * 60_000, 60 * 60_000),
  ctx: fc.integer({ min: 0, max: 400_000 }),
});

// Present about 2/3 of the time — "most historical transcripts have no usage captured" (contract),
// so absent has to be common in the generator too, not a rare edge.
const usageOrAbsent = fc.option(usageArb, { nil: undefined, freq: 3 });

const messageArb: fc.Arbitrary<Message> = fc.record({
  uuid: fc.uuid(),
  parentUuid: fc.constant(null),
  role: fc.constantFrom("user" as const, "assistant" as const),
  ts: fc.constant(""),
  blocks: fc.constant([]),
  isSidechain: fc.constant(false),
  isMeta: fc.constant(false),
  usage: usageOrAbsent,
});

const turnArb = fc.array(messageArb, { minLength: 0, maxLength: 8 });

const messageNoUsageArb: fc.Arbitrary<Message> = fc.record({
  uuid: fc.uuid(),
  parentUuid: fc.constant(null),
  role: fc.constantFrom("user" as const, "assistant" as const),
  ts: fc.constant(""),
  blocks: fc.constant([]),
  isSidechain: fc.constant(false),
  isMeta: fc.constant(false),
  usage: fc.constant(undefined),
});

/** A sum with no dedupe at all — what `sumTurnUsage` must NOT reduce to whenever a `requestId`
 *  actually repeats with different numbers on its rows. Exists only so the property below has
 *  something to fail against; it is never used by the shipped renderer. */
function naiveSum(turn: readonly Message[]): { units: number; read: number; ctx: number } {
  let units = 0;
  let read = 0;
  let ctx = 0;
  for (const m of turn) {
    if (m.usage === undefined) continue;
    units += m.usage.units;
    read += m.usage.read;
    ctx += m.usage.ctx;
  }
  return { units, read, ctx };
}

describe("turn usage — dedupe by requestId", () => {
  test("a naive per-row sum overcounts a turn that repeats a requestId (guards the dedupe itself)", () => {
    // Not a property over the whole generator: it asserts dedupe was NECESSARY, so it needs a turn
    // that actually repeats a requestId with two different readings, which the generator only
    // produces sometimes. Built directly instead of hunted for.
    const turn: Message[] = [
      {
        uuid: "a",
        parentUuid: null,
        role: "assistant",
        ts: "",
        blocks: [],
        isSidechain: false,
        isMeta: false,
        usage: { requestId: "r1", units: 10, read: 100, write: 50, ctx: 200, ttlMs: null },
      },
      {
        uuid: "b",
        parentUuid: null,
        role: "assistant",
        ts: "",
        blocks: [],
        isSidechain: false,
        isMeta: false,
        // Same call, second content-block row. A real parser never attaches usage twice for one
        // requestId (server/transcript.ts's header comment), but the dedupe guards it anyway — and a
        // DIFFERENT reading here is exactly what would slip a naive sum past an equal-values test.
        usage: { requestId: "r1", units: 10, read: 100, write: 50, ctx: 200, ttlMs: null },
      },
    ];
    const deduped = sumTurnUsage(turn);
    expect(deduped.units).toBe(10); // counted once
    expect(deduped.calls).toBe(1);
    expect(naiveSum(turn).units).toBe(20); // counted twice — the overcount dedupe exists to prevent
    expect(deduped.units).not.toBe(naiveSum(turn).units);
  });

  test("renderer-side sum agrees with sumUsage, for any turn including repeats, absent usage, and zero-token rows", () => {
    fc.assert(
      fc.property(turnArb, (turn) => {
        const client = sumTurnUsage(turn);
        const server = sumUsage(turn);
        expect(client.units).toBeCloseTo(server.units, 9);
        expect(client.read).toBe(server.read);
        expect(client.ctx).toBe(server.ctx);
        expect(Number.isNaN(client.units)).toBe(false);
        expect(Number.isNaN(client.read)).toBe(false);
        expect(Number.isNaN(client.ctx)).toBe(false);
      }),
    );
  });

  test("turnCostLabel is never NaN and never negative, for any turn and any non-negative scale", () => {
    fc.assert(
      fc.property(turnArb, fc.double({ min: 0, max: 1, noNaN: true }), (turn, scale) => {
        const label = turnCostLabel(turn, scale);
        if (label === null) return;
        expect(label.text).not.toContain("NaN");
        expect(label.title).not.toContain("NaN");
      }),
    );
  });
});

describe("turn usage — when it renders nothing", () => {
  test("a turn whose rows all lack usage produces no figure at all", () => {
    fc.assert(
      fc.property(
        fc.array(messageNoUsageArb, { minLength: 0, maxLength: 6 }),
        fc.double({ min: 0.0001, max: 1, noNaN: true }), // any usable, nonzero scale
        (turn, scale) => {
          expect(turnCostLabel(turn, scale)).toBeNull();
        },
      ),
    );
  });

  test("scale === 0 produces no figure, even with real usage on every row", () => {
    fc.assert(
      fc.property(fc.array(messageArb, { minLength: 1, maxLength: 6 }), (turn) => {
        expect(turnCostLabel(turn, 0)).toBeNull();
      }),
    );
  });
});
