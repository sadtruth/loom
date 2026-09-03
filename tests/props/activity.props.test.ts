/**
 * P8 — the attention reader (server/activity.ts).
 *
 * It eats the same messy input the transcript parser does, from the tail of a file another process
 * is writing, so the rules worth stating are: it never throws, it never invents a fact, and a NEWER
 * message can only move its number forward. The last one is metamorphic — a relationship between
 * two runs — which is what makes it impossible to satisfy by accident.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  answerRecords,
  isWorking,
  readActivity,
  WORKING_SILENCE_MS,
  type SessionActivity,
} from "../../server/activity.ts";
// The rail's own reader. The row and the rail must never state two different numbers of minutes,
// which is a claim about ONE function being used twice, and is pinned as such below (SPEC 259).
import { readCache } from "../../server/train.ts";

const FALLBACK = 1_700_000_000_000;

function row(
  kind: "user" | "assistant",
  text: string,
  at: number,
  extra: object = {},
  messageExtra: object = {},
): string {
  return JSON.stringify({
    type: kind,
    uuid: `u-${at}`,
    timestamp: new Date(at).toISOString(),
    message: { role: kind, content: [{ type: "text", text }], ...messageExtra },
    ...extra,
  });
}

/** An assistant text row carrying the API's own `stop_reason`, the way the real CLI writes it. */
function reply(text: string, at: number, stopReason: string): string {
  return row("assistant", text, at, {}, { stop_reason: stopReason });
}

describe("activity: totality", () => {
  test("arbitrary bytes never throw and never invent a fact", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 4000 }), (junk) => {
        const got = readActivity(junk, FALLBACK);
        expect(Number.isFinite(got.lastReply)).toBe(true);
        expect(Number.isFinite(got.lastEnded)).toBe(true);
        expect(Number.isFinite(got.lastTyped)).toBe(true);
        expect(got.lastReply).toBeGreaterThanOrEqual(0);
        expect(got.lastEnded).toBeGreaterThanOrEqual(0);
        expect(got.lastTyped).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  test("a truncated final line is not a fact", () => {
    const whole = `${row("assistant", "complete", FALLBACK)}\n`;
    const half = whole.slice(0, Math.floor(whole.length / 2));
    expect(readActivity(half, FALLBACK).lastReply).toBe(0);
    expect(readActivity(whole, FALLBACK).lastReply).toBe(FALLBACK);
  });
});

describe("activity: what counts as whom", () => {
  test("a tool result is not User typing", () => {
    const line = JSON.stringify({
      type: "user",
      timestamp: new Date(FALLBACK).toISOString(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    expect(readActivity(`${line}\n`, FALLBACK).lastTyped).toBe(0);
  });

  test("a system reminder is not User typing", () => {
    const line = row("user", "<system-reminder>be good</system-reminder>", FALLBACK);
    expect(readActivity(`${line}\n`, FALLBACK).lastTyped).toBe(0);
  });

  test("a sidechain turn belongs to a subagent, not to this session", () => {
    const line = row("assistant", "subagent talking", FALLBACK, { isSidechain: true });
    expect(readActivity(`${line}\n`, FALLBACK).lastReply).toBe(0);
  });

  test("a tool_use-only assistant row is work, not a reply", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: new Date(FALLBACK).toISOString(),
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    });
    expect(readActivity(`${line}\n`, FALLBACK).lastReply).toBe(0);
  });
});

describe("activity: turn boundaries (SPEC 111)", () => {
  test("a reply that ends its turn sets lastEnded; one still mid-turn does not", () => {
    const ended = reply("done for now", FALLBACK, "end_turn");
    expect(readActivity(`${ended}\n`, FALLBACK).lastEnded).toBe(FALLBACK);
    expect(readActivity(`${ended}\n`, FALLBACK).lastReply).toBe(FALLBACK);

    const midTurn = reply("about to call a tool", FALLBACK, "tool_use");
    expect(readActivity(`${midTurn}\n`, FALLBACK).lastEnded).toBe(0);
    // It still counts as the newest thing SAID — only the "turn is over" fact is withheld.
    expect(readActivity(`${midTurn}\n`, FALLBACK).lastReply).toBe(FALLBACK);
  });

  test("stop_sequence ends a turn exactly like end_turn does", () => {
    const line = reply("done, hit a stop sequence", FALLBACK, "stop_sequence");
    expect(readActivity(`${line}\n`, FALLBACK).lastEnded).toBe(FALLBACK);
  });

  test("a reply with no stop_reason at all is a row the CLI never finished writing — not a fact", () => {
    const line = row("assistant", "no stop_reason on this one", FALLBACK);
    const got = readActivity(`${line}\n`, FALLBACK);
    expect(got.lastReply).toBe(FALLBACK);
    expect(got.lastEnded).toBe(0);
  });

  test("an intermediate reply behind a later final one reports the FINAL reply's end, not the intermediate's", () => {
    const lines = [
      reply("intermediate — mid turn", FALLBACK, "tool_use"),
      reply("final — turn over", FALLBACK + 1, "end_turn"),
    ].join("\n");
    const got = readActivity(`${lines}\n`, FALLBACK);
    expect(got.lastReply).toBe(FALLBACK + 1);
    expect(got.lastEnded).toBe(FALLBACK + 1);
  });

  test("the newest ENDED reply wins even when a later intermediate reply sits after it", () => {
    const lines = [
      reply("final — turn over", FALLBACK, "end_turn"),
      reply("intermediate of the NEXT turn — not over yet", FALLBACK + 1, "tool_use"),
    ].join("\n");
    const got = readActivity(`${lines}\n`, FALLBACK);
    // The newest reply of any kind is the intermediate one...
    expect(got.lastReply).toBe(FALLBACK + 1);
    // ...but the letter waits for a turn that actually finished.
    expect(got.lastEnded).toBe(FALLBACK);
  });
});

