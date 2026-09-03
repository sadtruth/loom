import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { recordsWithStaleness } from "../../server/records.ts";

/**
 * A tree generator for testing staleness. Each node i can pick its parent from {0..i-1}.
 */
const forest = fc
  .array(
    fc.record({
      mtime: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    }),
    { maxLength: 50 },
  )
  .map((nodes) => {
    return nodes.map((node, i) => ({
      path: `node-${i}`,
      parent: i === 0 ? null : `node-${Math.floor(Math.random() * i)}`,
      mtime: node.mtime,
    }));
  });

describe("recordsWithStaleness", () => {
  test("Property 1: One fresh leaf keeps every ancestor fresh, at any depth", () => {
    // To fail this: do not propagate maxMtime to ancestors
    fc.assert(
      fc.property(forest, (tree) => {
        if (tree.length === 0) return;
        const derived = recordsWithStaleness(tree);
        const byPath = new Map(derived.map((r) => [r.path, r]));

        for (const record of derived) {
          let cursor = record.parent ? byPath.get(record.parent) : undefined;
          while (cursor) {
            expect(cursor.derivedMtime).toBeGreaterThanOrEqual(record.derivedMtime);
            cursor = cursor.parent ? byPath.get(cursor.parent) : undefined;
          }
        }
      }),
    );
  });

  test("Property 2: A record with no sessions falls back to its own mtime and nothing else (when no children)", () => {
    // To fail this: node.derivedMtime = maxMtime + 1
    fc.assert(
      fc.property(forest, (tree) => {
        const derived = recordsWithStaleness(tree);
        const isParent = new Set(derived.map((r) => r.parent).filter((p) => p !== null));
        for (const record of derived) {
          if (!isParent.has(record.path)) {
            expect(record.derivedMtime).toBe(record.mtime);
          }
        }
      }),
    );
  });

  test("Property 3: The derivation is independent of the order records are given in", () => {
    // To fail this: iterate sequentially without doing a full DFS, e.g. `for (const r of records) r.derivedMtime = Math.max(r.mtime, byPath.get(r.parent)?.derivedMtime || 0)`
    fc.assert(
      fc.property(forest, (tree) => {
        const shuffled = [...tree].sort(() => 0.5 - Math.random()); // simple shuffle
        const derived1 = recordsWithStaleness(tree);
        const derived2 = recordsWithStaleness(shuffled);

        const map1 = new Map(derived1.map((r) => [r.path, r.derivedMtime]));
        const map2 = new Map(derived2.map((r) => [r.path, r.derivedMtime]));

        for (const [path, time] of map1) {
          expect(map2.get(path)).toBe(time);
        }
      }),
    );
  });

  test("Property 4: A cycle or a broken parent link cannot hang or crash it", () => {
    // To fail this: remove cycle tracking (`computing` set) in `compute()` or use infinite recursion
    const tree = [
      { path: "A", parent: "B", mtime: 100 },
      { path: "B", parent: "C", mtime: 200 },
      { path: "C", parent: "A", mtime: 300 }, // cycle
      { path: "D", parent: "missing", mtime: 400 }, // broken link
    ];
    const derived = recordsWithStaleness(tree);
    const map = new Map(derived.map((r) => [r.path, r.derivedMtime]));

    // They are in a cycle. C is 300, so A and B should also be 300.
    expect(map.get("A")).toBe(300);
    expect(map.get("B")).toBe(300);
    expect(map.get("C")).toBe(300);
    expect(map.get("D")).toBe(400); // broken parent treated as root
  });

  test("Property 5: Each record's freshness is at least its own mtime", () => {
    // To fail this: node.derivedMtime = 0
    fc.assert(
      fc.property(forest, (tree) => {
        const derived = recordsWithStaleness(tree);
        for (const record of derived) {
          expect(record.derivedMtime).toBeGreaterThanOrEqual(record.mtime);
        }
      }),
    );
  });
});
