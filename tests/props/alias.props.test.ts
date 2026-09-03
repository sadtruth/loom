/**
 * PROPERTY PINS for the path alias — the rewrite that makes a transplanted session's chips open.
 *
 * A session moved from another machine names files by THAT machine's paths, so the box must be told
 * that `/home/user/docs` and `/home/user/resilio/docs` are the same tree. That is a rewrite of an
 * attacker-controllable string happening INSIDE the read guard, one step before the containment
 * check — so the question these properties exist to answer is not "does it rewrite" but **can the
 * rewrite be used to reach something the guard would otherwise refuse.**
 *
 * The load-bearing property is metamorphic (§build: assert a relationship between two runs, not a
 * claim about one output): aliasing must only change WHICH path is judged, never how it is judged.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { resolve } from "node:path";
import { applyAlias, decide, guardFrom, parseAliases, within } from "../../server/files.ts";

const ROOTS = "/vault:/home/user/.claude";
const plain = guardFrom(ROOTS, "/vault");
const aliased = guardFrom(ROOTS, "/vault", "/home/user/docs=/vault");

const junkArb = fc.array(
  fc.constantFrom("..", ".", "notes", "sub dir", "Заметки", "a.md", "..%2f", "...", "//", "\\", "-", ".ssh"),
  { minLength: 1, maxLength: 8 },
);

describe("the alias cannot relax a judgement", () => {
  /**
   * THE property. For any path, deciding it under the alias must equal deciding its rewritten form
   * under no alias at all. If that holds, the alias is provably just a rename: every refusal the
   * plain guard would issue — deny-list, containment, traversal — still issues.
   */
  test("decide(aliased, p) === decide(plain, applyAlias(p))", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("/home/user/docs", "/vault", "/home/user", "/etc", "/home/user/docsomething"),
        junkArb,
        (base, parts) => {
          const raw = `${base}/${parts.join("/")}`;
          const viaAlias = decide(aliased, raw);
          const viaPlain = decide(plain, applyAlias(aliased, resolve(raw)));
          expect(viaAlias.ok).toBe(viaPlain.ok);
          if (viaAlias.ok && viaPlain.ok) expect(viaAlias.path).toBe(viaPlain.path);
        },
      ),
      { numRuns: 800 },
    );
  });

  test("an accepted path is still inside a root, alias or not", () => {
    fc.assert(
      fc.property(junkArb, (parts) => {
        const verdict = decide(aliased, `/home/user/docs/${parts.join("/")}`);
        if (verdict.ok) {
          expect(verdict.path.split("/").includes("..")).toBe(false);
          expect(aliased.roots.some((root) => within(root, verdict.path))).toBe(true);
        }
      }),
      { numRuns: 800 },
    );
  });

  /**
   * The deny-list runs AFTER the rewrite, so a denied name reached THROUGH an alias is still denied.
   * Without this ordering the alias would be a way to launder `.ssh` into a readable root.
   */
  test("a denied segment is denied through the alias too", () => {
    for (const p of [
      "/home/user/docs/.ssh/id_ed25519",
      "/home/user/docs/sub/.git/config",
      "/home/user/docs/Passwords.kdbx",
      "/home/user/docs/.env",
    ]) {
      const verdict = decide(aliased, p);
      expect(verdict.ok).toBe(false);
    }
  });
});

describe("the rewrite happens on segment boundaries", () => {
  /**
   * `/home/user/docs` must not swallow `/home/user/docsomething` — the same off-by-one-segment
   * bug `within()` exists to avoid one layer down, and the one a naive `startsWith` would introduce.
   */
  test("a sibling whose name merely starts with the alias is untouched", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => !s.includes("/") && !s.includes("\0")), (tail) => {
        const path = `/home/user/docs${tail}`;
        expect(applyAlias(aliased, path)).toBe(path);
      }),
      { numRuns: 500 },
    );
  });

  test("the alias root itself, and anything under it, IS rewritten", () => {
    expect(applyAlias(aliased, "/home/user/docs")).toBe("/vault");
    expect(applyAlias(aliased, "/home/user/docs/a/b.md")).toBe("/vault/a/b.md");
  });

  test("applying twice is applying once", () => {
    fc.assert(
      fc.property(junkArb, (parts) => {
        const once = applyAlias(aliased, `/home/user/docs/${parts.join("/")}`);
        expect(applyAlias(aliased, once)).toBe(once);
      }),
      { numRuns: 400 },
    );
  });
});

describe("parsing refuses what it cannot mean", () => {
  test("a half-specified or relative pair is dropped, never guessed", () => {
    expect(parseAliases("")).toEqual([]);
    expect(parseAliases(undefined)).toEqual([]);
    expect(parseAliases("=/vault")).toEqual([]);
    expect(parseAliases("/home/user/docs=")).toEqual([]);
    expect(parseAliases("relative/from=/vault")).toEqual([]);
    expect(parseAliases("/home/user/docs=relative/to")).toEqual([]);
    expect(parseAliases("/a=/b:/c=/d")).toEqual([
      ["/a", "/b"],
      ["/c", "/d"],
    ]);
  });

  test("no alias configured leaves every path exactly as it was", () => {
    fc.assert(
      fc.property(junkArb, (parts) => {
        const path = `/home/user/docs/${parts.join("/")}`;
        expect(applyAlias(plain, path)).toBe(path);
      }),
      { numRuns: 300 },
    );
  });
});
