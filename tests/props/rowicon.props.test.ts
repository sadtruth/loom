/**
 * The row icon's ladder and the hour's arithmetic (SPEC 256-258).
 *
 * The ladder is pinned against a WRITTEN TABLE rather than against the code that computes it: a
 * property asserting only "exactly one state wins" passes on any order at all, so swapping two
 * levels would stay green. The table below is the requirement restated by hand — if it and
 * `rowIconState` ever disagree, one of them is the bug and the test says which.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  CACHE_LOW,
  cacheFraction,
  cacheTooltip,
  carriesBar,
  rowIconState,
  warmestWindow,
  type RowIconState,
} from "../../client/rowicon.ts";

const HOUR = 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

/** working · unread · isNew -> the one state drawn. Written out, not derived. */
const LADDER: { working: boolean; unread: boolean; isNew: boolean; expect: RowIconState }[] = [
  { working: false, unread: false, isNew: false, expect: "status" },
  { working: false, unread: false, isNew: true, expect: "new" },
  { working: false, unread: true, isNew: false, expect: "unread" },
  { working: false, unread: true, isNew: true, expect: "unread" },
  { working: true, unread: false, isNew: false, expect: "working" },
  { working: true, unread: false, isNew: true, expect: "working" },
  { working: true, unread: true, isNew: false, expect: "working" },
  { working: true, unread: true, isNew: true, expect: "working" },
];

describe("the ladder is an ORDER, and the order is written down", () => {
  test("every combination of the three facts draws the state the table names", () => {
    // All eight rows, not a sample: three booleans have exactly eight worlds and each one is a
    // decision somebody made. Swapping unread above working in the code reddens rows 7 and 8.
    expect(LADDER.length).toBe(8);
    for (const row of LADDER) {
      expect(rowIconState({ working: row.working, unread: row.unread, isNew: row.isNew })).toBe(row.expect);
    }
  });

  test("the ladder is total — some state always wins, for any facts at all", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (working, unread, isNew) => {
        const state = rowIconState({ working, unread, isNew });
        expect(["working", "unread", "new", "status"]).toContain(state);
      }),
    );
  });

  test("the bar goes under exactly two of the four, and never under new or working", () => {
    expect(carriesBar("unread")).toBe(true);
    expect(carriesBar("status")).toBe(true);
    // `new` has no session attached, so no window a bar could describe; `working` is pushing the
    // window forward rather than spending it. Both are reasons, not taste (SPEC 258).
    expect(carriesBar("new")).toBe(false);
    expect(carriesBar("working")).toBe(false);
  });

  test("a row that draws a bar is never a row that is new or working", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (working, unread, isNew) => {
        const state = rowIconState({ working, unread, isNew });
        if (!carriesBar(state)) return;
        expect(state === "new" || state === "working").toBe(false);
      }),
    );
  });
});

