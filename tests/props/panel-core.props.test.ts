/**
 * The core is a SCOPE on the panel, and scopes must not leak.
 *
 * The property that matters is metamorphic: adding a record belonging to ANOTHER core must not
 * change one thing about the core being looked at. That is "two tabs do not fight" stated at the
 * level where it can actually be checked — a naive "a scoped view only contains that core" passes
 * on an implementation that drops half the tree.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { treeView, type PanelRecord } from "../../client/panel.ts";

const NOW = 1_760_000_000_000;

const record = (i: number, core: string, parent: string | null = null): PanelRecord => ({
  path: `/vault/${core}/${i}/project.md`,
  status: "active",
  parent,
  mtime: NOW - 1000,
  core,
});

const coreName = fc.constantFrom("personal", "work", "spouse");

const roots = fc.array(fc.tuple(fc.integer({ min: 0, max: 40 }), coreName), { maxLength: 12 })
  .map((pairs) => pairs.map(([i, c], n) => record(i * 100 + n, c)));

const opts = (core: string | null): Parameters<typeof treeView>[1] => ({
  now: NOW,
  focus: null,
  showOlder: true,
  showFinished: true,
  active: null,
  core,
});

describe("the core scope", () => {
  test("a scoped view contains only that core", () => {
    fc.assert(
      fc.property(roots, coreName, (records, core) => {
        const view = treeView(records, opts(core));
        for (const path of view.visible) {
          expect(records.find((r) => r.path === path)?.core).toBe(core);
        }
      }),
    );
  });

  // The one that is really about his requirement.
  test("a record in another core changes nothing about this one", () => {
    fc.assert(
      fc.property(roots, coreName, fc.integer({ min: 0, max: 99 }), (records, core, n) => {
        const other = core === "work" ? "personal" : "work";
        const before = treeView(records, opts(core));
        const after = treeView([...records, record(9000 + n, other)], opts(core));
        expect([...after.visible].sort()).toEqual([...before.visible].sort());
        expect(after.hiddenOlder).toBe(before.hiddenOlder);
        expect(after.hiddenFinished).toBe(before.hiddenFinished);
        expect(after.hiddenUnfocused).toBe(before.hiddenUnfocused);
      }),
    );
  });

  test("no core chosen is the old behaviour, exactly", () => {
    fc.assert(
      fc.property(roots, (records) => {
        const scoped = treeView(records, opts(null));
        const bare = treeView(records, { now: NOW, focus: null, showOlder: true, showFinished: true, active: null });
        expect([...scoped.visible].sort()).toEqual([...bare.visible].sort());
        expect(scoped.hiddenOtherCore).toBe(0);
      }),
    );
  });

  test("hiddenOtherCore counts every record the scope removed", () => {
    fc.assert(
      fc.property(roots, coreName, (records, core) => {
        const view = treeView(records, opts(core));
        expect(view.hiddenOtherCore).toBe(records.filter((r) => r.core !== core).length);
      }),
    );
  });

  test("a record with no core is invisible under any scope, and visible under none", () => {
    const untagged: PanelRecord = { path: "/vault/x/project.md", status: "active", parent: null, mtime: NOW };
    expect(treeView([untagged], opts("personal")).visible.size).toBe(0);
    expect(treeView([untagged], opts(null)).visible.size).toBe(1);
  });
});
