/**
 * The open set's laws (SPEC 201), pinned before a pixel of the open list is drawn.
 *
 * These are properties rather than cases because the defect they guard is a RELATIONSHIP across a
 * SEQUENCE: any single open/close/select looks right in isolation, and the way this model breaks is
 * a selection left pointing at a member that was closed three operations ago. A hand-written case
 * would also have to guess the order that breaks it, and the interesting ones are at the edges —
 * closing the last member, closing the selected member, re-opening a member already open, closing
 * everything down to the chat.
 *
 * Deliberately NOT a property over "the list agrees with the set": that is two views of one hour's
 * work agreeing with themselves.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  CHAT_KEY,
  add,
  close,
  find,
  fromParams,
  isOpen,
  keyId,
  memberKey,
  newSet,
  open,
  openOne,
  pathTitle,
  select,
  toParams,
  type OpenKind,
  type OpenMember,
  type OpenSet,
} from "../../client/opens.ts";

/** A small path pool on purpose: collisions are where idempotence and re-open live. */
const PATHS = ["a/project.md", "b/project.md", "c/app.ts", "d/style.css", "Личное/заметка.md"];

/**
 * Keys as the client builds them, plus the chat. Every path appears TWICE — once as a record, once
 * as a file — because a `project.md` open as both is the collision kind-scoping exists for.
 */
const KEYS = [CHAT_KEY, ...PATHS.map((p) => memberKey("record", p)), ...PATHS.map((p) => memberKey("file", p))];

const kindOfKey = (key: string): OpenKind =>
  key === CHAT_KEY ? "session" : key.startsWith("record:") ? "record" : "file";

type Op =
  | { op: "open"; kind: OpenKind; key: string; title: string }
  | { op: "add"; kind: OpenKind; key: string; title: string }
  | { op: "close"; key: string }
  | { op: "select"; key: string };

const ops = (): fc.Arbitrary<Op> =>
  fc.oneof(
    fc
      .record({ key: fc.constantFrom(...KEYS), title: fc.string({ maxLength: 12 }) })
      .map(({ key, title }): Op => ({ op: "open", kind: kindOfKey(key), key, title })),
    fc
      .record({ key: fc.constantFrom(...KEYS), title: fc.string({ maxLength: 12 }) })
      .map(({ key, title }): Op => ({ op: "add", kind: kindOfKey(key), key, title })),
    fc.record({ op: fc.constant("close" as const), key: fc.constantFrom(...KEYS) }),
    fc.record({ op: fc.constant("select" as const), key: fc.constantFrom(...KEYS) }),
  );

const runs = (): fc.Arbitrary<Op[]> => fc.array(ops(), { minLength: 1, maxLength: 30 });

function apply(set: OpenSet, op: Op): OpenSet {
  switch (op.op) {
    case "open":
      return open(set, { kind: op.kind, key: op.key, title: op.title });
    case "add":
      return add(set, { kind: op.kind, key: op.key, title: op.title });
    case "close":
      return close(set, op.key);
    case "select":
      return select(set, op.key);
  }
}

/** The whole contract, asserted in one place after every single operation. */
function assertLaws(set: OpenSet): void {
  const keys = set.members.map((m) => m.key);
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys[0]).toBe(CHAT_KEY);
  expect(keys.filter((k) => k === CHAT_KEY).length).toBe(1);
  expect(keys).toContain(set.selected);
  expect(find(set, set.selected)).toBeDefined();
}

