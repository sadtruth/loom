/**
 * The windowed transcript's arithmetic (SPEC 228), as properties over every session shape and every
 * scroll position that can reach it.
 *
 * These are the rules a browser pin cannot state. A driven spec can show that ONE 2,000-turn fixture
 * keeps its DOM small and does not jump; it cannot show that the same holds for a session of any
 * length, at any scroll position, with any mixture of measured and estimated heights — and the two
 * failures that matter here are exactly the ones that need a particular combination of those. A
 * spacer that is a pixel short makes the scroller change size under the reader's hand, which is the
 * "jumping" this whole build is named for; a window that stops covering the viewport shows the
 * reader a blank screen with a scrollbar.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { MIN_TURNS, estimateHeight, modelledHeight, planWindow, turnTops, type TurnSpan } from "../../client/window.ts";

/**
 * A session as the window sees it: turns in message order, each starting after the previous one, and
 * each with a height. Heights range from a one-line answer to a very tall turn, because the crowded
 * cases live at both ends.
 */
const session = (): fc.Arbitrary<{ turns: TurnSpan[]; messages: number }> =>
  fc
    .array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 56, max: 3000 })), {
      minLength: 1,
      maxLength: 400,
    })
    .map((rows) => {
      const turns: TurnSpan[] = [];
      let at = 0;
      rows.forEach(([span, height], i) => {
        turns.push({ at, key: `turn:${String(i)}`, height });
        at += span;
      });
      return { turns, messages: at };
    });

const viewport = (): fc.Arbitrary<{ base: number; scrollTop: number; height: number; atEnd: boolean; overscan: number }> =>
  fc.record({
    base: fc.integer({ min: 0, max: 4000 }),
    scrollTop: fc.integer({ min: 0, max: 400_000 }),
    height: fc.integer({ min: 200, max: 1400 }),
    atEnd: fc.boolean(),
    overscan: fc.integer({ min: 200, max: 1400 }),
  });

function mountedHeight(turns: readonly TurnSpan[], first: number, last: number): number {
  let sum = 0;
  for (let i = first; i < last; i += 1) sum += turns[i]?.height ?? 0;
  return sum;
}

