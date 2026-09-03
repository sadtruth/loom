/**
 * The build plan's parser and its schema (SPEC 147–152).
 *
 * The block's whole correctness claim is "a required field that is absent renders as a GAP, never
 * as a shorter block" — which is a claim about `missingFields`, so it is stated here over generated
 * plans rather than over one fixture. The real plan on disk is the second fixture: the convention
 * was written before the code, so the code must meet the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { reflow } from "../../client/plan-block.ts";
import {
  asList,
  fieldOf,
  isPresent,
  missingFields,
  parsePlan,
  planSize,
  SCHEMA,
  sectionOf,
  type Need,
  type Size,
} from "../../client/plan-parse.ts";

const REAL = join(import.meta.dir, "../../projects/build-plan/loom-plan-block-2026-08-10.md");
// The real plan record is box-only (projects/ is not exported to the public mirror).
const HAVE_REAL = existsSync(REAL);

describe.skipIf(!HAVE_REAL)("the real plan file on disk", () => {
  const doc = parsePlan(HAVE_REAL ? readFileSync(REAL, "utf8") : "");

  test("parses as an L plan with nothing missing", () => {
    expect(planSize(doc)).toBe("L");
    expect(missingFields(doc)).toEqual([]);
  });

  test("its title is the heading, not the filename", () => {
    expect(doc.title).toBe("A `plan` block in loom's chat");
  });

  test("every section the schema requires at L is really there", () => {
    for (const entry of SCHEMA) {
      if (entry.where !== "section" || entry.L !== "required") continue;
      expect(sectionOf(doc, entry.field)).not.toBeNull();
    }
  });

  test("scenarios carry starts/then/ends, and one of them is the failure", () => {
    const scenarios = sectionOf(doc, "Scenarios");
    expect(scenarios).not.toBeNull();
    expect(scenarios?.items.length).toBeGreaterThanOrEqual(4);
    for (const item of scenarios?.items ?? []) {
      expect(fieldOf(item, "starts")).not.toBeNull();
      expect(fieldOf(item, "then")).not.toBeNull();
      expect(fieldOf(item, "ends")).not.toBeNull();
    }
    const kinds = (scenarios?.items ?? []).map((i) => fieldOf(i, "kind") ?? "");
    expect(kinds.some((k) => k.includes("failure"))).toBe(true);
  });

  test("records is a list, so a build may serve several projects", () => {
    expect(asList(doc.front.get("records") ?? "").length).toBeGreaterThanOrEqual(1);
  });
});

/** A plan built from a chosen set of present fields — the generator for the gap property. */
const SIZES: Size[] = ["S", "M", "L"];

function build(size: Size, present: ReadonlySet<string>): string {
  const front: string[] = ["---"];
  const body: string[] = ["", "# A generated build", ""];
  for (const entry of SCHEMA) {
    if (!present.has(entry.field)) continue;
    if (entry.where === "front") {
      front.push(`${entry.field}: something`);
    } else {
      body.push(`## ${entry.field}`, "", "one line of content", "");
    }
  }
  front.push(`size: ${size}`, "---");
  return [...front, ...body].join("\n");
}

const presence = fc
  .subarray(SCHEMA.map((e) => e.field))
  .map((fields) => new Set(fields.filter((f) => f !== "size")));

describe("missingFields — the gap rule, over generated plans", () => {
  test("a required field that is absent is ALWAYS reported", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SIZES), presence, (size, present) => {
        const doc = parsePlan(build(size, present));
        // `size:` is always written by the generator — it is what selects the column.
        const expected = SCHEMA.filter(
          (entry) =>
            entry.field !== "size" && entry[size] === "required" && !present.has(entry.field),
        ).map((entry) => entry.field);
        expect(missingFields(doc).sort()).toEqual(expected.sort());
      }),
      { numRuns: 300 },
    );
  });

  test("a field that is present is never reported, whatever its need", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SIZES), presence, (size, present) => {
        const doc = parsePlan(build(size, present));
        for (const field of present) expect(missingFields(doc)).not.toContain(field);
      }),
      { numRuns: 200 },
    );
  });

  test("an EMPTY value is a gap, not a value", () => {
    const doc = parsePlan(["---", "size: S", "id:", "git: ", "---", "", "# x", ""].join("\n"));
    expect(missingFields(doc)).toContain("id");
    expect(missingFields(doc)).toContain("git");
  });

  test("the schema covers every size with no contradictions", () => {
    const needs: Need[] = ["required", "optional", "absent", "derived"];
    for (const entry of SCHEMA) for (const size of SIZES) expect(needs).toContain(entry[size]);
    // A derived field is the machine's to fill (SPEC 157), so it may never be demanded of a writer
    // and may never be reported as a gap — one rule, stated where the schema is stated.
    for (const entry of SCHEMA) {
      const derived = SIZES.filter((size) => entry[size] === "derived");
      expect(derived.length === 0 || derived.length === SIZES.length).toBe(true);
    }
    const allDerived = SCHEMA.filter((entry) => entry.S === "derived").map((entry) => entry.field);
    for (const size of SIZES) {
      const doc = parsePlan(`---\nsize: ${size}\n---\n\n# t\n`);
      for (const field of allDerived) expect(missingFields(doc)).not.toContain(field);
    }
    // Nothing may be required at a smaller size and absent at a larger one.
    for (const entry of SCHEMA) {
      if (entry.S === "required") expect(entry.M).toBe("required");
      if (entry.M === "required") expect(entry.L).toBe("required");
    }
  });
});