describe("the open set holds its laws over any sequence of operations", () => {
  test("no duplicates, chat first, selection always a member", () => {
    fc.assert(
      fc.property(runs(), (script) => {
        let set = newSet();
        assertLaws(set);
        for (const op of script) {
          set = apply(set, op);
          assertLaws(set);
        }
      }),
      { numRuns: 800 },
    );
  });

  /**
   * THE load-bearing one, and the mutation the plan names for this check: a `close` that removes the
   * member and leaves `selected` pointing at it. The set still looks fine — right members, right
   * order — and the centre shows nothing.
   */
  test("closing the selected member selects a NEIGHBOUR, never nothing", () => {
    fc.assert(
      fc.property(runs(), fc.constantFrom(...KEYS), (script, victim) => {
        let set = newSet();
        for (const op of script) set = apply(set, op);
        set = select(set, victim);
        const before = set.members.map((m) => m.key);
        const at = before.indexOf(victim);
        const after = close(set, victim);
        assertLaws(after);
        if (victim === CHAT_KEY || at < 0) {
          expect(after.members.map((m) => m.key)).toEqual(before);
          return;
        }
        if (set.selected !== victim) return; // the victim was never on screen; nothing to re-select
        expect(isOpen(after, victim)).toBe(false);
        const neighbours = [before[at + 1], before[at - 1]].filter((k) => k !== undefined);
        expect(neighbours).toContain(after.selected);
      }),
      { numRuns: 800 },
    );
  });

  test("the chat member cannot be closed, by any route", () => {
    fc.assert(
      fc.property(runs(), (script) => {
        let set = newSet();
        for (const op of script) set = apply(set, op);
        expect(isOpen(close(set, CHAT_KEY), CHAT_KEY)).toBe(true);
        // Closing every key there is still leaves the chat, and leaves it selected.
        let stripped = set;
        for (const key of KEYS) stripped = close(stripped, key);
        expect(stripped.members.map((m) => m.key)).toEqual([CHAT_KEY]);
        expect(stripped.selected).toBe(CHAT_KEY);
      }),
      { numRuns: 400 },
    );
  });

  test("opening the same thing twice adds no second member, and does not move it", () => {
    fc.assert(
      fc.property(runs(), fc.constantFrom(...KEYS), (script, key) => {
        let set = newSet();
        for (const op of script) set = apply(set, op);
        const kind = kindOfKey(key);
        const once = open(set, { kind, key, title: "first" });
        const twice = open(once, { kind, key, title: "second" });
        expect(twice.members.length).toBe(once.members.length);
        expect(twice.members.map((m) => m.key)).toEqual(once.members.map((m) => m.key));
        expect(twice.selected).toBe(key);
      }),
      { numRuns: 600 },
    );
  });

  /** The reason keys carry their kind: one path, two members, and closing one keeps the other. */
  test("a record and a file at the SAME path are two members", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PATHS), (path) => {
        const record = { kind: "record" as const, key: memberKey("record", path), title: "the record" };
        const file = { kind: "file" as const, key: memberKey("file", path), title: "the file" };
        const both = open(open(newSet(), record), file);
        expect(both.members.length).toBe(3);
        expect(both.selected).toBe(file.key);
        const closed = close(both, file.key);
        expect(isOpen(closed, record.key)).toBe(true);
        expect(isOpen(closed, file.key)).toBe(false);
        expect(keyId(record.key)).toBe(path);
        expect(keyId(file.key)).toBe(path);
      }),
      { numRuns: 50 },
    );
  });

  test("select never invents a member, and add never moves the selection", () => {
    fc.assert(
      fc.property(runs(), fc.string({ maxLength: 20 }), (script, stranger) => {
        let set = newSet();
        for (const op of script) set = apply(set, op);
        if (!isOpen(set, stranger)) expect(select(set, stranger)).toEqual(set);
        const grown = add(set, { kind: "file", key: memberKey("file", "e/new.ts"), title: "new.ts" });
        expect(grown.selected).toBe(set.selected);
        assertLaws(grown);
      }),
      { numRuns: 400 },
    );
  });
});

describe("the set through the URL", () => {
  test("every member the parameters can carry comes back, and nothing else does", () => {
    fc.assert(
      fc.property(runs(), fc.string({ maxLength: 8 }), (script, sessionId) => {
        let set = newSet();
        for (const op of script) set = apply(set, op);
        const back = fromParams(toParams(set, sessionId));
        assertLaws(back);
        const kept = (s: OpenSet, kind: OpenKind): string[] =>
          s.members.filter((m) => m.kind === kind).map((m) => keyId(m.key));
        expect(kept(back, "record")).toEqual(kept(set, "record"));
        expect(kept(back, "file")).toEqual(kept(set, "file"));
        // The URL carries no selection: a rebuilt set lands on the chat, as a deep link does today.
        expect(back.selected).toBe(CHAT_KEY);
      }),
      { numRuns: 600 },
    );
  });

  test("a rebuilt member is titled by its last path segment", () => {
    const back = fromParams(new URLSearchParams("record=a/b/project.md&file=x/y/app.ts"));
    expect(back.members.map((m: OpenMember) => [m.kind, m.key, m.title])).toEqual([
      ["session", CHAT_KEY, "session"],
      ["record", "record:a/b/project.md", "project.md"],
      ["file", "file:x/y/app.ts", "app.ts"],
    ]);
    expect(pathTitle("/a/b/")).toBe("b");
    expect(pathTitle("bare")).toBe("bare");
  });

  /**
   * SPEC 196. The law is stated over a SEQUENCE for the same reason the others are: one `openOne`
   * cannot show a leak, and the way this breaks is a member left behind by an earlier gesture that
   * the next one has no reason to look at.
   */
  test("openOne leaves the chat and exactly the thing just opened — whatever came before", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...KEYS.filter((k) => k !== CHAT_KEY)), { maxLength: 12 }), (keys) => {
        let set: OpenSet = newSet();
        for (const key of keys) {
          set = openOne(set, { kind: kindOfKey(key), key, title: keyId(key) });
          // Never more than the chat and one other, and the other is the one just opened.
          expect(set.members.length).toBeLessThanOrEqual(2);
          expect(set.members[0]?.key).toBe(CHAT_KEY);
          expect(set.selected).toBe(key);
          expect(isOpen(set, key)).toBe(true);
        }
        if (keys.length > 0) {
          const last = keys[keys.length - 1];
          for (const key of KEYS) {
            if (key === CHAT_KEY || key === last) continue;
            expect(isOpen(set, key)).toBe(false);
          }
        } else {
          expect(set.members.length).toBe(1);
        }
      }),
      { numRuns: 600 },
    );
  });

  test("openOne never closes the chat, and re-opening the same thing is idempotent", () => {
    fc.assert(
      fc.property(fc.constantFrom(...KEYS.filter((k) => k !== CHAT_KEY)), fc.integer({ min: 1, max: 5 }), (key, times) => {
        let set: OpenSet = newSet();
        for (let i = 0; i < times; i += 1) set = openOne(set, { kind: kindOfKey(key), key, title: keyId(key) });
        expect(set.members.map((m: OpenMember) => m.key)).toEqual([CHAT_KEY, key]);
        // The chat member survives being displaced-around, title and all.
        expect(find(set, CHAT_KEY)?.kind).toBe("session");
      }),
      { numRuns: 300 },
    );
  });

});
