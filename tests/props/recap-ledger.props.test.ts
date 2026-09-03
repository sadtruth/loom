/**
 * The ledger (SPEC §Recap, requirement 173) and the git window (requirement 172).
 *
 * The ledger's whole claim is that append-only and "show the newest" are compatible — scenario 7
 * re-runs a recap, scenario 6 makes an old one stale, and neither may edit a line already written.
 * That is a round-trip claim, so it is stated over generated entries rather than one fixture.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { append, entryFor, newestPerSession, parse, render, type Entry } from "../../server/recap/ledger.ts";
import { findRepo, windowFor } from "../../server/recap/window.ts";

const entryArb = (): fc.Arbitrary<Entry> =>
  fc.record({
    sessionId: fc.constantFrom("s-one", "s-two", "s-three"),
    title: fc.string({ minLength: 1, maxLength: 40 }).map((s) => s.replace(/[\n\r]/g, " ").trim() || "t"),
    writtenAt: fc
      .integer({ min: 0, max: 5_000_000 })
      .map((ms) => new Date(1_760_000_000_000 + ms).toISOString()),
    atTurn: fc.nat({ max: 500 }),
    supersedes: fc.option(fc.constantFrom("2026-08-12T10:00:00.000Z"), { nil: null }),
    body: fc
      .string({ minLength: 1, maxLength: 300 })
      .map((s) => s.replace(/<!-- recap:/g, "recap").trim() || "body"),
  });

describe("requirement 173 — append-only, and the newest still wins", () => {
  test("an entry survives a round trip through the file", () => {
    fc.assert(
      fc.property(entryArb(), (e) => {
        const parsed = parse(render(e));
        expect(parsed.length).toBe(1);
        const got = parsed[0];
        expect(got?.sessionId).toBe(e.sessionId);
        expect(got?.atTurn).toBe(e.atTurn);
        expect(got?.supersedes).toBe(e.supersedes);
        expect(got?.body).toBe(e.body.trim());
      }),
      { numRuns: 200 },
    );
  });

  test("appending never touches what is already written", () => {
    fc.assert(
      fc.property(fc.array(entryArb(), { minLength: 1, maxLength: 8 }), (entries) => {
        let file = "";
        const seen: string[] = [];
        for (const e of entries) {
          file = append(file, e);
          seen.push(render(e).trim());
          // every earlier entry is still there, byte for byte
          for (const prior of seen) expect(file).toContain(prior);
        }
        expect(parse(file).length).toBe(entries.length);
      }),
      { numRuns: 100 },
    );
  });

  test("the reader shows one entry per session, the newest", () => {
    fc.assert(
      fc.property(fc.array(entryArb(), { minLength: 1, maxLength: 10 }), (entries) => {
        let file = "";
        for (const e of entries) file = append(file, e);
        const shown = newestPerSession(parse(file));
        const sessions = new Set(entries.map((e) => e.sessionId));

        // Property 1: exactly one entry per session id
        expect(shown.length).toBe(sessions.size);
        expect([...new Set(shown.map((e) => e.sessionId))].length).toBe(shown.length);

        for (const s of sessions) {
          const relevant = entries.filter((e) => e.sessionId === s);
          // Property 2: greatest writtenAt kept; ties resolved by taking the one that comes last in the file
          const expected = relevant.reduce((a, b) => (b.writtenAt >= a.writtenAt ? b : a));
          expect(entryFor(parse(file), s)).toEqual(expected);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("newestPerSession is order-independent (modulo ties) and idempotent", () => {
    fc.assert(
      fc.property(
        fc.array(entryArb(), { minLength: 1, maxLength: 10 }).filter((entries) => {
          // Filter to arrays where writtenAt is strictly unique per session to ensure pure order independence
          const map = new Map<string, Set<string>>();
          for (const e of entries) {
            const set = map.get(e.sessionId) ?? new Set();
            if (set.has(e.writtenAt)) return false;
            set.add(e.writtenAt);
            map.set(e.sessionId, set);
          }
          return true;
        }),
        (entries) => {
          // Property 3: Idempotent
          const sorted = newestPerSession(entries);
          const double = newestPerSession(sorted);
          expect(double).toEqual(sorted);

          // Property 3: Order-independent (with distinct writtenAt)
          const reversed = newestPerSession([...entries].reverse());
          expect(reversed).toEqual(sorted);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("a session never recapped has no entry", () => {
    expect(entryFor(parse(""), "nobody")).toBe(null);
  });
});

describe("requirement 172 — the window is derived, or there is no window", () => {
  test("a directory that does not exist has no repository", () => {
    expect(findRepo("/nope/gone/away")).toBe(null);
    expect(findRepo(null)).toBe(null);
  });

  test("this worktree resolves to a repository", () => {
    expect(findRepo(import.meta.dir)).not.toBe(null);
  });

  test("a removed cwd yields no window at all, rather than a guessed one", () => {
    expect(windowFor("/nope/gone/away", "2026-08-12T00:00:00Z", "2026-08-12T01:00:00Z")).toBe(null);
  });

  test("the window ends AFTER the session does — work is committed once talking stops", () => {
    let asked: readonly string[] = [];
    const win = windowFor(
      import.meta.dir,
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T01:00:00.000Z",
      (_repo, args) => {
        asked = args;
        return { ok: true, out: "abc123 2026-08-12 01:20 a commit\nfile.ts" };
      },
    );
    expect(win).not.toBe(null);
    expect(win?.until).toBe("2026-08-12T01:30:00.000Z");
    expect(asked.some((a) => a.startsWith("--since=2026-08-12T00:00:00.000Z"))).toBe(true);
  });

  test("git failing is not a window", () => {
    expect(
      windowFor(import.meta.dir, "2026-08-12T00:00:00Z", "2026-08-12T01:00:00Z", () => ({
        ok: false,
        out: "",
      })),
    ).toBe(null);
  });
});
