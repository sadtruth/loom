/**
 * The dock decision (SPEC 199, 184), as a property over every input that can reach it.
 *
 * Written as a property because the failure is a COMBINATION, not a value: the version of this
 * feature everybody writes first — dock on content alone — passes every hand-written case about a
 * draft, and breaks the commonest thing that happens in loom, which is typing an ordinary message
 * at the bottom of the transcript with the composer in plain sight. So the generators run densely
 * over the pairs that matter: the empty string, whitespace-only, an attachment with no words, and
 * anchor offsets either side of the 70px margin.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DOCK_MARGIN, away, dockState, written, type DockInput } from "../../client/dock.ts";

/** Drafts and non-drafts, including every shape of "looks like text and is not". */
const texts = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom("", " ", "\n", "\t\t", "  \n  ", "a", "hello", "  padded  ", "…", "тест"),
    fc.string({ maxLength: 40 }),
  );

/** The scroller's floor, and the spacer's top either side of it — densely around the margin. */
const geometry = (): fc.Arbitrary<{ anchorTop: number; viewBottom: number }> =>
  fc
    .record({
      viewBottom: fc.double({ min: 100, max: 2000, noNaN: true }),
      offset: fc.oneof(
        // Straddling the margin by a pixel at a time: this is where a wrong comparison hides.
        fc.integer({ min: DOCK_MARGIN - 4, max: DOCK_MARGIN + 4 }).map((n) => -n),
        fc.double({ min: -2000, max: 2000, noNaN: true }),
      ),
    })
    .map(({ viewBottom, offset }) => ({ viewBottom, anchorTop: viewBottom + offset }));

const inputs = (): fc.Arbitrary<DockInput> =>
  fc
    .record({
      text: texts(),
      attachments: fc.integer({ min: 0, max: 3 }),
      focused: fc.boolean(),
      height: fc.double({ min: 0, max: 800, noNaN: true }),
      geo: geometry(),
    })
    .map(({ text, attachments, focused, height, geo }) => ({
      text,
      attachments,
      focused,
      height,
      anchorTop: geo.anchorTop,
      viewBottom: geo.viewBottom,
    }));

describe("the composer docks on content AND distance, never on one of them", () => {
  test("docked ⟺ there is a draft and its place in the flow is gone", () => {
    fc.assert(
      fc.property(inputs(), (input) => {
        const state = dockState(input);
        const draft = written(input.text, input.attachments);
        const gone = away(input.anchorTop, input.viewBottom);
        expect(state.docked).toBe(draft && gone);
        // The two halves, stated separately because each is a defect somebody has shipped.
        if (!draft) expect(state.docked, "never docked and empty").toBe(false);
        if (!gone) expect(state.docked, "never docked while its own place is on screen").toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  test("focus is not part of the decision", () => {
    fc.assert(
      fc.property(inputs(), (input) => {
        expect(dockState({ ...input, focused: true }).docked).toBe(dockState({ ...input, focused: false }).docked);
      }),
      { numRuns: 1000 },
    );
  });

  test("whitespace is not a draft, and an attachment with no words is", () => {
    for (const text of ["", " ", "\n", "   \t "]) {
      expect(written(text, 0)).toBe(false);
      expect(written(text, 1), "a picture and no words is still a draft").toBe(true);
    }
    expect(written("a", 0)).toBe(true);
  });

  test("the pill and the docked bar are never on screen together", () => {
    fc.assert(
      fc.property(inputs(), (input) => {
        const state = dockState(input);
        expect(state.docked && state.pill).toBe(false);
        // The pill is the way back to a composer that is empty and out of view — nothing else.
        expect(state.pill).toBe(away(input.anchorTop, input.viewBottom) && !written(input.text, input.attachments));
      }),
      { numRuns: 2000 },
    );
  });

  test("the spacer holds exactly the composer's height, and only while docked", () => {
    fc.assert(
      fc.property(inputs(), (input) => {
        const state = dockState(input);
        expect(state.spacer).toBe(state.docked ? Math.max(0, input.height) : 0);
        // The height a four-line draft reaches is the height the spacer takes: measured, never
        // remembered from the moment of docking (SPEC 182).
        const taller = dockState({ ...input, height: input.height + 240 });
        if (taller.docked) expect(taller.spacer).toBe(input.height + 240);
      }),
      { numRuns: 2000 },
    );
  });

  test("the margin is real: one pixel either side of it decides", () => {
    const base = { text: "a draft", attachments: 0, focused: false, height: 100, viewBottom: 800 };
    expect(dockState({ ...base, anchorTop: 800 - DOCK_MARGIN - 1 }).docked, "still on screen").toBe(false);
    expect(dockState({ ...base, anchorTop: 800 - DOCK_MARGIN + 1 }).docked, "past the margin").toBe(true);
  });
});
