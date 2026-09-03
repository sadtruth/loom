/**
 * The Active list (SPEC 247–249).
 *
 * Two things are worth pinning and they are not the obvious one. First, the SCOPE: a record in
 * another core must not change one thing about the list for this core — the same metamorphic shape
 * `panel-core.props.test.ts` uses on the tree, because "only that core" alone passes on an
 * implementation that drops half the list. Second, AGREEMENT: a record is in the list if and only
 * if the ring's own comparison says it is active, which is the property that would have caught the
 * bug class items 53 and 63 were.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ACTIVE_MS, activeRows, type ActiveSession, type PanelRecord } from "../../client/panel.ts";

const NOW = 1_760_000_000_000;

const record = (i: number, core: string): PanelRecord => ({
  path: `/vault/${core}/${i}/project.md`,
  status: "active",
  parent: null,
  mtime: NOW - 1000,
  core,
});

const coreName = fc.constantFrom("personal", "work", "spouse");

/** Ages spread ACROSS the window's edge on purpose — half of these must not make the list. */
const age = fc.integer({ min: 0, max: 2 * ACTIVE_MS });

const world = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 40 }), coreName, fc.array(age, { maxLength: 3 })), {
    maxLength: 12,
  })
  .map((rows) => {
    const records = rows.map(([i, core], n) => record(i * 100 + n, core));
    const activity: Record<string, ActiveSession[]> = {};
    rows.forEach(([, , ages], n) => {
      const path = (records[n] as PanelRecord).path;
      activity[path] = ages.map((a) => ({ lastTyped: NOW - a }));
    });
    return { records, activity };
  });

/** The ring's rule, written out independently — the oracle the list must agree with. */
const ringSaysActive = (sessions: readonly ActiveSession[]): boolean => {
  const floor = NOW - ACTIVE_MS;
  return sessions.some((s) => s.lastTyped > floor);
};

describe("the Active list", () => {
  test("a row is in the list exactly when the tree's ring would light (249)", () => {
    fc.assert(
      fc.property(world, ({ records, activity }) => {
        const listed = new Set(activeRows(records, activity, { now: NOW, core: null }).map((r) => r.path));
        for (const r of records) {
          expect(listed.has(r.path)).toBe(ringSaysActive(activity[r.path] ?? []));
        }
      }),
    );
  });

  test("newest first, always (247)", () => {
    fc.assert(
      fc.property(world, ({ records, activity }) => {
        const rows = activeRows(records, activity, { now: NOW, core: null });
        for (let i = 1; i < rows.length; i += 1) {
          const prev = rows[i - 1] as { lastTyped: number };
          const here = rows[i] as { lastTyped: number };
          expect(prev.lastTyped >= here.lastTyped).toBe(true);
        }
      }),
    );
  });

  test("a record in another core changes nothing about this one (248)", () => {
    fc.assert(
      fc.property(world, coreName, fc.integer({ min: 0, max: 99 }), age, ({ records, activity }, core, n, a) => {
        const other = core === "work" ? "personal" : "work";
        const before = activeRows(records, activity, { now: NOW, core });
        const intruder = record(9000 + n, other);
        const after = activeRows(
          [...records, intruder],
          { ...activity, [intruder.path]: [{ lastTyped: NOW - a }] },
          { now: NOW, core },
        );
        expect(after).toEqual(before);
      }),
    );
  });

  test("a scoped list contains only that core (248)", () => {
    fc.assert(
      fc.property(world, coreName, ({ records, activity }, core) => {
        for (const row of activeRows(records, activity, { now: NOW, core })) {
          expect(records.find((r) => r.path === row.path)?.core).toBe(core);
        }
      }),
    );
  });

  test("no core chosen is every core's rows, and nothing else", () => {
    fc.assert(
      fc.property(world, ({ records, activity }) => {
        const all = activeRows(records, activity, { now: NOW, core: null }).map((r) => r.path).sort();
        const parts = ["personal", "work", "spouse"]
          .flatMap((c) => activeRows(records, activity, { now: NOW, core: c }).map((r) => r.path))
          .sort();
        expect(all).toEqual(parts);
      }),
    );
  });

  test("the row's time is the NEWEST session's, not the first one found", () => {
    const r = record(1, "personal");
    const rows = activeRows(
      [r],
      { [r.path]: [{ lastTyped: NOW - 6 * 60 * 60 * 1000 }, { lastTyped: NOW - 60_000 }] },
      { now: NOW, core: "personal" },
    );
    expect(rows).toEqual([{ path: r.path, lastTyped: NOW - 60_000 }]);
  });

  test("the window's edge is exclusive, on the same side the ring's is", () => {
    const r = record(2, "personal");
    const at = (lastTyped: number) => activeRows([r], { [r.path]: [{ lastTyped }] }, { now: NOW, core: null }).length;
    expect(at(NOW - ACTIVE_MS + 1)).toBe(1);
    expect(at(NOW - ACTIVE_MS)).toBe(0);
    expect(at(NOW - ACTIVE_MS - 1)).toBe(0);
  });

  test("a record with no sessions, or none this window, is simply absent", () => {
    const r = record(3, "personal");
    expect(activeRows([r], {}, { now: NOW, core: null })).toEqual([]);
    expect(activeRows([r], { [r.path]: [] }, { now: NOW, core: null })).toEqual([]);
    expect(activeRows([r], { [r.path]: [{ lastTyped: 0 }] }, { now: NOW, core: null })).toEqual([]);
  });
});