describe("the parser never throws and never loses a section", () => {
  test("arbitrary text parses to something drawable", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const doc = parsePlan(text);
        expect(Array.isArray(doc.sections)).toBe(true);
        expect(typeof doc.title).toBe("string");
      }),
      { numRuns: 300 },
    );
  });

  test("a label ends the previous field's clause wherever it appears (SPEC 53)", () => {
    const doc = parsePlan(
      ["# x", "", "## Scenarios", "", "### one", "starts: a thing", "ends: another", ""].join("\n"),
    );
    const item = sectionOf(doc, "Scenarios")?.items[0];
    expect(fieldOf(item!, "starts")).toBe("a thing");
    expect(fieldOf(item!, "ends")).toBe("another");
  });

  test("an INDENTED continuation line joins the field", () => {
    const doc = parsePlan(
      ["# x", "", "## Objects", "", "### thing", "lives in: one file", "  beside the record", ""].join(
        "\n",
      ),
    );
    const item = sectionOf(doc, "Objects")?.items[0];
    expect(fieldOf(item!, "lives in")).toBe("one file beside the record");
  });

  test("an UNINDENTED line after a field is prose, not part of it", () => {
    const doc = parsePlan(
      ["# x", "", "## Requirements", "", "### 147 · a thing", "spec: SPEC.md § Rich blocks",
       "The block renders the file at its path.", ""].join("\n"),
    );
    const item = sectionOf(doc, "Requirements")?.items[0];
    expect(fieldOf(item!, "spec")).toBe("SPEC.md § Rich blocks");
    expect(item?.prose).toEqual(["The block renders the file at its path."]);
  });

  test("frontmatter with no closing fence is not treated as content", () => {
    const doc = parsePlan("---\nid: 1\nsize: S\n");
    expect(doc.front.size).toBe(0);
    expect(missingFields(doc).length).toBeGreaterThan(0);
  });

  test.skipIf(!HAVE_REAL)("isPresent agrees with missingFields on every schema entry", () => {
    const doc = parsePlan(readFileSync(REAL, "utf8"));
    for (const entry of SCHEMA) {
      if (entry.L !== "required") continue;
      expect(isPresent(doc, entry)).toBe(true);
    }
  });
});

/**
 * Reflow — hard-wrapped source lines rejoined into the blocks they were written as.
 *
 * The plan file is wrapped at 100 columns. Rendering one paragraph per SOURCE line is what made the
 * document read as a column of orphan fragments (User, 2026-08-11, with screenshots).
 */
describe("wrapped prose is rejoined, and only where it should be", () => {
  test("a wrapped sentence becomes one paragraph", () => {
    expect(reflow(["Every rule above is enforced by something that can refuse,", "not by my intent."]))
      .toEqual(["Every rule above is enforced by something that can refuse, not by my intent."]);
  });

  test("a blank line always ends a paragraph", () => {
    expect(reflow(["one", "", "two"])).toEqual(["one", "two"]);
  });

  test("numbered items stay apart, and their own wrapped tails join them", () => {
    expect(reflow(["1. builder — works inside the", "worktree.", "2. verifier — tries to break it."]))
      .toEqual(["1. builder — works inside the worktree.", "2. verifier — tries to break it."]);
  });

  test("a table row never absorbs the line after it", () => {
    expect(reflow(["| a | b |", "| c | d |", "● required · ○ optional"]))
      .toEqual(["| a | b |", "| c | d |", "● required · ○ optional"]);
  });

  test("log entries and state transitions each stay one row", () => {
    expect(reflow(["18:52 · worktree taken,", "port 4335.", "19:10 · the parser went in."]))
      .toEqual(["18:52 · worktree taken, port 4335.", "19:10 · the parser went in."]);
    expect(reflow(["awaiting → open: he types it.", "open → stopped: the unlock expires."]))
      .toEqual(["awaiting → open: he types it.", "open → stopped: the unlock expires."]);
  });

  test("nothing is ever lost: every word of the input survives", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z ,.]{0,40}$/), { maxLength: 30 }), (lines) => {
        const words = (xs: readonly string[]): string[] => xs.join(" ").split(/\s+/).filter(Boolean);
        expect(words(reflow(lines))).toEqual(words(lines));
      }),
    );
  });
});
