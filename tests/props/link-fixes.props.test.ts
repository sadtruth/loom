/**
 * Properties for the six fixes the 2026-08-24 link audit bought (plan `link-fixes-2026-08-24`).
 *
 * Only the pure halves live here: the place split, the page kind, and the worktree twin. What a
 * chip DOES with them is a browser question and is driven in `journey31-link-kinds.spec.mjs`.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { placeMark, splitPlace } from "../../client/chips.ts";
import { guardFrom, kindOf, locate, mainTreeTwin } from "../../server/files.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const guard = guardFrom(undefined, "/vault");

/** A path shaped like the ones actually written in a session — absolute, two or more segments. */
const somePath = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), { minLength: 2, maxLength: 5 })
  .map((parts) => `/${parts.join("/")}`);

describe("the place survives a labelled link (item 12)", () => {
  test("writing a place onto a path and reading it back returns the same mark", () => {
    fc.assert(
      fc.property(
        somePath,
        fc.oneof(
          fc.integer({ min: 1, max: 99999 }).map((n) => `:${n}`),
          fc.tuple(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 501, max: 999 })).map(
            ([a, b]) => `:${a}-${b}`,
          ),
          fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/).map((h) => `#${h}`),
        ),
        (path, mark) => {
          const split = splitPlace(`${path}.md${mark}`);
          expect(split.path).toBe(`${path}.md`);
          expect(placeMark(split.place)).toBe(mark);
        },
      ),
      { numRuns: 400 },
    );
  });

  test("`#L590` is the same thing as `:590`, never a heading", () => {
    fc.assert(
      fc.property(somePath, fc.integer({ min: 1, max: 99999 }), (path, line) => {
        const github = splitPlace(`${path}.ts#L${line}`);
        const plain = splitPlace(`${path}.ts:${line}`);
        expect(github).toEqual(plain);
        expect(placeMark(github.place)).toBe(`:${line}`);
      }),
      { numRuns: 300 },
    );
  });

  test("a `#L` range keeps both ends", () => {
    fc.assert(
      fc.property(
        somePath,
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 501, max: 999 }),
        (path, from, to) => {
          expect(placeMark(splitPlace(`${path}.ts#L${from}-L${to}`).place)).toBe(`:${from}-${to}`);
          expect(placeMark(splitPlace(`${path}.ts#L${from}-${to}`).place)).toBe(`:${from}-${to}`);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("a page is a page (item 10)", () => {
  test("every .html and .htm file is a page, whatever it is called or where it lives", () => {
    fc.assert(
      fc.property(
        somePath,
        fc.constantFrom(".html", ".htm", ".HTML", ".Htm"),
        (path, ext) => {
          expect(kindOf(`${path}${ext}`)).toBe("page");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("nothing else became a page", () => {
    fc.assert(
      fc.property(somePath, fc.constantFrom(".md", ".ts", ".txt", ".json", ".css", ".xml", ".svg"), (path, ext) => {
        expect(kindOf(`${path}${ext}`)).not.toBe("page");
      }),
      { numRuns: 200 },
    );
  });
});

describe("a link into a dropped worktree (item 16)", () => {
  const home = homedir();

  test("a worktree path maps to the same file in the vault, for any slug and any depth", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/), { minLength: 1, maxLength: 5 }),
        (slug, rest) => {
          const inside = join(home, "looms", slug, "docs", ...rest);
          expect(mainTreeTwin(guard, inside)).toBe(join("/vault", ...rest));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a path that is not inside a worktree has no twin", () => {
    fc.assert(
      fc.property(somePath, (path) => {
        fc.pre(!path.includes("/looms/"));
        expect(mainTreeTwin(guard, path)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  test("the worktree root itself has no twin — there is no file to fall back to", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/), (slug) => {
        expect(mainTreeTwin(guard, join(home, "looms", slug, "docs"))).toBeNull();
        expect(mainTreeTwin(guard, join(home, "looms", slug))).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

describe("a relative path is tried from the record too (item 14)", () => {
  test("what the session cannot resolve, the record can — and the session still wins when both can", async () => {
    const box = await mkdtemp(join(tmpdir(), "loom-bases-"));
    try {
      const near = join(box, "session");
      const far = join(box, "record");
      await mkdir(join(near, "sub"), { recursive: true });
      await mkdir(join(far, "sub"), { recursive: true });
      await writeFile(join(far, "sub", "only-there.md"), "far\n", "utf8");
      await writeFile(join(near, "sub", "both.md"), "near\n", "utf8");
      await writeFile(join(far, "sub", "both.md"), "far\n", "utf8");
      const guard = guardFrom(box, box);
      const record = join(far, "project.md");

      // Nothing on the session's ladder — without the record it is the audit's biggest group.
      expect((await locate(guard, "sub/only-there.md", near)).ok).toBe(false);
      const found = await locate(guard, "sub/only-there.md", near, record);
      expect(found).toEqual({ ok: true, path: join(far, "sub", "only-there.md") });

      // Two-sided: the record must never displace a file the session's own ladder resolves.
      const both = await locate(guard, "sub/both.md", near, record);
      expect(both).toEqual({ ok: true, path: join(near, "sub", "both.md") });

      // Still honest when neither has it.
      expect((await locate(guard, "sub/nowhere.md", near, record)).ok).toBe(false);
    } finally {
      await rm(box, { recursive: true, force: true });
    }
  });
});
