import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { checkReparentLegality, reRelativize } from "../../server/tasks.ts";

describe("reparent properties (pure)", () => {
  test("a move into a descendant is always refused", () => {
    // any legal move should not throw, any move into descendant should throw
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 5 }).filter(s => !s.includes("/") && !s.includes(".")),
        fc.string({ minLength: 1, maxLength: 5 }).filter(s => !s.includes("/") && !s.includes(".")),
        (dir, sub) => {
          const record = `/base/${dir}/project.md`;
          const target = `/base/${dir}/${sub}/project.md`;
          expect(() => checkReparentLegality(record, target, null)).toThrow(/cycle/);
        }
      )
    );
  });

  test("a move to an unrelated record is never refused for that reason", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 5 }).filter(s => !s.includes("/") && !s.includes(".")),
        fc.string({ minLength: 1, maxLength: 5 }).filter(s => !s.includes("/") && !s.includes(".")),
        (dir, unrelated) => {
          if (dir === unrelated) return;
          const record = `/base/${dir}/project.md`;
          const target = `/base/${unrelated}/project.md`;
          expect(() => checkReparentLegality(record, target, null)).not.toThrow(/cycle/);
        }
      )
    );
  });

  test("a move onto the record's current parent is a no-op (refused)", () => {
    const record = `/base/project-1/project.md`;
    const target = `/base/project.md`;
    expect(() => checkReparentLegality(record, target, target)).toThrow(/no-op/);
  });

  test("a link inside the moved subtree cannot be re-resolved afterwards if it points outside", () => {
    // If it points outside, reRelativize throws
    const link = "../../other-project/project.md";
    const mdFile = "/base/project-1/sub-1/project.md";
    const oldDir = "/base/project-1";
    const newDir = "/base/project-2/project-1";
    expect(() => reRelativize(link, mdFile, oldDir, newDir, false)).toThrow(/refused/);
  });

  test("a link pointing inside the subtree is successfully re-relativized", () => {
    const link = "../sub-2/project.md";
    const mdFile = "/base/project-1/sub-1/project.md";
    const oldDir = "/base/project-1";
    const newDir = "/base/project-2/project-1";
    expect(reRelativize(link, mdFile, oldDir, newDir, false)).toBe("../sub-2/project.md");
  });
});
