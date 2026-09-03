/**
 * The image viewer's geometry (SPEC §117/§118).
 *
 * These are stated as properties because the defect they guard is a RELATIONSHIP between two views,
 * not a value in one. "Zooming drifts off what I pointed at" looks fine in any single screenshot;
 * it only exists as "the image point under the pointer moved". A hand-written case would also have
 * to guess the anchor, the scale and the aspect ratio that break it, and the interesting ones are
 * all at the boundaries — at fit exactly, at the scale ceiling, on an image narrower than the
 * window but taller than it.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  clampView,
  fitFrame,
  initialView,
  MAX_SCALE,
  panBy,
  toImage,
  zoomAt,
  zoomRaw,
  type Frame,
  type View,
} from "../../client/zoom-math.ts";

const px = (): fc.Arbitrary<number> => fc.double({ min: -4000, max: 4000, noNaN: true });

/**
 * Windows and images across the shapes that actually differ: an image wider than the window, taller
 * than it, smaller in both, and the exact-fit case where `rw === w` and the clamp branch flips.
 */
const frames = (): fc.Arbitrary<Frame> =>
  fc
    .record({
      w: fc.double({ min: 200, max: 3000, noNaN: true }),
      h: fc.double({ min: 200, max: 3000, noNaN: true }),
      natW: fc.oneof(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 200, max: 6000 })),
      natH: fc.oneof(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 200, max: 6000 })),
    })
    .map(({ w, h, natW, natH }) => fitFrame(natW, natH, w, h));

/** Views reachable in the viewer: scale inside the band, offsets anywhere a drag could have put them. */
const views = (): fc.Arbitrary<View> =>
  fc.record({
    s: fc.double({ min: 1, max: MAX_SCALE, noNaN: true }),
    x: px(),
    y: px(),
  });

const near = (a: number, b: number, tolerance = 1e-6): boolean =>
  Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));