describe("activity: monotonicity (metamorphic)", () => {
  test("appending a newer reply can only move lastReply forward", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom("user", "assistant"), fc.string({ maxLength: 40 })), { maxLength: 12 }),
        fc.integer({ min: 1, max: 10_000 }),
        (rows, gap) => {
          const base = rows
            .map(([kind, text], i) => row(kind as "user" | "assistant", `x${text}`, FALLBACK + i))
            .join("\n");
          const before = readActivity(base.length > 0 ? `${base}\n` : "", FALLBACK);
          const later = FALLBACK + rows.length + gap;
          const after = readActivity(`${base}${base.length > 0 ? "\n" : ""}${row("assistant", "newer", later)}\n`, FALLBACK);
          expect(after.lastReply).toBe(later);
          expect(after.lastReply).toBeGreaterThanOrEqual(before.lastReply);
          // The other fact is untouched by an assistant append — the two are independent signals.
          expect(after.lastTyped).toBe(before.lastTyped);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("the NEWEST of each kind wins, whatever the order in the file", () => {
    const lines = [
      row("assistant", "old reply", FALLBACK),
      row("user", "old typing", FALLBACK + 1),
      row("assistant", "new reply", FALLBACK + 2),
      row("user", "new typing", FALLBACK + 3),
    ].join("\n");
    const got = readActivity(`${lines}\n`, FALLBACK);
    expect(got.lastReply).toBe(FALLBACK + 2);
    expect(got.lastTyped).toBe(FALLBACK + 3);
  });
});

/**
 * `answerRecords` — the `answered` field `/api/activity` now carries (SPEC requirement, session-truth
 * step 3). The client cannot tell "I have not asked yet" from "I asked and there is nothing" by
 * reading `data[path] ?? []` alone; `answered` is the ONLY place that distinction lives.
 */
function fakeActivity(id: string): SessionActivity {
  return { id, store: "s", mtime: 1, lastReply: 1, lastEnded: 1, lastTyped: 1, cacheAt: null, ttlMs: null, running: false };
}

describe("answerRecords: answered is truth, not a default", () => {
  test("every wanted path lands in exactly one bucket: answered-empty, answered-nonempty, or unknown", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 10 }),
        fc.array(fc.boolean(), { maxLength: 10 }),
        fc.array(fc.boolean(), { maxLength: 10 }),
        (paths, isKnown, hasSessions) => {
          const known = new Set(paths.filter((_, i) => isKnown[i % Math.max(isKnown.length, 1)] ?? false));
          const nonEmpty = new Set(paths.filter((_, i) => hasSessions[i % Math.max(hasSessions.length, 1)] ?? false));
          const { data, answered } = answerRecords(paths, known, (r) => (nonEmpty.has(r) ? [fakeActivity(r)] : []));
          const answeredSet = new Set(answered);
          expect(answeredSet.size).toBe(answered.length); // never answered twice
          for (const path of paths) {
            // The old shape: every requested path always got SOMETHING in `data` (possibly `[]`).
            // A naive check against today's response has no `answered` field to assert against at
            // all — this is the property that fails outright on unpatched code (no such export).
            expect(Object.hasOwn(data, path)).toBe(true);
            if (known.has(path)) {
              expect(answeredSet.has(path)).toBe(true);
            } else {
              // Unknown to the scan: still gets `[]` so one stale row cannot blank the rest, but it
              // is never claimed as answered — that would be the exact silent default this fixes.
              expect(data[path]).toEqual([]);
              expect(answeredSet.has(path)).toBe(false);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a path the caller never resolved can never sneak into answered — the SPEC 217 filter-bug shape", () => {
    // `resolve` is only ever called for a KNOWN path, so a bug that drops a path from the caller's
    // own processing loop (the kind SPEC 217 already found once) removes it from `knownPaths` too,
    // and `answered` follows it down rather than defaulting the path to an empty, answered list.
    const { data, answered } = answerRecords(["a", "b", "c"], new Set(["a", "c"]), (r) => [fakeActivity(r)]);
    expect(answered).toEqual(["a", "c"]);
    expect(data["b"]).toEqual([]);
    expect(data["a"]).toEqual([fakeActivity("a")]);
  });
});