describe("the window's arithmetic", () => {
  /**
   * THE STILLNESS PROPERTY. The scroller's content is the two spacers plus the mounted turns, so if
   * that total ever differs from the session's own modelled height, the page grows or shrinks when
   * the window moves — under a reader who did nothing. Everything else in this file is secondary to
   * this one.
   */
  test("the two spacers and the mounted turns are exactly the whole session, at every position", () => {
    fc.assert(
      fc.property(session(), viewport(), ({ turns, messages }, view) => {
        const plan = planWindow(turns, messages, view);
        expect(plan.above + mountedHeight(turns, plan.first, plan.last) + plan.below).toBe(modelledHeight(turns));
      }),
      { numRuns: 500 },
    );
  });

  /**
   * The cut is a TURN boundary — the same boundary `groupTurns` cuts on — because a slice taken
   * anywhere else separates a tool call from its result, and the renderer then draws a call still
   * waiting for an answer that is sitting two messages above the cut.
   */
  test("the slice starts and ends on a turn, and never runs backwards", () => {
    fc.assert(
      fc.property(session(), viewport(), ({ turns, messages }, view) => {
        const plan = planWindow(turns, messages, view);
        expect(plan.first).toBeGreaterThanOrEqual(0);
        expect(plan.last).toBeLessThanOrEqual(turns.length);
        expect(plan.first).toBeLessThan(plan.last);
        expect(plan.from).toBe(turns[plan.first]?.at as number);
        expect(plan.to).toBe(plan.last < turns.length ? (turns[plan.last]?.at as number) : messages);
        expect(plan.from).toBeLessThanOrEqual(plan.to);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * WHAT THE READER IS LOOKING AT IS MOUNTED. Stated against the modelled positions rather than
   * against the plan's own arithmetic, so a window that agreed with itself and disagreed with the
   * page still fails: every pixel of the viewport that has a turn behind it is inside the mounted
   * range.
   */
  test("the viewport is covered by real turns, wherever the reader is", () => {
    fc.assert(
      fc.property(session(), viewport(), ({ turns, messages }, view) => {
        const plan = planWindow(turns, messages, { ...view, atEnd: false });
        const tops = turnTops(turns, view.base);
        const total = modelledHeight(turns);
        const top = Math.max(view.base, view.scrollTop);
        const bottom = Math.min(view.base + total, view.scrollTop + view.height);
        if (bottom <= top) return; // the viewport is entirely above or below the session
        expect(tops[plan.first] as number).toBeLessThanOrEqual(top);
        const end = plan.last < turns.length ? (tops[plan.last] as number) : view.base + total;
        expect(end).toBeGreaterThanOrEqual(bottom);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * "Make them light, even huge ones." The mounted DOM is a function of the SCREEN, not of the
   * session — which is the difference between this and the paint budget it replaced, and it is only
   * true if the mounted height can be bounded independently of how many turns there are.
   */
  test("what is mounted is bounded by the screen, not by the session's length", () => {
    fc.assert(
      fc.property(session(), viewport(), ({ turns, messages }, view) => {
        const plan = planWindow(turns, messages, view);
        if (plan.last - plan.first <= MIN_TURNS) return; // the floor, not the geometry, decided it
        const tallest = Math.max(...turns.map((t) => t.height));
        expect(mountedHeight(turns, plan.first, plan.last)).toBeLessThanOrEqual(
          view.height + 2 * view.overscan + 2 * tallest,
        );
      }),
      { numRuns: 500 },
    );
  });

  /** Following the live end means the END is on screen — that is the whole promise of opening a session. */
  test("at the end, the last turn is mounted", () => {
    fc.assert(
      fc.property(session(), viewport(), ({ turns, messages }, view) => {
        const plan = planWindow(turns, messages, { ...view, atEnd: true });
        expect(plan.last).toBe(turns.length);
        expect(plan.below).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * METAMORPHIC: two runs of the same session, one scrolled further down than the other. Scrolling
   * towards the end can never mount turns that are further from it — a window that walked backwards
   * would unmount what the reader was reading and rebuild it a frame later, which is a reload of
   * every prototype on the screen (SPEC 211).
   */
  test("scrolling down never moves the window up", () => {
    fc.assert(
      fc.property(session(), viewport(), fc.integer({ min: 1, max: 20_000 }), ({ turns, messages }, view, step) => {
        const here = planWindow(turns, messages, { ...view, atEnd: false });
        const lower = planWindow(turns, messages, { ...view, atEnd: false, scrollTop: view.scrollTop + step });
        expect(lower.first).toBeGreaterThanOrEqual(here.first);
        expect(lower.last).toBeGreaterThanOrEqual(here.last);
      }),
      { numRuns: 500 },
    );
  });

  /** Every turn's modelled place is where the spacer above it says it is — the gutter reads these. */
  test("a turn's modelled top is the base plus everything above it", () => {
    fc.assert(
      fc.property(session(), fc.integer({ min: 0, max: 4000 }), ({ turns }, base) => {
        const tops = turnTops(turns, base);
        expect(tops[0]).toBe(base);
        for (let i = 1; i < turns.length; i += 1) {
          expect(tops[i] as number).toBe((tops[i - 1] as number) + (turns[i - 1]?.height ?? 0));
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("the height estimate", () => {
  /** An estimate is never absurd in either direction, or the scrollbar is a lie at both ends. */
  test("a turn is never estimated at less than a row or more than a few screens", () => {
    fc.assert(
      fc.property(
        fc.record({
          chars: fc.integer({ min: 0, max: 2_000_000 }),
          tools: fc.integer({ min: 0, max: 400 }),
          images: fc.integer({ min: 0, max: 40 }),
        }),
        (bulk) => {
          const px = estimateHeight(bulk);
          expect(px).toBeGreaterThanOrEqual(56);
          expect(px).toBeLessThanOrEqual(4000);
        },
      ),
      { numRuns: 500 },
    );
  });

  /** METAMORPHIC: more text is never estimated shorter. A non-monotone estimate makes the history
   *  above the reader shrink as it is measured, which reads as the page jumping. */
  test("adding text never makes a turn shorter", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 40 }),
        (chars, more, tools) => {
          const bulk = { chars, tools, images: 0 };
          expect(estimateHeight({ ...bulk, chars: chars + more })).toBeGreaterThanOrEqual(estimateHeight(bulk));
        },
      ),
      { numRuns: 500 },
    );
  });
});