describe("zoom geometry", () => {
  /**
   * THE load-bearing one. Everything else here is containment bookkeeping; this is the feature.
   * A viewer that scaled about the window's centre — the thing you write if you are not thinking
   * about it — fails this on the first generated case where the anchor is not the centre.
   */
  test("the image point under the pointer is a fixed point of a zoom", () => {
    fc.assert(
      fc.property(views(), fc.double({ min: 0.05, max: 20, noNaN: true }), px(), px(), (view, factor, ax, ay) => {
        const before = toImage(view, ax, ay);
        const after = toImage(zoomRaw(view, factor, ax, ay), ax, ay);
        expect(near(after.ix, before.ix)).toBe(true);
        expect(near(after.iy, before.iy)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  /** …and the anchoring must survive the wrapper, not just the raw map — at every scale below the ceiling. */
  test("zoomAt anchors too, wherever the clamp is not the thing deciding", () => {
    fc.assert(
      fc.property(frames(), views(), fc.double({ min: 0.2, max: 5, noNaN: true }), px(), px(), (frame, v0, k, ax, ay) => {
        const view = clampView(v0, frame);
        const next = zoomAt(view, frame, k, ax, ay);
        // Only where the result is genuinely free: at the scale rails there is no factor to grant,
        // and where an axis is being centred or held against an edge the clamp owns the answer.
        const rw = frame.bw * next.s;
        const rh = frame.bh * next.s;
        const freeX = rw > frame.w && next.x < -1e-9 && next.x > frame.w - rw + 1e-9;
        const freeY = rh > frame.h && next.y < -1e-9 && next.y > frame.h - rh + 1e-9;
        if (next.s <= 1 + 1e-9 || next.s >= MAX_SCALE - 1e-9) return;
        const before = toImage(view, ax, ay);
        const after = toImage(next, ax, ay);
        if (freeX) expect(near(after.ix, before.ix, 1e-5)).toBe(true);
        if (freeY) expect(near(after.iy, before.iy, 1e-5)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  /**
   * The image can never be dragged somewhere you cannot see it. Two-sided by construction: bigger
   * than the window means no gap at either edge, smaller means exactly centred — a clamp that only
   * did the first half would leave a small image pinned to a corner.
   */
  test("a clamped view always covers the window, or sits centred in it", () => {
    fc.assert(
      fc.property(frames(), views(), (frame, view) => {
        const out = clampView(view, frame);
        const rw = frame.bw * out.s;
        const rh = frame.bh * out.s;
        if (rw >= frame.w) {
          expect(out.x).toBeLessThanOrEqual(1e-9);
          expect(out.x + rw).toBeGreaterThanOrEqual(frame.w - 1e-9);
        } else {
          expect(near(out.x, (frame.w - rw) / 2)).toBe(true);
        }
        if (rh >= frame.h) {
          expect(out.y).toBeLessThanOrEqual(1e-9);
          expect(out.y + rh).toBeGreaterThanOrEqual(frame.h - 1e-9);
        } else {
          expect(near(out.y, (frame.h - rh) / 2)).toBe(true);
        }
      }),
      { numRuns: 2000 },
    );
  });

  /** Clamping is a position, not a nudge: applying it twice must say the same thing as once. */
  test("clampView is idempotent", () => {
    fc.assert(
      fc.property(frames(), views(), (frame, view) => {
        const once = clampView(view, frame);
        const twice = clampView(once, frame);
        expect(near(twice.x, once.x)).toBe(true);
        expect(near(twice.y, once.y)).toBe(true);
        expect(twice.s).toBe(once.s);
      }),
      { numRuns: 1000 },
    );
  });

  /**
   * Panning is locked at fit. Stated as a metamorphic rule over an arbitrary drag rather than a
   * single "drag right does nothing" case, so it cannot be satisfied by a special case for zero.
   */
  test("a drag at fit moves nothing, however far it goes", () => {
    fc.assert(
      fc.property(frames(), px(), px(), (frame, dx, dy) => {
        const rest = initialView(frame);
        const dragged = panBy(rest, frame, dx, dy);
        expect(near(dragged.x, rest.x)).toBe(true);
        expect(near(dragged.y, rest.y)).toBe(true);
        expect(dragged.s).toBe(rest.s);
      }),
      { numRuns: 1000 },
    );
  });

  /** No wheel spin, however long, leaves the band — and none of it changes scale on a pan. */
  test("scale stays within [1, MAX_SCALE] under any sequence of zooms and pans", () => {
    fc.assert(
      fc.property(
        frames(),
        fc.array(
          fc.record({
            factor: fc.double({ min: 0.1, max: 10, noNaN: true }),
            ax: px(),
            ay: px(),
            dx: px(),
            dy: px(),
            pan: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (frame, steps) => {
          let view = initialView(frame);
          for (const step of steps) {
            const before = view.s;
            view = step.pan
              ? panBy(view, frame, step.dx, step.dy)
              : zoomAt(view, frame, step.factor, step.ax, step.ay);
            if (step.pan) expect(view.s).toBe(before);
            expect(view.s).toBeGreaterThanOrEqual(1 - 1e-9);
            expect(view.s).toBeLessThanOrEqual(MAX_SCALE + 1e-9);
            expect(Number.isFinite(view.x)).toBe(true);
            expect(Number.isFinite(view.y)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  /** Contain, and never enlarge: the resting size fits the window and is never bigger than the file. */
  test("fitFrame contains without upscaling", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8000 }),
        fc.integer({ min: 1, max: 8000 }),
        fc.double({ min: 100, max: 3000, noNaN: true }),
        fc.double({ min: 100, max: 3000, noNaN: true }),
        (natW, natH, w, h) => {
          const frame = fitFrame(natW, natH, w, h);
          expect(frame.bw).toBeLessThanOrEqual(w + 1e-9);
          expect(frame.bh).toBeLessThanOrEqual(h + 1e-9);
          expect(frame.bw).toBeLessThanOrEqual(natW + 1e-9);
          expect(frame.bh).toBeLessThanOrEqual(natH + 1e-9);
          // Aspect ratio is preserved — a contain that stretched would satisfy every bound above.
          expect(near(frame.bw / frame.bh, natW / natH, 1e-9)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  /** A broken or still-decoding image reports 0×0; the viewer must open, not divide by zero. */
  test("fitFrame survives an image with no natural size", () => {
    const frame = fitFrame(0, 0, 1440, 900);
    expect(Number.isFinite(frame.bw)).toBe(true);
    expect(frame.bw).toBeGreaterThan(0);
    const rest = initialView(frame);
    expect(Number.isFinite(rest.x)).toBe(true);
  });
});
