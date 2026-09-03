/**
 * PROPERTY PINS for file-pane highlighting (SPEC 144).
 *
 * The whole feature rests on one claim: highlighting changes how a file LOOKS and never what it
 * SAYS. So the properties are round-trips — strip the markup back off and you must get the file
 * back, line for line, byte for byte. That catches the failure mode a highlighter actually has:
 * spans crossing newlines, which a naive `split("\n")` turns into unbalanced tags and the browser
 * then re-nests, swallowing the rest of the file into one comment.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { escapeHtml, highlightLines, languageOf, splitLines } from "../../client/highlight.ts";

/** The inverse of what the renderer does: markup off, entities back to text. */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Real code shapes, not random noise: the crossing-newline cases are the ones that break. */
const SOURCES = [
  "const a = 1;\nlet b = 'two';\n",
  "/**\n * A block comment across\n * several lines.\n */\nexport function f(): void {}\n",
  "const s = `a template\nspanning lines ${x}`;\nconst t = 2;\n",
  "// <script>alert(1)</script>\nconst html = \"<div class='x'>&amp;</div>\";\n",
  "if (a < b && c > d) { return a & b; }\n",
  "\n\n\nconst afterBlankLines = true;\n",
  "no trailing newline",
  "",
];

describe("highlighting never changes the text", () => {
  test("every source round-trips, line for line", () => {
    for (const source of SOURCES) {
      const rows = highlightLines(source, "typescript");
      const expected = source.split("\n");
      expect(rows.length).toBe(expected.length);
      expect(rows.map(plain).join("\n")).toBe(source);
    }
  });

  test("an arbitrary file round-trips through every registered grammar it might get", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 400 }),
        fc.constantFrom("typescript", "python", "bash", "json", "markdown", "nix", "xml"),
        (text, language) => {
          const rows = highlightLines(text, language);
          expect(rows.length).toBe(text.split("\n").length);
          expect(rows.map(plain).join("\n")).toBe(text);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("an unknown language is escaped, not guessed at", () => {
    const rows = highlightLines("<b>&</b>\nplain", null);
    expect(rows).toEqual(["&lt;b&gt;&amp;&lt;/b&gt;", "plain"]);
  });

  test("every line's spans are balanced on their own", () => {
    for (const source of SOURCES) {
      for (const row of highlightLines(source, "typescript")) {
        const opened = (row.match(/<span/g) ?? []).length;
        const closed = (row.match(/<\/span>/g) ?? []).length;
        expect(opened).toBe(closed);
      }
    }
  });

  test("a span crossing a newline becomes one complete span per line", () => {
    const rows = splitLines('<span class="hljs-comment">/* one\ntwo */</span>');
    expect(rows).toEqual([
      '<span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two */</span>',
    ]);
  });

  test("nothing outside a span leaks a raw angle bracket", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        // Whatever the grammar does, the only tags in the output are spans.
        for (const row of highlightLines(text, "xml")) {
          expect(row.replace(/<\/?span[^>]*>/g, "")).not.toMatch(/[<>]/);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("a file's language comes from its name", () => {
  test("extensions, case-insensitively, and the extensionless cases", () => {
    expect(languageOf("/a/b/app.ts")).toBe("typescript");
    expect(languageOf("app.TSX")).toBe("typescript");
    expect(languageOf("/a/main.py")).toBe("python");
    expect(languageOf("/a/flake.nix")).toBe("nix");
    expect(languageOf("/a/Makefile")).toBe("bash");
    expect(languageOf("/a/.gitignore")).toBe("bash");
    // A file with a dot in its DIRECTORY only must not read that as an extension.
    expect(languageOf("/a/v1.2/README")).toBe(null);
    expect(languageOf("/a/notes.zzz")).toBe(null);
  });
});

describe("escaping", () => {
  test("the four characters that matter", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});