describe("the hour: what is left, as a fraction of the window", () => {
  const at = fc.integer({ min: 0, max: 4_000_000_000_000 });
  const ttl = fc.integer({ min: 1, max: 24 * HOUR });
  const now = fc.integer({ min: 0, max: 4_100_000_000_000 });

  test("always a real number in [0, 1] — never NaN, never negative, never past full", () => {
    fc.assert(
      fc.property(at, ttl, now, (a, t, n) => {
        const frac = cacheFraction({ at: a, ttlMs: t }, n);
        expect(Number.isFinite(frac)).toBe(true);
        expect(frac).toBeGreaterThanOrEqual(0);
        expect(frac).toBeLessThanOrEqual(1);
      }),
    );
  });

  test("monotonic in time: it only ever shortens as the clock moves forward", () => {
    fc.assert(
      fc.property(at, ttl, now, fc.integer({ min: 0, max: 3 * HOUR }), (a, t, n, step) => {
        expect(cacheFraction({ at: a, ttlMs: t }, n + step)).toBeLessThanOrEqual(
          cacheFraction({ at: a, ttlMs: t }, n),
        );
      }),
    );
  });

  test("EXACTLY zero at the instant it expires, and everywhere past it", () => {
    fc.assert(
      fc.property(at, ttl, fc.integer({ min: 0, max: 10 * HOUR }), (a, t, over) => {
        // Zero means nothing is drawn at all — neither fill nor track. The absence is the message.
        expect(cacheFraction({ at: a, ttlMs: t }, a + t + over)).toBe(0);
      }),
    );
  });

  test("the four windows the CLI actually writes, driven by hand", () => {
    const start = 1_700_000_000_000;
    // No window stated: no bar, never a guessed hour.
    expect(cacheFraction(null, start)).toBe(0);
    expect(cacheFraction({ at: start, ttlMs: 0 }, start)).toBe(0);
    // The 5-minute bucket, halfway through.
    expect(cacheFraction({ at: start, ttlMs: FIVE_MIN }, start + FIVE_MIN / 2)).toBeCloseTo(0.5, 6);
    // The 1-hour bucket at birth, at half, and one minute before it lapses.
    expect(cacheFraction({ at: start, ttlMs: HOUR }, start)).toBe(1);
    expect(cacheFraction({ at: start, ttlMs: HOUR }, start + HOUR / 2)).toBeCloseTo(0.5, 6);
    expect(cacheFraction({ at: start, ttlMs: HOUR }, start + HOUR - 60_000)).toBeCloseTo(1 / 60, 6);
    expect(cacheFraction({ at: start, ttlMs: HOUR }, start + HOUR)).toBe(0);
  });

  test("amber is a FIFTH of the window, so the 5-minute bucket is not amber from birth", () => {
    const start = 1_700_000_000_000;
    // A fixed ten-minute threshold would paint the 5-minute bucket amber the moment it is written.
    expect(cacheFraction({ at: start, ttlMs: FIVE_MIN }, start) < CACHE_LOW).toBe(false);
    // And the hour goes amber only in its last twelve minutes.
    expect(cacheFraction({ at: start, ttlMs: HOUR }, start + 47 * 60_000) < CACHE_LOW).toBe(false);
    expect(cacheFraction({ at: start, ttlMs: HOUR }, start + 49 * 60_000) < CACHE_LOW).toBe(true);
  });

  test("the tooltip says minutes while there is a window, and nothing once there is not", () => {
    const start = 1_700_000_000_000;
    expect(cacheTooltip({ at: start, ttlMs: HOUR }, start + 38 * 60_000)).toBe("cached for another 22 min");
    expect(cacheTooltip({ at: start, ttlMs: HOUR }, start + HOUR)).toBeNull();
    expect(cacheTooltip(null, start)).toBeNull();
  });
});

describe("a row speaks for ONE session, chosen by the written rule", () => {
  test("the warmest window wins — the one he would type into", () => {
    const start = 1_700_000_000_000;
    const picked = warmestWindow([
      { cacheAt: start, ttlMs: FIVE_MIN },
      { cacheAt: start, ttlMs: HOUR },
      { cacheAt: start - HOUR, ttlMs: HOUR },
    ]);
    expect(picked).toEqual({ at: start, ttlMs: HOUR });
  });

  test("a session that stated no bucket carries no window and is simply skipped", () => {
    expect(warmestWindow([{ cacheAt: 1, ttlMs: null }, { cacheAt: null, ttlMs: HOUR }])).toBeNull();
    expect(warmestWindow([])).toBeNull();
    expect(warmestWindow([{ cacheAt: 1, ttlMs: null }, { cacheAt: 5, ttlMs: HOUR }])).toEqual({
      at: 5,
      ttlMs: HOUR,
    });
  });

  test("whatever the list, the answer is one of its own windows and the latest-ending one", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cacheAt: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 1_000_000 })),
            ttlMs: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: HOUR })),
          }),
          { maxLength: 8 },
        ),
        (sessions) => {
          const picked = warmestWindow(sessions);
          const real = sessions.filter(
            (s): s is { cacheAt: number; ttlMs: number } => typeof s.cacheAt === "number" && typeof s.ttlMs === "number",
          );
          if (real.length === 0) {
            expect(picked).toBeNull();
            return;
          }
          expect(picked).not.toBeNull();
          const end = picked === null ? -1 : picked.at + picked.ttlMs;
          for (const s of real) expect(s.cacheAt + s.ttlMs).toBeLessThanOrEqual(end);
        },
      ),
    );
  });
});
