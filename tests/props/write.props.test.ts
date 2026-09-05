import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { decide, writable, guardFrom } from "../../server/files.ts";
import { spliceBlock } from "../../client/filepane.ts";
import { sep } from "node:path";

const guard = guardFrom("/vault:/home/user/.claude", "/vault");

const junkArb = fc.array(
  fc.constantFrom("..", ".", "notes", "sub dir", "Заметки", "a.md", "..%2f", "...", "//", "\\", "-", "Diary", "Archive", ".git", "Highlights"),
  { maxLength: 10 },
).map((a) => a.join(sep));

describe("write guards", () => {
  test("writable() is a strict subset of decide()", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), junkArb),
        (raw) => {
          const w = writable(guard, raw);
          if (w.ok) {
            const d = decide(guard, raw);
            expect(d.ok).toBe(true);
            if (d.ok) {
              expect(w.path).toBe(d.path);
            }
          }
        }
      )
    );
  });

  test("no path containing restricted segments is ever writable", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), junkArb),
        (raw) => {
          const w = writable(guard, raw);
          if (w.ok) {
             const segments = w.path.split(sep);
             expect(segments.includes("Diary")).toBe(false);
             expect(segments.includes("Archive")).toBe(false);
             expect(segments.includes(".git")).toBe(false);

             let hasHighlights = false;
             for (let i = 0; i < segments.length - 2; i++) {
               if (segments[i] === "Garden" && segments[i+1] === "Sources" && segments[i+2] === "Highlights") {
                 hasHighlights = true;
               }
             }
             expect(hasHighlights).toBe(false);
          }
        }
      )
    );
  });
});

describe("spliceBlock", () => {
  const lineArb = fc.string({ maxLength: 100 }).map(s => s.replace(/\n/g, ""));
  const textArb = fc.array(lineArb, { maxLength: 20 }).map(lines => lines.join("\n"));

  test("replacing a block with its own text returns the source byte-for-byte", () => {
    fc.assert(
      fc.property(
        textArb,
        fc.boolean(),
        (text, addTrailing) => {
          const source = addTrailing ? text + "\n" : text;

          const lines = source.split("\n");
          const len = lines.length;

          const start = Math.floor(Math.random() * len) + 1;
          const end = Math.max(start, Math.floor(Math.random() * len) + 1);

          const blockText = lines.slice(start - 1, end).join("\n");
          const spliced = spliceBlock(source, start, end, blockText);
          expect(spliced).toBe(source);
        }
      )
    );
  });

  test("empty file and exactly one newline edge cases", () => {
    expect(spliceBlock("", 1, 1, "")).toBe("");
    expect(spliceBlock("\n", 1, 1, "")).toBe("\n");
    expect(spliceBlock("\n", 1, 2, "\n")).toBe("\n");
  });

  test("line count equals original minus span plus replacement lines", () => {
    fc.assert(
      fc.property(
        textArb,
        textArb,
        fc.boolean(),
        (text, replacement, addTrailing) => {
          const source = addTrailing ? text + "\n" : text;

          const lines = source.split("\n");
          const len = lines.length;
          const start = Math.floor(Math.random() * len) + 1;
          const end = Math.max(start, Math.floor(Math.random() * len) + 1);

          const spanLen = end - start + 1;

          const spliced = spliceBlock(source, start, end, replacement);

          const splicedLines = spliced.split("\n");
          const repLines = replacement.split("\n");

          expect(splicedLines.length).toBe(lines.length - spanLen + repLines.length);
        }
      )
    );
  });

  test("splicing is associative over non-overlapping spans applied bottom-up", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 10, maxLength: 50 }).map(lines => lines.join("\n")),
        lineArb,
        lineArb,
        fc.boolean(),
        (text, rep1, rep2, addTrailing) => {
          const source = addTrailing ? text + "\n" : text;

          // non-overlapping spans
          const lines = source.split("\n");
          const len = lines.length;

          const start1 = 1;
          const end1 = 2;

          const start2 = len - 1;
          const end2 = len;

          // top down
          const splicedTopFirst = spliceBlock(source, start1, end1, rep1);
          const rep1Lines = rep1.split("\n");
          const shift = rep1Lines.length - (end1 - start1 + 1);
          const topDownBoth = spliceBlock(splicedTopFirst, start2 + shift, end2 + shift, rep2);

          // bottom up
          const splicedBottomFirst = spliceBlock(source, start2, end2, rep2);
          const bottomUpBoth = spliceBlock(splicedBottomFirst, start1, end1, rep1);

          expect(topDownBoth).toBe(bottomUpBoth);
        }
      )
    );
  });
});