/**
 * `isWorking` — the transcript's own answer to "is a turn in flight here" (SPEC 260).
 *
 * A false "working" is the worst failure this feature can have: it is the ONE state that means
 * "wait rather than act", so the properties below are all about it never being claimed — never past
 * the end of a turn, and never past the silence window, whatever the numbers are.
 */
describe("working is a fact, and it decays on silence", () => {
  const stamp = fc.integer({ min: 0, max: 4_000_000_000_000 });

  test("never true once the newest thing in the file ENDED its turn", () => {
    fc.assert(
      fc.property(stamp, stamp, stamp, stamp, (mtime, lastReply, lastTyped, now) => {
        const lastEnded = Math.max(lastReply, lastTyped); // the turn is over
        expect(isWorking({ mtime, lastReply, lastEnded, lastTyped }, now)).toBe(false);
      }),
    );
  });

  test("never true once the file has been silent for the window, however mid-turn it looks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 10 * 60 * 60 * 1000 }),
        (mtime, extra) => {
          const now = mtime + WORKING_SILENCE_MS + extra;
          // Mid-turn by construction: a reply that did not end its turn is the newest row.
          expect(isWorking({ mtime, lastReply: mtime, lastEnded: 0, lastTyped: mtime - 1 }, now)).toBe(false);
        },
      ),
    );
  });

  test("the two states it IS true in, and the killed child that follows them", () => {
    const t = 1_700_000_000_000;
    // He typed and nothing has come back yet.
    expect(isWorking({ mtime: t, lastReply: 0, lastEnded: 0, lastTyped: t }, t + 1000)).toBe(true);
    // A reply landed on the way through a tool call, so it did not end the turn.
    expect(isWorking({ mtime: t, lastReply: t, lastEnded: t - 60_000, lastTyped: t - 90_000 }, t + 1000)).toBe(true);
    // Scenario 5: the CLI dies mid-turn with no end-of-turn row written. It stops marching at the
    // first poll after the silence window — never forever, and it never claims a reply is waiting.
    expect(isWorking({ mtime: t, lastReply: t, lastEnded: 0, lastTyped: t - 1 }, t + WORKING_SILENCE_MS - 1)).toBe(true);
    expect(isWorking({ mtime: t, lastReply: t, lastEnded: 0, lastTyped: t - 1 }, t + WORKING_SILENCE_MS)).toBe(false);
    // A session nothing has ever happened in is not working.
    expect(isWorking({ mtime: t, lastReply: 0, lastEnded: 0, lastTyped: 0 }, t)).toBe(false);
  });
});

/**
 * The row and the rail read the SAME window (SPEC 259).
 *
 * `/api/activity` runs `readCache` over the tail it already sliced for the attention facts, and
 * `/api/train` runs it over its own, larger read. Two cases, not one: where both find a usage row
 * the numbers are identical, and where the smaller slice finds none the answer is NULL rather than
 * a second, different number.
 */
describe("the activity tail and the train never state two different hours", () => {
  function usageRow(at: number, bucket: "ephemeral_1h_input_tokens" | "ephemeral_5m_input_tokens"): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: new Date(at).toISOString(),
      message: {
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
          cache_creation: { [bucket]: 100 },
        },
      },
    });
  }

  test("where both readers see the newest call, they report the same at and ttlMs", () => {
    const t = 1_700_000_000_000;
    const whole = [usageRow(t - 3 * 60_000, "ephemeral_5m_input_tokens"), usageRow(t, "ephemeral_1h_input_tokens"), ""].join("\n");
    const tail = whole.slice(whole.indexOf("\n") + 1); // the smaller slice, still holding the newest row
    const big = readCache(whole);
    const small = readCache(tail);
    expect(big).not.toBeNull();
    expect(small).not.toBeNull();
    expect(small?.at).toBe(big?.at ?? -1);
    expect(small?.ttlMs).toBe(big?.ttlMs ?? -1);
    expect(big?.ttlMs).toBe(60 * 60 * 1000);
  });

  test("where the smaller slice holds no call at all, its answer is null and not the train's number", () => {
    const t = 1_700_000_000_000;
    const whole = [usageRow(t, "ephemeral_1h_input_tokens"), JSON.stringify({ type: "user", timestamp: new Date(t + 1000).toISOString(), message: { content: "hi" } }), ""].join("\n");
    const tail = whole.slice(whole.indexOf("\n") + 1); // everything after the usage row
    expect(readCache(whole)).not.toBeNull();
    // A row with no bar, never a guessed hour and never a number the rail disagrees with.
    expect(readCache(tail)).toBeNull();
  });
});
