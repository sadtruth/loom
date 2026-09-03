/**
 * The marker gutter's decisions (SPEC 192), as properties over every input that can reach them.
 *
 * Two of the three rules are the ones that fail quietly rather than loudly. "A turn with nothing
 * embedded in it is not a point" is a rule about what is ABSENT, so a hand-written case cannot see
 * it going wrong — a gutter with a point per message still draws, it just draws a ruler. And "at the
 * end of the scroller the last point is selected" only shows up at one position out of every scroll
 * height there is.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isPoint, pointClass, pointLabel, readingIndex, type TurnFacts } from "../../client/gutter.ts";

const facts = (): fc.Arbitrary<TurnFacts> =>
  fc.record({
    mine: fc.boolean(),
    answer: fc.boolean(),
    plan: fc.boolean(),
    proto: fc.boolean(),
  });

/** Ascending offsets, which is the only order the transcript can produce. */
const tops = (): fc.Arbitrary<number[]> =>
  fc
    .array(fc.integer({ min: 0, max: 400 }), { minLength: 0, maxLength: 40 })
    .map((gaps) => gaps.reduce<number[]>((out, gap) => [...out, (out[out.length - 1] ?? 0) + gap + 1], []));

describe("which turns are points", () => {
  // Two-sided on purpose, and this is the half the old rule fails: since 2026-08-20 a point is an
  // embedded ARTIFACT and nothing else, so a turn he typed with no plan and no frame in it — which
  // is most of what he types — must contribute no point at all.
  test("a turn carrying no artifact is never a point, whoever wrote it", () => {
    fc.assert(
      fc.property(facts(), (f) => {
        if (!f.plan && !f.proto) expect(isPoint(f)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  test("every turn carrying an artifact is a point, whatever else is true of it", () => {
    fc.assert(
      fc.property(facts(), (f) => {
        if (f.plan || f.proto) expect(isPoint(f)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("one shape per point: a plan and a prototype in one turn cannot both claim it", () => {
    fc.assert(
      fc.property(facts(), (f) => {
        const classes = pointClass(f).split(" ");
        expect(classes.filter((c) => c === "plan" || c === "proto").length).toBeLessThanOrEqual(1);
        expect(classes[0]).toBe("mm");
        expect(classes.includes("user")).toBe(f.mine);
      }),
      { numRuns: 500 },
    );
  });

  test("the label says who, and says the kind only when there is one", () => {
    fc.assert(
      fc.property(facts(), (f) => {
        const label = pointLabel(f);
        expect(label.startsWith(f.mine ? "user" : "claude")).toBe(true);
        if (!f.plan && !f.proto) expect(label.includes("·")).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe("which point is being read", () => {
  test("always a real point, or nothing at all when there are none", () => {
    fc.assert(
      fc.property(tops(), fc.integer({ min: 0, max: 20_000 }), fc.integer({ min: 100, max: 1200 }), (list, top, view) => {
        const height = Math.max(view, (list[list.length - 1] ?? 0) + view + 1);
        const at = readingIndex(list, Math.min(top, height - view), view, height);
        if (list.length === 0) expect(at).toBe(-1);
        else expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThan(list.length);
      }),
      { numRuns: 500 },
    );
  });

  // The tail below the last point is what makes this rule bite, and it has to be SHORTER than the
  // window or the ordinary rule finds the last point anyway and the case proves nothing. In loom
  // that tail is the end of the last turn, the permission cards, the spacer and the composer —
  // a few hundred pixels, never a screen. The first version of this property generated a tail of
  // view + 900 and stayed green against a client with the rule deleted.
  test("at the end of the scroller it is the LAST point, because the reading line cannot reach it", () => {
    fc.assert(
      fc.property(
        tops().filter((l) => l.length > 0),
        fc.integer({ min: 300, max: 1200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (list, view, share) => {
          const last = list[list.length - 1] ?? 0;
          // Everything below the last point: shorter than the window, so the point is on the final
          // screen, and deeper than the reading line, so the line is above it and cannot pass it.
          const tail = Math.round(share * (view - 100));
          const height = Math.max(last + tail, view + 1);
          expect(readingIndex(list, height - view, view, height)).toBe(list.length - 1);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("above the end it is the last point the reading line has passed", () => {
    fc.assert(
      fc.property(
        tops().filter((l) => l.length > 0),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 100, max: 1200 }),
        (list, top, view) => {
          const height = (list[list.length - 1] ?? 0) + view + 5000;
          const scrollTop = Math.min(top, height - view - 100);
          const at = readingIndex(list, scrollTop, view, height);
          const eye = scrollTop + 90;
          const passed = list.filter((t) => t <= eye).length;
          expect(at).toBe(passed === 0 ? 0 : passed - 1);
        },
      ),
      { numRuns: 500 },
    );
  });
});
