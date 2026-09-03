/**
 * Pins for the pictures a plan may show — SPEC 165 to 169.
 *
 * Every case here failed on `master` before the build: the seven formats had no classifier, an
 * image paragraph was refused by the mention rule, `reflow` glued it onto the line above, and a
 * finished task on one record refused a plan naming another.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { embedKind, fileUrl, whyNot } from "../../client/embed.ts";
import { IMAGE_LINE, parsePlan } from "../../client/plan-parse.ts";
import { reflow, visualPath } from "../../client/plan-block.ts";
import { mentionProblems, planProblems, type PlanWorld } from "../../server/plan-rules.ts";

const IMAGES = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];

describe("165 · what a plan can show", () => {
  test("all seven image formats are images, and pages are pages", () => {
    for (const ext of IMAGES) expect(embedKind(`mockups/a-2026-08-11.${ext}`)).toBe("image");
    for (const ext of ["html", "htm"]) expect(embedKind(`mockups/a.${ext}`)).toBe("page");
  });

  test("anything else stays a chip", () => {
    for (const name of ["SPEC.md", "client/app.ts", "notes.txt", "a.pdf", "mockups", ""]) {
      expect(embedKind(name)).toBeNull();
    }
  });

  test("an extension is never read out of the middle of a name", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}$/), (stem) => {
        expect(embedKind(`${stem}.png.md`)).toBeNull();
        expect(embedKind(`${stem}.md.png`)).toBe("image");
      }),
    );
  });
});

describe("166 · an SVG is fetched as an image", () => {
  test("a picture always asks for the raw bytes", () => {
    expect(fileUrl("mockups/a.svg", "/plans", true)).toContain("raw=1");
  });

  test("a relative path carries its base, an absolute one does not", () => {
    expect(fileUrl("mockups/a.png", "/plans", true)).toContain(`base=${encodeURIComponent("/plans")}`);
    expect(fileUrl("/abs/a.png", "/plans", true)).not.toContain("base=");
  });
});

describe("168 · a failure says what to do about it", () => {
  test("too large and not found are different sentences", () => {
    const big = whyNot(413, "shot.png");
    const gone = whyNot(404, "shot.png");
    expect(big).not.toBe(gone);
    expect(big).toContain("2 MB");
    expect(gone).toContain("could not read");
  });
});

describe("167 · the three places", () => {
  test("a lone image paragraph is recognised, an image inside a sentence is not", () => {
    expect(IMAGE_LINE.test("![the ladder](mockups/a.png)")).toBe(true);
    expect(IMAGE_LINE.test("see ![the ladder](mockups/a.png) above")).toBe(false);
    expect(IMAGE_LINE.exec("![cap](mockups/a.png)")?.[1]).toBe("cap");
    expect(IMAGE_LINE.exec("![cap](mockups/a.png)")?.[2]).toBe("mockups/a.png");
  });

  test("an image paragraph never merges into the prose above it", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z ]{2,40}$/), fc.constantFrom(...IMAGES), (prose, ext) => {
        const line = `![c](mockups/a.${ext})`;
        const out = reflow([prose, line]);
        expect(out).toEqual([prose.trim(), line]); // reflow trims every line it keeps
      }),
    );
  });

  test("a visual: field yields the path out of whatever text surrounds it", () => {
    expect(visualPath("`mockups/a-2026-08-11.html` — the ladder, at 3×")).toBe(
      "mockups/a-2026-08-11.html",
    );
    expect(visualPath("mockups/a.png")).toBe("mockups/a.png");
    expect(visualPath("nothing to show here")).toBeNull();
  });

  test("the mention rule stops demanding backticks around an image paragraph", () => {
    const withImage = parsePlan(
      ["## Objects", "", "### 1 · A thing", "kind: new", "", "![the ladder](mockups/a.png)", ""].join("\n"),
    );
    expect(mentionProblems(withImage)).toEqual([]);
    // …and still catches a bare path in ordinary prose, which is what the rule is for.
    const bare = parsePlan(["## Objects", "", "### 1 · A thing", "kind: new", "", "see mockups/a.png", ""].join("\n"));
    expect(mentionProblems(bare).length).toBe(1);
  });
});

describe("169 · a task is checked against its own record", () => {
  const world = (done: string[]): PlanWorld => ({
    isRecord: false,
    treeExists: true,
    records: new Map([
      ["a/project.md", new Set(["next 1", "next 2"])],
      ["b/project.md", new Set(["next 1"])],
    ]),
    outside: [],
    done: new Set(done),
    started: false,
  });

  const plan = (work: string): PlanDocLike =>
    parsePlan(
      [
        "---",
        "id: 2026-08-11 · 01",
        "records: [a/project.md, b/project.md]",
        "size: S",
        "git: worktree w, off master",
        `work: [${work}]`,
        "estimate: 1h",
        "---",
        "",
        "## Log",
        "",
        "written during the build",
        "",
      ].join("\n"),
    );
  type PlanDocLike = ReturnType<typeof parsePlan>;

  test("a finished item on the OTHER record does not refuse an open one", () => {
    const problems = planProblems(plan("a/project.md#next 1"), world(["b/project.md#next 1"]));
    expect(problems.filter((p) => p.field === "work")).toEqual([]);
  });

  test("a finished item on its OWN record still refuses", () => {
    const problems = planProblems(plan("a/project.md#next 1"), world(["a/project.md#next 1"]));
    expect(problems.filter((p) => p.field === "work").map((p) => p.says)).toEqual([
      "a/project.md#next 1 is already done",
    ]);
  });

  test("no id collision, for any pair of records and any item number", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 }), (n) => {
        const w = world([`b/project.md#next ${n}`]);
        w.records.set("b/project.md", new Set([`next ${n}`]));
        w.records.set("a/project.md", new Set([`next ${n}`]));
        const problems = planProblems(plan(`a/project.md#next ${n}`), w);
        expect(problems.filter((p) => p.field === "work")).toEqual([]);
      }),
    );
  });
});
