/**
 * The session→project link, and the fallback that keeps a terminal session belonging somewhere.
 *
 * The interesting property is metamorphic rather than a claim about one output: adding a link for
 * one session must not change the answer for any OTHER session. That is what "two projects cannot
 * cross" means, and a naive "a linked session resolves to its record" passes even on an
 * implementation that returns the same record for everybody.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactLinks,
  linksPath,
  mergeByLink,
  readLinks,
  resolveProject,
  sessionsOf,
  writeLink,
} from "../../server/links.ts";

const session = fc.string({ minLength: 1, maxLength: 12 });
const record = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0);
const key = fc.string({ minLength: 1, maxLength: 20 });

const linkMap = fc
  .array(fc.tuple(session, record), { maxLength: 8 })
  .map((pairs) => new Map(pairs));

describe("resolveProject", () => {
  test("a stored link wins over the derived key", () => {
    fc.assert(
      fc.property(session, record, key, linkMap, (s, r, k, links) => {
        const withLink = new Map(links).set(s, r);
        expect(resolveProject(s, k, withLink)).toEqual({ kind: "linked", record: r });
      }),
    );
  });

  test("without a link it derives, and never invents a record", () => {
    fc.assert(
      fc.property(session, key, linkMap, (s, k, links) => {
        const without = new Map(links);
        without.delete(s);
        expect(resolveProject(s, k, without)).toEqual({ kind: "derived", key: k });
      }),
    );
  });

  test("a blank record is not a link — it falls through", () => {
    fc.assert(
      fc.property(session, key, fc.stringMatching(/^[ \t]*$/), (s, k, blank) => {
        const links = new Map([[s, blank]]);
        expect(resolveProject(s, k, links)).toEqual({ kind: "derived", key: k });
      }),
    );
  });

  // The metamorphic one: linking session A must not move session B.
  test("linking one session does not move another", () => {
    fc.assert(
      fc.property(session, session, record, key, linkMap, (a, b, r, k, links) => {
        fc.pre(a !== b);
        const before = resolveProject(b, k, links);
        const after = resolveProject(b, k, new Map(links).set(a, r));
        expect(after).toEqual(before);
      }),
    );
  });

  test("sessionsOf returns exactly the sessions mapped to that record", () => {
    fc.assert(
      fc.property(linkMap, (links) => {
        for (const [s, r] of links) expect(sessionsOf(r, links)).toContain(s);
        for (const r of new Set(links.values())) {
          for (const s of sessionsOf(r, links)) expect(links.get(s)).toBe(r);
        }
      }),
    );
  });
});

describe("the store", () => {
  test("what is written is what is read, and a later write wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-"));
    try {
      await writeLink(dir, "s1", "/a/project.md");
      await writeLink(dir, "s2", "/b/project.md");
      await writeLink(dir, "s1", "/c/project.md");
      const links = await readLinks(dir);
      expect(links.get("s1")).toBe("/c/project.md");
      expect(links.get("s2")).toBe("/b/project.md");
      expect(links.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a broken file degrades to no links rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-"));
    try {
      await Bun.write(join(dir, "links.json"), "{not json");
      expect((await readLinks(dir)).size).toBe(0);
      await Bun.write(join(dir, "links.json"), JSON.stringify({ s: 42, t: "/ok.md" }));
      const links = await readLinks(dir);
      expect(links.has("s")).toBe(false);
      expect(links.get("t")).toBe("/ok.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing store is not an error", async () => {
    expect((await readLinks(join(tmpdir(), "loom-links-does-not-exist"))).size).toBe(0);
  });
});

/**
 * `mergeByLink` — the one answer to "which sessions are this record's", shared by `/api/train`,
 * `/api/records/sessions` and `/api/activity` (SPEC 217).
 *
 * These are the properties the three hand-written copies did not all hold. The ordering one is not
 * decoration: the client opens the head of this list, so a merge that appends instead of re-sorting
 * silently opens the wrong session.
 */
describe("a record's two session sources merge into one ordered list", () => {
  const entry = fc.record({ id: fc.string({ minLength: 1, maxLength: 8 }), mtime: fc.integer({ min: 0, max: 1e6 }) });
  const entries = fc.uniqueArray(entry, { selector: (e) => e.id, maxLength: 12 });

  test("newest first, always — whatever order the sources arrive in", () => {
    fc.assert(
      fc.property(entries, entries, (own, core) => {
        const ids = new Set(core.map((c) => c.id));
        const merged = mergeByLink(own, core, ids);
        for (let i = 1; i < merged.length; i += 1) {
          expect(merged[i - 1]!.mtime).toBeGreaterThanOrEqual(merged[i]!.mtime);
        }
      }),
    );
  });

  test("an unlinked core session is never this record's", () => {
    fc.assert(
      fc.property(entries, entries, (own, core) => {
        const ownIds = new Set(own.map((o) => o.id));
        // Nothing linked: the answer is exactly the record's own store, whatever the core holds.
        const merged = mergeByLink(own, core, new Set<string>());
        expect(merged.map((m) => m.id).sort()).toEqual([...ownIds].sort());
      }),
    );
  });

  test("METAMORPHIC: another record's sessions cannot enter this one's list", () => {
    fc.assert(
      fc.property(entries, entries, entries, (own, mine, theirs) => {
        const ids = new Set(mine.map((m) => m.id));
        const alone = mergeByLink(own, mine, ids);
        // The same call with a NEIGHBOUR's sessions also sitting in the shared core store. This is
        // the whole bug: before the link was consulted, they came back as ours.
        const crowded = mergeByLink(own, [...mine, ...theirs.filter((t) => !ids.has(t.id))], ids);
        expect(crowded.map((c) => c.id)).toEqual(alone.map((a) => a.id));
      }),
    );
  });

  test("no session appears twice when both stores hold it", () => {
    const both = [{ id: "same", mtime: 5 }];
    expect(mergeByLink(both, both, new Set(["same"]))).toEqual(both);
  });
});

