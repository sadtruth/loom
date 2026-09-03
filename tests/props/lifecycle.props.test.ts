/**
 * The project-status write's contract (SPEC 65–66). Same posture as `tasks.props.test.ts`: loom is
 * editing files in User's vault, so the properties are about what a write may NOT do — the
 * load-bearing one is CONFINEMENT, that a close touches the `status:` line and the verdict paragraph
 * and nothing else in the record.
 *
 * The generators build records with junk around the two edited regions on purpose: a hand-written
 * case only covers the markdown shape I happened to imagine.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  PROJECT_STATUSES,
  setProjectStatus,
  setVerdict,
  type ProjectStatus,
} from "../../server/lifecycle.ts";

const REAL = `---
type: project
status: active
created: 2026-08-05
parent: ../../project.md
---

# Projects in loom

## Frame

**Need.** Projects as real objects in loom.

## Where it stands — 2026-08-06

1. Shipped and driven: records discovered by frontmatter.
2. The task surface shipped.

## Next

1. [ ] **Derive a project's sessions** — v1: sessions whose cwd is the project's directory.

## Log

- 2026-08-06 — the round happened.
`;

describe("setProjectStatus over a real record", () => {
  test("the status field moves and the body does not", () => {
    const out = setProjectStatus(REAL, "done");
    expect(out).toContain("status: done");
    expect(out).not.toContain("status: active");
    expect(out.slice(out.indexOf("# Projects"))).toBe(REAL.slice(REAL.indexOf("# Projects")));
  });

  test("a record with no status field gets one under `type:`", () => {
    const bare = "---\ntype: project\ncreated: 2026-08-06\n---\n\n# X\n\n## Where it stands\n\nHere.\n";
    const out = setProjectStatus(bare, "parked");
    expect(out.split("\n").slice(0, 4)).toEqual(["---", "type: project", "status: parked", "created: 2026-08-06"]);
  });

  test("a file with no frontmatter is refused, not guessed at", () => {
    expect(() => setProjectStatus("# Just a note\n", "done")).toThrow();
  });
});

describe("setVerdict over a real record", () => {
  const out = setVerdict(REAL, "the bet paid off — no model logic entered loom", "2026-08-06");

  test("the verdict lands at the end of Where it stands, before the next heading", () => {
    const lines = out.split("\n");
    const verdict = lines.findIndex((l) => l.startsWith("**Verdict"));
    const stands = lines.findIndex((l) => l.startsWith("## Where it stands"));
    const next = lines.findIndex((l) => l.startsWith("## Next"));
    expect(stands).toBeLessThan(verdict);
    expect(verdict).toBeLessThan(next);
    expect(lines[verdict]).toBe("**Verdict — 2026-08-06.** the bet paid off — no model logic entered loom");
  });

  test("everything outside that section survives byte for byte", () => {
    expect(out.slice(out.indexOf("## Next"))).toBe(REAL.slice(REAL.indexOf("## Next")));
    expect(out.slice(0, out.indexOf("## Where it stands"))).toBe(
      REAL.slice(0, REAL.indexOf("## Where it stands")),
    );
  });

  test("a record with no `Where it stands` section is refused", () => {
    const bare = "---\ntype: project\nstatus: active\n---\n\n# X\n\n## Next\n\n1. [ ] **Do it** — soon.\n";
    expect(() => setVerdict(bare, "done and dusted", "2026-08-06")).toThrow(/Where it stands/);
  });

  test("a multi-line verdict is written as ONE line", () => {
    const multi = setVerdict(REAL, "landed:\n  the tree\n\nmissed: the cost", "2026-08-06");
    expect(multi).toContain("**Verdict — 2026-08-06.** landed: the tree missed: the cost");
  });
});

// ── generated records: the same junk-around-the-edit shape tasks.props uses ──────────

const line = fc
  .string({ minLength: 0, maxLength: 40 })
  .map((s) => s.replace(/[\r\n]/g, " "))
  // Nothing generated may look like a heading or the frontmatter fence, or it would legitimately
  // move the regions this property is asserting about.
  .filter((s) => !/^#{1,6}\s/.test(s) && s.trim() !== "---" && !/^\*\*Verdict/i.test(s) && !/^status:/.test(s));

const prose = fc.array(line, { maxLength: 6 }).map((ls) => ls.join("\n"));

const record = fc
  .record({ before: prose, stands: prose, after: prose, status: fc.constantFrom(...PROJECT_STATUSES) })
  .map(({ before, stands, after, status }) => ({
    status,
    text: [
      "---",
      "type: project",
      `status: ${status}`,
      "created: 2026-08-06",
      "---",
      "",
      "# Generated record",
      "",
      "## Frame",
      "",
      before,
      "",
      "## Where it stands",
      "",
      stands,
      "",
      "## Next",
      "",
      "1. [ ] **Do the thing** — the plan.",
      "",
      "## Log",
      "",
      after,
      "",
    ].join("\n"),
  }));

const verdictText = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);

describe("properties", () => {
  test("CONFINEMENT — a status write changes exactly the status line", () => {
    fc.assert(
      fc.property(record, fc.constantFrom(...PROJECT_STATUSES), ({ text }, status) => {
        const before = text.split("\n");
        const after = setProjectStatus(text, status).split("\n");
        expect(after.length).toBe(before.length);
        after.forEach((got, i) => {
          if (/^status:/.test(before[i] ?? "")) expect(got).toBe(`status: ${status}`);
          else expect(got).toBe(before[i] ?? "");
        });
      }),
      { numRuns: 300 },
    );
  });

  test("CONFINEMENT — a verdict write leaves every line outside the section untouched", () => {
    fc.assert(
      fc.property(record, verdictText, ({ text }, verdict) => {
        const before = text.split("\n");
        const after = setVerdict(text, verdict, "2026-08-06").split("\n");
        const head = before.indexOf("## Where it stands");
        const tail = before.indexOf("## Next");
        expect(after.slice(0, head + 1)).toEqual(before.slice(0, head + 1));
        expect(after.slice(after.indexOf("## Next"))).toEqual(before.slice(tail));
      }),
      { numRuns: 300 },
    );
  });

  test("a second write does not accrete — one status, one verdict, and the text stops moving", () => {
    fc.assert(
      fc.property(record, verdictText, fc.constantFrom(...PROJECT_STATUSES), ({ text }, verdict, status) => {
        const once = setProjectStatus(setVerdict(text, verdict, "2026-08-06"), status);
        const twice = setProjectStatus(setVerdict(once, verdict, "2026-08-06"), status);
        expect(twice).toBe(once);
        expect(once.split("\n").filter((l) => l.startsWith("**Verdict")).length).toBe(1);
        expect(once.split("\n").filter((l) => /^status:/.test(l)).length).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  test("a rewritten verdict replaces the old one, whatever it said", () => {
    fc.assert(
      fc.property(record, verdictText, verdictText, ({ text }, first, second) => {
        const out = setVerdict(setVerdict(text, first, "2026-08-06"), second, "2026-08-07");
        const verdicts = out.split("\n").filter((l) => l.startsWith("**Verdict"));
        expect(verdicts).toHaveLength(1);
        expect(verdicts[0]).toContain("2026-08-07");
      }),
      { numRuns: 200 },
    );
  });

  test("the status written is the status parsed back", () => {
    fc.assert(
      fc.property(record, fc.constantFrom(...PROJECT_STATUSES), ({ text }, status: ProjectStatus) => {
        const out = setProjectStatus(text, status);
        const front = out.split("\n").slice(1, out.split("\n").indexOf("---", 1));
        expect(front.find((l) => l.startsWith("status:"))).toBe(`status: ${status}`);
      }),
      { numRuns: 200 },
    );
  });
});
