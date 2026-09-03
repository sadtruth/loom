/**
 * PROPERTY PINS for the navigating-links build — the three laws the link fixes rest on.
 *
 * Each is stated as a rule the generator hunts counterexamples for, and each one fails on the code
 * as it stood on 2026-08-19. They are here rather than in `paths.props.test.ts` because they are
 * about what the build CHANGED, and a reader coming back to the false-chip complaint should find
 * them together.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { extractPaths } from "../../client/paths.ts";
import { splitPlace } from "../../client/chips.ts";

const segmentArb = fc.oneof(
  fc.constantFrom("docs", "Projects", "tools", "loom", "Areas"),
  fc.constantFrom("Personal Claude", "My Notes"), // a space inside a directory name
  fc.constantFrom("Заметки", "личное"),
);

const pathArb = fc
  .tuple(
    fc.constantFrom("/home/user", "/Users/user", "~"),
    fc.array(segmentArb, { minLength: 1, maxLength: 4 }),
    fc.constantFrom("SPEC.md", "app.ts", "notes.md", "заметка.md", "data.jsonl"),
  )
  .map(([root, dirs, file]) => `${root}/${dirs.join("/")}/${file}`);

/**
 * **Extraction is idempotent under pasting.** Paths joined by any separator come back out as exactly
 * those paths — never merged, never truncated.
 *
 * This is the metamorphic form of User's complaint: *"sometimes a link is parsed out of my own
 * messages erroneously… when i copy something out of a terminal window into chat"*. The `" "` case
 * is the one that failed, and it failed by MERGING: `ls /home/user /home/spouse` produced one wide
 * chip spanning both, because the space before the second path read as part of a directory name.
 */
describe("extraction is idempotent under pasting", () => {
  test("a list of paths comes back as that list, whatever joins them", () => {
    fc.assert(
      fc.property(
        fc.array(pathArb, { minLength: 1, maxLength: 4 }),
        fc.constantFrom(" ", "  ", "\n", ", ", " and ", " && ", "; "),
        (paths, join) => {
          const found = extractPaths(paths.join(join)).map((m) => m.path);
          expect(found).toEqual(paths);
        },
      ),
      { numRuns: 400 },
    );
  });

  test("one path in prose is still one path", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(extractPaths(`see ${path} for the detail`).map((m) => m.path)).toEqual([path]);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * **A known directory only ever lengthens a path.** The tiebreak that settles a space inside the
 * FINAL segment may correct a boundary; it may never invent one, and it may never swallow prose the
 * segment walk kept out.
 *
 * The oracle is free: the same extraction with an EMPTY list of known directories is what the walk
 * alone decides, so "never shorter, and always a prefix-superset" is checkable without writing down
 * an expected answer.
 */
describe("a known directory only ever lengthens a path", () => {
  test("the answer with a table is a prefix-superset of the answer without one", () => {
    fc.assert(
      fc.property(
        pathArb,
        fc.array(fc.constantFrom("/home/user/docs/Projects/Personal Claude", "/Users/user/My Notes", "/home/user"), {
          maxLength: 3,
        }),
        fc.constantFrom("", " and then some prose", ". Next sentence.", " — see also"),
        (path, known, tail) => {
          const text = `look at ${path}${tail}`;
          const bare = extractPaths(text).map((m) => m.path);
          const withTable = extractPaths(text, known).map((m) => m.path);
          expect(withTable.length).toBe(bare.length);
          for (let i = 0; i < bare.length; i += 1) {
            const before = bare[i] ?? "";
            const after = withTable[i] ?? "";
            expect(after.length).toBeGreaterThanOrEqual(before.length);
            expect(after.startsWith(before)).toBe(true);
            // And it can never reach past what was actually written.
            expect(text.includes(after)).toBe(true);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

/**
 * **The place survives the round trip.** For any path and any place, writing the place onto the path
 * and reading it back returns the same pair.
 *
 * It failed for EVERY place before this build — not in `splitPlace`, which was right, but one layer
 * up, where the place was glued to the filename in the address. The unit half is here; the reload
 * half is `journey31-link-kinds`, because only a browser can prove it survived one.
 */
describe("the place survives the round trip", () => {
  const placeArb = fc.oneof(
    fc.integer({ min: 1, max: 9999 }).map((n) => ({ text: `:${n}`, expect: { line: n } })),
    fc
      .tuple(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 80 }))
      .map(([n, col]) => ({ text: `:${n}:${col}`, expect: { line: n } })),
    fc
      .tuple(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 501, max: 900 }))
      .map(([a, b]) => ({ text: `:${a}-${b}`, expect: { line: a, endLine: b } })),
    fc.constantFrom("frame", "next-steps", "path-chips").map((h) => ({ text: `#${h}`, expect: { heading: h } })),
    fc.integer({ min: 1, max: 99 }).map((n) => ({ text: `#next ${n}`, expect: { heading: `next ${n}` } })),
  );

  test("path + place, split, is the path and the place", () => {
    fc.assert(
      fc.property(pathArb, placeArb, (path, place) => {
        const split = splitPlace(`${path}${place.text}`);
        expect(split.path).toBe(path);
        expect(split.place).toEqual(place.expect);
      }),
      { numRuns: 400 },
    );
  });

  test("a path with no place keeps its whole self", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(splitPlace(path)).toEqual({ path, place: null });
      }),
      { numRuns: 200 },
    );
  });
});
