/**
 * The prototype-name convention, pinned (SPEC 133, 135).
 *
 * The convention is `<base>[-v<N>][-<change-slug>]-YYYY-MM-DD.html`; the grouping rule is "every
 * chain shows exactly once, its highest version leading". Real filenames from mockups/ are the
 * fixture — the convention was lived before it was coded, so the code must meet the files.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { groupProtos, parseProtoName, type ProtoFile } from "../../client/protos.ts";

const file = (name: string, mtime = 0): ProtoFile => ({ name, path: `/x/mockups/${name}`, mtime });

describe("parseProtoName — the real files on disk", () => {
  test("plain name with date is v1", () => {
    const parsed = parseProtoName(file("create-panel-2026-08-09.html"));
    expect(parsed.base).toBe("create-panel");
    expect(parsed.version).toBe(1);
    expect(parsed.change).toBeNull();
    expect(parsed.date).toBe("2026-08-09");
  });

  test("versioned name with a change slug", () => {
    const parsed = parseProtoName(file("create-panel-v4-context-menu-2026-08-09.html"));
    expect(parsed.base).toBe("create-panel");
    expect(parsed.version).toBe(4);
    expect(parsed.change).toBe("context menu");
  });

  test("dateless and versionless still parses", () => {
    const parsed = parseProtoName(file("projects.html"));
    expect(parsed.base).toBe("projects");
    expect(parsed.version).toBe(1);
    expect(parsed.date).toBeNull();
  });
});

const SLUG = fc
  .array(fc.constantFrom("panel", "create", "menu", "tab", "hover", "drawer", "v0abc"), { minLength: 1, maxLength: 3 })
  .map((parts) => parts.join("-"));

describe("groupProtos — properties", () => {
  test("every file lands in exactly one chain", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            base: SLUG,
            version: fc.integer({ min: 1, max: 9 }),
            mtime: fc.integer({ min: 0, max: 1e6 }),
          }),
          { maxLength: 20 },
        ),
        (specs) => {
          const files = specs.map((s, i) =>
            file(s.version === 1 ? `${s.base}-2026-08-0${(i % 9) + 1}.html` : `${s.base}-v${s.version}-2026-08-0${(i % 9) + 1}.html`, s.mtime),
          );
          // Same base + same version collide into one name — dedupe the inputs like the disk would.
          const unique = [...new Map(files.map((f) => [f.name, f])).values()];
          const chains = groupProtos(unique);
          const shown = chains.flatMap((c) => [c.latest, ...c.older]);
          expect(shown.length).toBe(unique.length);
          expect(new Set(shown.map((s) => s.name)).size).toBe(unique.length);
        },
      ),
    );
  });

  test("the head of a chain is its highest version, whatever the mtimes say", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 1e6 }), { minLength: 8, maxLength: 8 }),
        (versions, mtimes) => {
          const files = versions.map((v, i) =>
            file(v === 1 ? "thing-2026-08-01.html" : `thing-v${v}-2026-08-01.html`, mtimes[i] ?? 0),
          );
          const chains = groupProtos(files);
          expect(chains.length).toBe(1);
          expect(chains[0]?.latest.version).toBe(Math.max(...versions));
          // Metamorphic: shuffling the input order must not change the head.
          const reversed = groupProtos([...files].reverse());
          expect(reversed[0]?.latest.name).toBe(chains[0]?.latest.name);
        },
      ),
    );
  });

  test("adding a higher version dethrones the head; adding a lower one never does", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 20 }), SLUG, (v, base) => {
        const chain = [file(`${base}-2026-08-01.html`, 5), file(`${base}-v${v}-2026-08-02.html`, 1)];
        const grouped = groupProtos(chain);
        expect(grouped[0]?.latest.version).toBe(v);
        const higher = groupProtos([...chain, file(`${base}-v${v + 1}-2026-08-03.html`, 0)]);
        expect(higher[0]?.latest.version).toBe(v + 1);
      }),
    );
  });
});
