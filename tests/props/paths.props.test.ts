/**
 * PROPERTY PINS for path extraction — the messy-input parser at the heart of the link fix.
 *
 * The stated rule: a path embedded in prose comes back out intact. That is a metamorphic property
 * (build -> embed -> extract must round-trip), which is what makes it stronger than any example I
 * would think to write: the generator builds paths with Cyrillic segments, spaces in directory
 * names, digits and dots, and drops them into sentences at arbitrary positions.
 *
 * The first regex written for this file truncated "/Users/user/docs/Projects/Personal Claude/…"
 * at the space — i.e. it failed on User's own vault path, the single most common path in his
 * transcripts. These properties exist so that class of failure cannot come back quietly.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { extractPaths, looksLikePath } from "../../client/paths.ts";

const segmentArb = fc.oneof(
  fc.constantFrom("docs", "Projects", "tools", "loom", "Areas", "Stream"),
  fc.constantFrom("Personal Claude", "My Notes", "Claude Shared"), // spaces in directory names
  fc.constantFrom("Заметки", "Проекты", "личное"), // Cyrillic
  fc.constantFrom("важные файлы", "мои проекты"), // both at once
);

const fileArb = fc
  .tuple(
    fc.constantFrom("SPEC", "ARCHITECTURE", "важный файл", "заметка", "index", "app.config"),
    fc.constantFrom("md", "ts", "json", "py", "txt", "jsonl"),
  )
  .map(([stem, ext]) => `${stem}.${ext}`);

const pathArb = fc
  .tuple(fc.constantFrom("/Users/user", "/home/user", "~"), fc.array(segmentArb, { maxLength: 4 }), fileArb)
  .map(([root, segments, file]) => [root, ...segments, file].join("/"));

const beforeArb = fc.constantFrom("", "see ", "the file ", "открой ", "look at (", "→ ");
const afterArb = fc.constantFrom("", " and more", ".", ", then", " — next", ")", " please");

describe("round-trip: an embedded path comes back intact", () => {
  test("single path in prose", () => {
    fc.assert(
      fc.property(pathArb, beforeArb, afterArb, (path, before, after) => {
        const found = extractPaths(`${before}${path}${after}`);
        expect(found.map((f) => f.path)).toEqual([path]);
      }),
      { numRuns: 600 },
    );
  });

  test("two paths in one sentence stay two", () => {
    fc.assert(
      fc.property(pathArb, pathArb, (a, b) => {
        const found = extractPaths(`compare ${a} with ${b} carefully`);
        expect(found.map((f) => f.path)).toEqual([a, b]);
      }),
      { numRuns: 400 },
    );
  });

  test("offsets address exactly the path in the source string", () => {
    fc.assert(
      fc.property(pathArb, beforeArb, afterArb, (path, before, after) => {
        const text = `${before}${path}${after}`;
        for (const match of extractPaths(text)) {
          expect(text.slice(match.start, match.end)).toBe(match.path);
        }
      }),
      { numRuns: 400 },
    );
  });
});

describe("extraction never over-reaches", () => {
  test("a path with no extension stops at the sentence", () => {
    expect(extractPaths("see /Users/user/docs and then go home").map((m) => m.path)).toEqual([
      "/Users/user/docs",
    ]);
  });

  test("a spaced directory is kept when more path follows", () => {
    expect(extractPaths("in /Users/user/docs/Projects/Personal Claude/tools now").map((m) => m.path)).toEqual([
      "/Users/user/docs/Projects/Personal Claude/tools",
    ]);
  });

  test("the vault path with a space and a file survives whole", () => {
    const path = "/Users/user/docs/Projects/Personal Claude/tools/loom/SPEC.md";
    expect(extractPaths(`open ${path} please`).map((m) => m.path)).toEqual([path]);
  });

  test("a Cyrillic path with a space survives whole", () => {
    const path = "/Users/user/docs/Заметки/важный файл.md";
    expect(extractPaths(`смотри ${path} — вот`).map((m) => m.path)).toEqual([path]);
  });

  test("never returns newlines or quotes", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (junk) => {
        for (const match of extractPaths(junk)) {
          expect(match.path).not.toMatch(/[\n<>"'`|]/u);
        }
      }),
      { numRuns: 500 },
    );
  });

  test("never throws, on anything", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (junk) => {
        expect(() => extractPaths(junk)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  test("bare roots are not chipped", () => {
    expect(extractPaths("/Users/ and /home/")).toEqual([]);
  });
});

describe("looksLikePath, for inline code spans", () => {
  test("accepts every generated absolute path", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(looksLikePath(path)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test("accepts project-relative paths with a known extension", () => {
    expect(looksLikePath("tools/loom/ARCHITECTURE.md")).toBe(true);
    expect(looksLikePath("server/main.ts")).toBe(true);
  });

  test("rejects prose and bare words", () => {
    expect(looksLikePath("npm install")).toBe(false);
    expect(looksLikePath("SPEC")).toBe(false);
    expect(looksLikePath("a and/or b")).toBe(false);
  });
});
