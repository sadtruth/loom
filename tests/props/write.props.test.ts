import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { guardFrom, decide, writable } from "../../server/files.ts";
import { spliceBlock } from "../../client/filepane.ts";

const guard = guardFrom(undefined, "/vault");
const junkArb = fc.array(fc.string({ minLength: 1 }).filter((s) => !s.includes("\0") && !s.includes("/") && s !== ".." && s !== "."), { maxLength: 10 });

describe("writable() logic", () => {
  test("writable is a strict subset of readable", () => {
    fc.assert(
      fc.property(junkArb, (parts) => {
        const path = `/vault/${parts.join("/")}`;
        const canWrite = writable(guard, path);
        const canRead = decide(guard, path);
        if (canWrite.ok) {
          expect(canRead.ok).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("no path containing Diary, Archive, Highlights or .git segment is ever writable", () => {
    for (const bad of [
      "/vault/Diary/note.md",
      "/vault/sub/Archive/old.md",
      "/vault/Garden/Sources/Highlights/book.md",
      "/vault/.git/config.txt",
    ]) {
      const w = writable(guard, bad);
      expect(w.ok).toBe(false);
      // .git gets refused by decide() as "denied location" first
      if (!w.ok) expect(["read-only location", "denied location"]).toContain(w.reason);
    }
  });

  test("a normal note in a root is writable", () => {
    const w = writable(guard, "/vault/Areas/Health/README.md");
    expect(w.ok).toBe(true);
  });

  test("non-writable extensions are refused", () => {
    expect(writable(guard, "/vault/script.ts").ok).toBe(false);
    expect(writable(guard, "/vault/image.png").ok).toBe(false);
    expect(writable(guard, "/vault/Areas/Health/README.markdown").ok).toBe(true);
    expect(writable(guard, "/vault/Areas/Health/notes.txt").ok).toBe(true);
  });
});

describe("spliceBlock()", () => {
  const fileArb = fc.array(fc.string({ maxLength: 50 }), { minLength: 1 }).map(lines => lines.join("\n"));

  test("replacing a block with its own text returns the source byte-for-byte", () => {
    fc.assert(
      fc.property(fileArb, fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), (source, start, end) => {
        const fromLine = Math.min(start, end);
        const toLine = Math.max(start, end);
        const lines = source.split("\n");
        if (fromLine > lines.length) return;

        const endLine = Math.min(toLine, lines.length);
        const replacement = lines.slice(fromLine - 1, endLine).join("\n");
        const spliced = spliceBlock(source, fromLine, endLine, replacement);
        expect(spliced).toBe(source);
      }),
      { numRuns: 300 }
    );
  });

  test("line count equals original minus span plus replacement's lines", () => {
    fc.assert(
      fc.property(fileArb, fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), fc.string(), (source, start, end, replacement) => {
        const fromLine = Math.min(start, end);
        const toLine = Math.max(start, end);
        const lines = source.split("\n");
        if (fromLine > lines.length) return;

        const endLine = Math.min(toLine, lines.length);
        const spliced = spliceBlock(source, fromLine, endLine, replacement);
        const origCount = lines.length;
        const spanCount = endLine - fromLine + 1;
        const replCount = replacement.split("\n").length;
        expect(spliced.split("\n").length).toBe(origCount - spanCount + replCount);
      }),
      { numRuns: 300 }
    );
  });

  test("splicing is associative over non-overlapping spans applied bottom-up", () => {
    fc.assert(
      fc.property(
        fileArb,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 6, max: 10 }),
        fc.integer({ min: 11, max: 15 }),
        fc.integer({ min: 16, max: 20 }),
        fc.string(),
        fc.string(),
        (source, aStart, aEnd, bStart, bEnd, replA, replB) => {
          const lines = source.split("\n");
          if (bEnd > lines.length) return;

          // Apply bottom-up (B then A)
          const step1 = spliceBlock(source, bStart, bEnd, replB);
          const bottomUp = spliceBlock(step1, aStart, aEnd, replA);

          // Apply top-down (A then B) - we have to adjust B's coordinates because A changed the line count
          const step1Top = spliceBlock(source, aStart, aEnd, replA);
          const aLineDiff = replA.split("\n").length - (aEnd - aStart + 1);
          const topDown = spliceBlock(step1Top, bStart + aLineDiff, bEnd + aLineDiff, replB);

          expect(bottomUp).toBe(topDown);
        }
      ),
      { numRuns: 300 }
    );
  });
});
