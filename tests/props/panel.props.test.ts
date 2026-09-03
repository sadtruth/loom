/**
 * The project panel's three filters (SPEC 88–93).
 *
 * Three rules that each REMOVE rows compose into one set, and the interesting failures are all
 * emergent: a hole in the tree where an ancestor was filtered out from under its child, a count
 * that names a record sitting in plain sight, a focus quietly overruled by the recency window.
 * None of those is reachable by picking cases by hand, which is why they are stated as properties.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FINISHED, RECENT_MS, treeView, type PanelRecord } from "../../client/panel.ts";

const NOW = 1_800_000_000_000;
const STATUSES = ["active", "framing", "parked", "done", "abandoned"];

/**
 * A forest of records with real `parent:` edges. Built by giving record i a parent drawn from
 * {roots} ∪ {0..i-1}, so it is acyclic by construction and every depth is reachable — the shapes
 * the panel has to keep connected.
 */
const forest = fc
  .array(
    fc.record({
      status: fc.constantFrom(...STATUSES),
      // Densely across the recency boundary: half the generated ages land within a day of it.
      age: fc.oneof(
        fc.integer({ min: RECENT_MS - 86_400_000, max: RECENT_MS + 86_400_000 }),
        fc.integer({ min: 0, max: 90 * 86_400_000 }),
      ),
      parentIndex: fc.integer({ min: -1, max: 24 }),
    }),
    { minLength: 1, maxLength: 25 },
  )
  .map((rows): PanelRecord[] =>
    rows.map((row, index) => ({
      path: `/p/${index}/project.md`,
      status: row.status,
      // Only a STRICTLY earlier index may be a parent, so no cycle exists to generate.
      parent: row.parentIndex >= 0 && row.parentIndex < index ? `/p/${row.parentIndex}/project.md` : null,
      mtime: NOW - row.age,
    })),
  );

interface Toggles {
  showOlder: boolean;
  showFinished: boolean;
  focusIndex: number;
  activeIndex: number;
}

const options: fc.Arbitrary<Toggles> = fc.record({
  showOlder: fc.boolean(),
  showFinished: fc.boolean(),
  focusIndex: fc.integer({ min: -1, max: 24 }),
  activeIndex: fc.integer({ min: -1, max: 24 }),
});

/** Bind generated indices to real paths — an index past the end becomes "no focus", which is also
 *  the real case of a focus surviving in localStorage after its record left the scan. */
function view(records: PanelRecord[], o: Toggles) {
  return treeView(records, {
    now: NOW,
    focus: o.focusIndex >= 0 && o.focusIndex < records.length ? records[o.focusIndex]!.path : null,
    showOlder: o.showOlder,
    showFinished: o.showFinished,
    active: o.activeIndex >= 0 && o.activeIndex < records.length ? records[o.activeIndex]!.path : null,
  });
}

describe("panel filters", () => {
  /**
   * Property 23 — THE VISIBLE SET IS ANCESTOR-CLOSED, under every combination of the three filters.
   *
   * This is the one that cannot be checked by looking. Each filter is written as "drop these rows",
   * and dropping a row whose child survives leaves a child rendered at depth 2 under nothing —
   * a tree with a hole in it. Stated once here, it covers all eight toggle combinations forever.
   */
  test("every visible record's parent is visible too", () => {
    fc.assert(
      fc.property(forest, options, (records, o) => {
        const known = new Set(records.map((r) => r.path));
        const byPath = new Map(records.map((r) => [r.path, r]));
        const { visible } = view(records, o);
        for (const path of visible) {
          const parent = byPath.get(path)?.parent;
          if (parent === null || parent === undefined || !known.has(parent)) continue;
          expect(visible.has(parent)).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  /**
   * Property 24 — FOCUS BEATS RECENCY (metamorphic: two runs of the same forest, related).
   *
   * The decision the frame made explicit, stated as a relationship rather than a claim about one
   * output, so it cannot be satisfied by a fixture that happens to be recent. Whatever a record's
   * age, focusing an ancestor of it must show it — the recency filter is not running at all.
   */
  test("a focused project's unfinished descendants show at any age", () => {
    fc.assert(
      fc.property(forest, fc.integer({ min: 0, max: 24 }), fc.boolean(), (records, pick, showFinished) => {
        const focus = records[pick % records.length]!;
        const { visible } = treeView(records, {
          now: NOW,
          focus: focus.path,
          showOlder: false, // recency at its STRICTEST — and still overruled
          showFinished,
          active: null,
        });
        const kids = new Map<string, PanelRecord[]>();
        for (const r of records) if (r.parent !== null) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r]);
        const walk = (path: string): void => {
          for (const kid of kids.get(path) ?? []) {
            if (showFinished || !FINISHED.has(kid.status)) expect(visible.has(kid.path)).toBe(true);
            walk(kid.path);
          }
        };
        walk(focus.path);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Property 25 — THE COUNTS DO NOT LIE, in either direction.
   *
   * Every record is either on screen or counted exactly once as hidden. The failure this catches is
   * the natural way to write it: count what the filter dropped, then hand some of them back as
   * ancestors, and the panel offers "+3 finished" over a list where two of the three are visible.
   */
  test("hidden counts sum to exactly what is off screen, and never double-count", () => {
    fc.assert(
      fc.property(forest, options, (records, o) => {
        const v = view(records, o);
        const offScreen = records.filter((r) => !v.visible.has(r.path)).length;
        expect(v.hiddenOlder + v.hiddenFinished + v.hiddenUnfocused).toBe(offScreen);
        // Recency stands down under a focus, so a count from it would be a fiction (SPEC 90).
        if (v.focus !== null) expect(v.hiddenOlder).toBe(0);
        else expect(v.hiddenUnfocused).toBe(0);
        // Nothing is claimed hidden as finished unless it really is over.
        if (o.showFinished) expect(v.hiddenFinished).toBe(0);
      }),
      { numRuns: 400 },
    );
  });

  /** Property 26 — where he is STANDING is never filtered away. A deep link must survive any state. */
  test("the active record is always visible", () => {
    fc.assert(
      fc.property(forest, options, fc.integer({ min: 0, max: 24 }), (records, o, pick) => {
        const active = records[pick % records.length]!;
        const { visible } = view(records, { ...o, activeIndex: records.indexOf(active) });
        expect(visible.has(active.path)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  /** A focus naming nothing degrades to no focus — never to an empty panel. */
  test("a focus the scan no longer returns is ignored, not obeyed", () => {
    const records: PanelRecord[] = [{ path: "/a/project.md", status: "active", parent: null, mtime: NOW }];
    const v = treeView(records, {
      now: NOW,
      focus: "/gone/project.md",
      showOlder: false,
      showFinished: false,
      active: null,
    });
    expect(v.focus).toBeNull();
    expect(v.visible.has("/a/project.md")).toBe(true);
  });

  /** The stated case behind the fold: a finished parent still holding live work stays on screen. */
  test("a done parent with an unfinished child is not folded away", () => {
    const records: PanelRecord[] = [
      { path: "/a/project.md", status: "done", parent: null, mtime: NOW },
      { path: "/a/b/project.md", status: "active", parent: "/a/project.md", mtime: NOW },
    ];
    const v = treeView(records, { now: NOW, focus: null, showOlder: false, showFinished: false, active: null });
    expect(v.visible.has("/a/project.md")).toBe(true);
    expect(v.hiddenFinished).toBe(0);
  });
});
