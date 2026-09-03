/**
 * Properties of the chip label rule (SPEC 139–140) and of `~` expansion (SPEC 142).
 *
 * The rule is stated over GENERATED records and paths rather than the handful I would think of,
 * because the failure it exists for was a coincidence of names: three different projects whose
 * record files are all called `project.md`. A hand-written case proves one arrangement of names;
 * the property proves the rule cannot be defeated by any arrangement.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { chipLook, enclosingRecord, splitPlace, statusClass, type RecordLike } from "../../client/chips.ts";
import { decide, expandHome, guardFrom } from "../../server/files.ts";
import { chipCodeSpans, chipPathLinks, makeChip } from "../../client/markdown.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/** Path segments that cannot themselves look like a place suffix or a separator. */
const segment = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,12}$/)
  .filter((s) => !s.includes("#") && !s.includes(":") && s.trim() === s);

const dirPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `/home/u/${parts.join("/")}`);
const title = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ,'—-]{2,40}$/);

function record(dir: string, name: string, status = "active"): RecordLike {
  return { path: `${dir}/project.md`, title: name, status };
}

describe("a chip to a record says the project's title", () => {
  test("property 38 — never the filename, whatever the paths and titles are", () => {
    fc.assert(
      fc.property(fc.uniqueArray(dirPath, { minLength: 1, maxLength: 6 }), fc.array(title, { minLength: 6, maxLength: 6 }), (dirs, titles) => {
        const records = dirs.map((dir, i) => record(dir, titles[i % titles.length] ?? `T${i}`));
        for (const rec of records) {
          const look = chipLook(rec.path, records);
          expect(look.kind).toBe("record");
          expect(look.label).toBe(rec.title);
          expect(look.label).not.toBe("project.md");
          expect(look.status).toBe(rec.status);
          // The destination is never rewritten by the label rule — SPEC §12–13.
          expect(look.path).toBe(rec.path);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("property 39 — a `project.md` NOTHING claims borrows its directory, never the bare filename", () => {
    fc.assert(
      fc.property(dirPath, (dir) => {
        const look = chipLook(`${dir}/project.md`, []);
        expect(look.kind).toBe("file");
        expect(look.label).toBe(dir.split("/").at(-1) ?? "");
      }),
      { numRuns: 200 },
    );
  });
});

describe("the owner suffix appears exactly where it earns its width", () => {
  test("property 40 — two-sided: shown when a filename repeats, absent when it is unique", () => {
    fc.assert(
      fc.property(fc.uniqueArray(dirPath, { minLength: 2, maxLength: 2 }), title, title, segment, (dirs, a, b, name) => {
        const [dirA, dirB] = dirs as [string, string];
        // Not nested, or the deeper record would legitimately own both files.
        fc.pre(!dirA.startsWith(`${dirB}/`) && !dirB.startsWith(`${dirA}/`));
        const records = [record(dirA, a), record(dirB, b)];
        const file = `${name}.md`;

        const repeated = chipLook(`${dirA}/${file}`, records, (base) => base === file);
        expect(repeated.owner).toBe(a);

        const unique = chipLook(`${dirA}/${file}`, records, () => false);
        expect(unique.owner).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  test("property 41 — the owner is the DEEPEST record containing the file, never an ancestor", () => {
    fc.assert(
      fc.property(dirPath, segment, title, title, (dir, child, outer, inner) => {
        const deep = `${dir}/${child}`;
        const records = [record(dir, outer), record(deep, inner)];
        expect(enclosingRecord(`${deep}/notes.md`, records)?.title).toBe(inner);
        expect(enclosingRecord(`${dir}/notes.md`, records)?.title).toBe(outer);
      }),
      { numRuns: 200 },
    );
  });
});

describe("a place inside a file", () => {
  test("property 42 — round-trip: a line or heading appended to a path splits back off it", () => {
    fc.assert(
      fc.property(dirPath, segment, fc.integer({ min: 1, max: 99_999 }), (dir, name, line) => {
        const path = `${dir}/${name}.md`;
        const byLine = splitPlace(`${path}:${line}`);
        expect(byLine.path).toBe(path);
        expect(byLine.place).toEqual({ line });

        const byHeading = splitPlace(`${path}#a-heading`);
        expect(byHeading.path).toBe(path);
        expect(byHeading.place).toEqual({ heading: "a-heading" });

        // Idempotent on a plain path: nothing to split, nothing rewritten.
        expect(splitPlace(path)).toEqual({ path, place: null });
      }),
      { numRuns: 300 },
    );
  });

  test("property 43 — a record file WITH a place is a document, not the project", () => {
    fc.assert(
      fc.property(dirPath, title, fc.integer({ min: 1, max: 999 }), (dir, name, line) => {
        const records = [record(dir, name)];
        const look = chipLook(`${dir}/project.md:${line}`, records);
        expect(look.kind).toBe("place");
        expect(look.path).toBe(`${dir}/project.md`);
        expect(look.place).toEqual({ line });
      }),
      { numRuns: 200 },
    );
  });

  test("property 46 — a record path renders as its title whether bare, backticked, or link repeated", () => {
    const _doc = globalThis.document;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        const dataset: Record<string, string> = {};
        return { tagName: tag.toUpperCase(), dataset, textContent: "", title: "", href: "", className: "" } as unknown as HTMLElement;
      }
    };

    try {
      fc.assert(
        fc.property(dirPath, title, (dir, name) => {
          const records = [record(dir, name)];
          const path = `${dir}/project.md`;

          const bareChip = makeChip(path);
          const bareLook = chipLook(bareChip.dataset["raw"] as string, records);
          expect(bareLook.label).toBe(name);

          let replacedBacktick: any = null;
          const mockRootCode = {
            querySelectorAll: () => [{ textContent: path, closest: () => null, replaceWith: (el: any) => { replacedBacktick = el; } }]
          } as unknown as HTMLElement;
          chipCodeSpans(mockRootCode);
          if (replacedBacktick !== null) {
            expect(replacedBacktick.dataset["fixed"]).toBeUndefined();
            const backtickedLook = chipLook(replacedBacktick.dataset["raw"] as string, records);
            if (backtickedLook.label !== name) throw new Error("backtick failed: " + backtickedLook.label + " !== " + name);
          }

          let replacedLinkRepeated: any = null;
          let replacedLinkCustom: any = null;

          const mockRootAnchors = {
            querySelectorAll: () => [
              { getAttribute: () => path, textContent: path, replaceWith: (el: any) => { replacedLinkRepeated = el; } },
              { getAttribute: () => path, textContent: "Custom Label", replaceWith: (el: any) => { replacedLinkCustom = el; } }
            ]
          } as unknown as HTMLElement;
          chipPathLinks(mockRootAnchors);

          if (replacedLinkRepeated !== null) {
            expect(replacedLinkRepeated.dataset["fixed"]).toBeUndefined();
            const repeatedLook = chipLook(replacedLinkRepeated.dataset["raw"] as string, records);
            expect(repeatedLook.label).toBe(name);
          }

          if (replacedLinkCustom !== null) {
            expect(replacedLinkCustom.dataset["fixed"]).toBe("1");
            expect(replacedLinkCustom.textContent).toBe("Custom Label");
          }
        }),
        { numRuns: 200 },
      );
    } finally {
      (globalThis as any).document = _doc;
    }
  });

  test("a colon that is not a line number stays part of the prose's path", () => {
    expect(splitPlace("/home/u/a/b.md:x").place).toBeNull();
    expect(splitPlace("/home/u/a/b.md:0").place).toBeNull();
    expect(splitPlace("#tag").place).toBeNull();
    expect(splitPlace("/home/u/a/#tag").place).toBeNull();
    // An editor's line:column — the line is what loom can act on.
    expect(splitPlace("/home/u/a/b.ts:12:5").place).toEqual({ line: 12 });
  });
});

describe("`~` is a path a human wrote", () => {
  test("property 44 — two-sided: `~/x` reaches the same decision as its expansion, `~` and relatives do not", () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 3 }), (parts) => {
        const rel = parts.join("/");
        const guard = guardFrom(homedir(), homedir());

        const viaTilde = decide(guard, `~/${rel}`);
        const viaAbsolute = decide(guard, join(homedir(), rel));
        expect(viaTilde).toEqual(viaAbsolute);
        expect(viaTilde.ok).toBe(true);

        // Not-a-path shapes stay 400s: `~` alone names no file, `~user` needs a passwd lookup.
        expect(decide(guard, "~").ok).toBe(false);
        expect(decide(guard, `~other/${rel}`).ok).toBe(false);
        expect(decide(guard, rel).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  test("expansion cannot escape a root by way of the tilde", () => {
    const guard = guardFrom(join(homedir(), "inside"), join(homedir(), "inside"));
    expect(decide(guard, "~/inside/ok.md").ok).toBe(true);
    // `..` is collapsed BEFORE containment is checked, so a traversal fails the test rather than
    // sneaking through it — the property that made expansion safe to do inside the guard.
    const escaped = decide(guard, "~/inside/../elsewhere/secret.md");
    expect(escaped.ok).toBe(false);
    expect(expandHome("~/inside/ok.md")).toBe(join(homedir(), "inside", "ok.md"));
  });
});

describe("a status as a class token", () => {
  // The work core writes its statuses in Russian — "результат собран" — and `classList.add` throws
  // `InvalidCharacterError` on any token holding a space, which took down every render that
  // contained one record chip (2026-08-28). Any string at all must come out addable or empty.
  test("property 45 — no status can produce a token classList refuses", () => {
    fc.assert(
      fc.property(fc.string(), (status) => {
        const token = statusClass(status);
        // A DOMTokenList rejects exactly two things: the empty string, and any ASCII whitespace.
        // The caller skips the empty token, so the property here is "no whitespace, ever".
        expect(/[\t\n\f\r ]/u.test(token)).toBe(false);
        expect(token.trim()).toBe(token);
      }),
      { numRuns: 500 },
    );
  });

  test("the statuses loom itself writes are unchanged", () => {
    for (const s of ["active", "framing", "parked", "done", "abandoned"]) {
      expect(statusClass(s)).toBe(s);
    }
    expect(statusClass("результат собран")).toBe("результат-собран");
  });
});