/**
 * The race item 55 names, and the spike (session-truth/spike.ts) already caught red: `writeLink`
 * was a read-modify-write with nothing serializing callers, so N sessions started at once — two
 * browser tabs, or a burst of `/api/input` calls — lost all but the last writer's entry. Ported
 * from the spike's shape rather than re-derived, so this is the same property, in the suite.
 *
 * No artificial delay is injected — Bun's own I/O interleaving under `Promise.all` is what loses
 * entries against the unpatched read-modify-write writer, exactly as the spike observed.
 */
describe("concurrent writers (item 55)", () => {
  test("N sessions started at once all survive", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 40 }), async (n) => {
        const dir = await mkdtemp(join(tmpdir(), "loom-links-race-"));
        try {
          const ids = Array.from({ length: n }, (_, i) => `sess-${String(i)}`);
          await Promise.all(ids.map((id) => writeLink(dir, id, "some/record.md")));
          const after = await readLinks(dir);
          const lost = ids.filter((id) => !after.has(id));
          expect(lost).toEqual([]);
          expect(after.size).toBe(n);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 15 },
    );
  });
});

/**
 * The store predates this build — a live `links.json` is real data (his actual sessions), not a
 * fixture, so the old pretty-printed-object shape has to keep reading correctly, and a write after
 * reading an old-shape file must not silently drop what was already there.
 */
describe("migration: the old whole-object shape", () => {
  test("an old-format file (pretty JSON.stringify object) still reads correctly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-old-"));
    try {
      const oldShape = { s1: "/a/project.md", s2: "/b/project.md" };
      await Bun.write(join(dir, "links.json"), `${JSON.stringify(oldShape, null, 2)}\n`);
      const links = await readLinks(dir);
      expect(links.get("s1")).toBe("/a/project.md");
      expect(links.get("s2")).toBe("/b/project.md");
      expect(links.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writing after reading an old-format file preserves the old entries and adds the new one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-old-write-"));
    try {
      const oldShape = { s1: "/a/project.md" };
      await Bun.write(join(dir, "links.json"), `${JSON.stringify(oldShape, null, 2)}\n`);
      // The new writer only appends — it never reads-then-rewrites the whole file — so an append
      // straight onto an old-shape file would corrupt it (a JSON object followed by an NDJSON line
      // is not valid JSON, and is not valid NDJSON either). `writeLink` itself must not be the thing
      // relied on to migrate: a caller that appends onto an untouched old file is exactly what a
      // live `state/links.json` sees the moment this build lands.
      await compactLinks(dir, 0); // force: migrate the old file to the new shape first
      await writeLink(dir, "s2", "/b/project.md");
      const links = await readLinks(dir);
      expect(links.get("s1")).toBe("/a/project.md");
      expect(links.get("s2")).toBe("/b/project.md");
      expect(links.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("compaction", () => {
  test("below the threshold, the log is left alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-compact-below-"));
    try {
      await writeLink(dir, "s1", "/a/project.md");
      await writeLink(dir, "s1", "/b/project.md");
      const before = await Bun.file(linksPath(dir)).text();
      await compactLinks(dir, 500);
      const after = await Bun.file(linksPath(dir)).text();
      expect(after).toBe(before); // untouched — still two lines, not folded
      expect(before.trim().split("\n").length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("past the threshold, compaction folds to one line per session and readLinks agrees", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-compact-above-"));
    try {
      // Several sessions, some written more than once — the folded result must equal what
      // readLinks already returned BEFORE compaction (the scenario in the build plan).
      for (let i = 0; i < 5; i += 1) await writeLink(dir, `s${String(i)}`, `/r${String(i)}.md`);
      await writeLink(dir, "s0", "/r0-updated.md"); // a later write for an existing session

      const beforeCompaction = await readLinks(dir);
      await compactLinks(dir, 3); // threshold well below the 6 lines just written

      const raw = await Bun.file(linksPath(dir)).text();
      const lineCount = raw.trim().split("\n").filter((l) => l.length > 0).length;
      expect(lineCount).toBe(5); // one line per distinct session id, not per write

      const afterCompaction = await readLinks(dir);
      expect([...afterCompaction.entries()].sort()).toEqual([...beforeCompaction.entries()].sort());
      expect(afterCompaction.get("s0")).toBe("/r0-updated.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a write after compaction is still readable, alongside the compacted entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loom-links-compact-then-write-"));
    try {
      for (let i = 0; i < 4; i += 1) await writeLink(dir, `s${String(i)}`, `/r${String(i)}.md`);
      await compactLinks(dir, 2);
      await writeLink(dir, "s4", "/r4.md");
      const links = await readLinks(dir);
      expect(links.size).toBe(5);
      expect(links.get("s4")).toBe("/r4.md");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing store is not an error", async () => {
    await compactLinks(join(tmpdir(), "loom-links-compact-does-not-exist"), 0);
  });
});
