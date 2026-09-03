/**
 * Properties for the link audit (build plan `link-audit-2026-08-24`, Code validation).
 *
 * The audit's job is to be believed, so the two parts that are not the product itself — the
 * harvester and the click/landing model — get stated rules rather than remembered cases. The
 * renderer is not tested here: it IS loom's, and testing it would be testing `renderMarkdown` twice.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mightCarryALink, postedIn } from "../audit/harvest.ts";
import { family, judge, slug, type ChipFacts, type ServerAnswer } from "../audit/verdict.ts";

const chip = (over: Partial<ChipFacts>): ChipFacts => ({
  raw: "/a/b.md",
  path: "/a/b.md",
  place: null,
  label: "b.md",
  fixed: false,
  wiki: false,
  isRecord: false,
  recordItems: null,
  ...over,
});

const answer = (over: Partial<ServerAnswer>): ServerAnswer => ({
  status: 200,
  reason: "",
  kind: "text",
  lines: 100,
  headings: null,
  ...over,
});

describe("harvest", () => {
  test("a transcript of arbitrary junk never throws and never yields an empty message", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 40 }), (lines) => {
        const posted = postedIn("s", "p", lines.join("\n"));
        for (const one of posted) expect(one.text.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  test("a real assistant row is harvested with its text intact", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => !s.includes("\n") && s.trim().length > 0), (text) => {
        const row = JSON.stringify({
          type: "assistant",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2026-08-24T00:00:00Z",
          cwd: "/tmp",
          sessionId: "s",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
        // The trailing newline is not decoration: `TranscriptParser.push` holds back everything
        // after the last one, so a row without it is a half-written line and yields nothing.
        const posted = postedIn("s", "p", `${row}\n`);
        expect(posted.map((p) => p.text)).toEqual([text]);
      }),
      { numRuns: 200 },
    );
  });

  test("any text holding a slash is worth rendering — the pre-filter can only drop link-free text", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        if (text.includes("/") || text.includes("[[")) expect(mightCarryALink(text)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("the click model", () => {
  test("a labelled chip whose path still ends in a place suffix is always the un-split bug", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999 }),
        fc.constantFrom("/a/b.md", "/x/y/project.md", "/deep/a b/c.ts"),
        (line, file) => {
          const path = `${file}:${line}`;
          const verdict = judge(chip({ path, raw: path, fixed: true }), answer({ status: 400, reason: "not found" }));
          expect(verdict.cause).toBe("place-never-split");
        },
      ),
      { numRuns: 200 },
    );
  });

  // REWRITTEN 2026-08-25 (SPEC 243). It used to assert that a line in a rendered markdown file can
  // NEVER land, which was the product's behaviour when the audit was written and stopped being true
  // the day the fix shipped — the model has to measure the product it now has, not the one it found.
  test("a line in a rendered markdown file lands, and misses only past the end", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (line, lines) => {
        const verdict = judge(chip({ place: `:${line}` }), answer({ kind: "markdown", lines, headings: ["a"] }));
        expect(verdict.cause).toBe(line > lines ? "line-past-end" : "ok");
      }),
      { numRuns: 200 },
    );
  });

  test("a line in a rendered markdown file of unknown length is never called broken", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99999 }), (line) => {
        const verdict = judge(
          chip({ place: `:${line}` }),
          answer({ kind: "markdown", lines: null, headings: ["a"] }),
        );
        expect(verdict.cause).toBe("ok");
      }),
      { numRuns: 200 },
    );
  });

  test("a line inside a text file lands exactly when the file is long enough", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 5000 }), (line, lines) => {
        const verdict = judge(chip({ place: `:${line}` }), answer({ kind: "text", lines }));
        expect(verdict.cause).toBe(line > lines ? "line-past-end" : "ok");
      }),
      { numRuns: 400 },
    );
  });

  test("a heading lands exactly when the rendered file has one that slugs the same", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (heading) => {
        const want = slug(heading);
        fc.pre(want.length > 0);
        const hit = judge(chip({ place: `#${heading}` }), answer({ kind: "markdown", headings: [want] }));
        const miss = judge(chip({ place: `#${heading}` }), answer({ kind: "markdown", headings: [] }));
        expect(hit.cause).toBe("ok");
        expect(miss.cause).toBe("heading-not-found");
      }),
      { numRuns: 300 },
    );
  });

  test("an .html file that the server calls text is always the opens-as-source bug", () => {
    fc.assert(
      fc.property(fc.constantFrom(".html", ".htm", ".HTML"), (ext) => {
        const path = `/a/mockups/thing${ext}`;
        expect(judge(chip({ path, raw: path }), answer({ kind: "text" })).cause).toBe("html-as-source");
      }),
      { numRuns: 30 },
    );
  });

  test("a `#next N` chip on a record is judged against the record's real item numbers", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.array(fc.integer({ min: 1, max: 60 }), { maxLength: 30 }),
        (wanted, items) => {
          const verdict = judge(
            chip({ isRecord: true, place: `#next ${wanted}`, recordItems: items }),
            null,
          );
          expect(verdict.cause).toBe(items.includes(wanted) ? "ok" : "task-not-in-record");
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("grouping", () => {
  test("every relative miss is one group, whatever directory it was searched from", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 2, maxLength: 10 }), (dirs) => {
        const families = new Set(dirs.map((d) => family(`not found from ${d} or its ancestors`)));
        expect(families.size).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  test("a reason the list does not know is passed through rather than swallowed", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (reason) => {
        fc.pre(!/not found|readable roots|denied |too large|binary|no note named|path/u.test(reason));
        expect(family(reason)).toBe(reason);
      }),
      { numRuns: 300 },
    );
  });
});
