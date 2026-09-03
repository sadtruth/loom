/**
 * Properties 19–22 — the cost reader (server/train.ts), pinned as P13.
 *
 * `readCache` is the one thing in the train that makes a CLAIM about money, so it is the one thing
 * that has to be impossible to satisfy by accident. Three rules are stated here:
 *
 *   1. totality — arbitrary bytes never throw and never invent a number;
 *   2. it reports the NEWEST call, not the largest or the first (metamorphic: appending a call can
 *      only move the answer to that call);
 *   3. a subagent's accounting is not this session's — sidechain rows are invisible to it.
 *
 * Rule 3 is the one a hand-written test would have missed and the one that would silently report a
 * 12k-token subagent context as User's 200k session.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readCache } from "../../server/train.ts";

const HOUR = 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

interface Call {
  at: number;
  read: number;
  write: number;
  fresh: number;
  bucket: "1h" | "5m" | null;
  sidechain?: boolean;
}

function usageRow(call: Call): string {
  const creation =
    call.bucket === null
      ? {}
      : {
          cache_creation: {
            ephemeral_1h_input_tokens: call.bucket === "1h" ? call.write : 0,
            ephemeral_5m_input_tokens: call.bucket === "5m" ? call.write : 0,
          },
        };
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${String(call.at)}`,
    timestamp: new Date(call.at).toISOString(),
    isSidechain: call.sidechain === true,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: {
        input_tokens: call.fresh,
        cache_read_input_tokens: call.read,
        cache_creation_input_tokens: call.write,
        ...creation,
      },
    },
  });
}

const arbCall = (sidechain = false): fc.Arbitrary<Call> =>
  fc.record({
    at: fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
    read: fc.integer({ min: 0, max: 400_000 }),
    write: fc.integer({ min: 1, max: 50_000 }),
    fresh: fc.integer({ min: 0, max: 5_000 }),
    bucket: fc.constantFrom<"1h" | "5m" | null>("1h", "5m", null),
    sidechain: fc.constant(sidechain),
  });

describe("train: totality", () => {
  test("arbitrary bytes never throw and never invent a number", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 4000 }), (junk) => {
        const got = readCache(junk);
        if (got === null) return;
        expect(Number.isFinite(got.at)).toBe(true);
        expect(Number.isFinite(got.context)).toBe(true);
        expect(got.context).toBeGreaterThan(0);
        expect(got.reuse).toBeGreaterThanOrEqual(0);
        expect(got.reuse).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  test("a transcript with no usage anywhere reports nothing rather than a zero", () => {
    const text = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      "",
    ].join("\n");
    expect(readCache(text)).toBeNull();
  });

  test("a half-written final line is not an accounting", () => {
    const call: Call = { at: 1_700_000_000_000, read: 90, write: 10, fresh: 0, bucket: "1h" };
    const whole = `${usageRow(call)}\n`;
    const torn = `${whole}${usageRow({ ...call, at: call.at + 1000, read: 1 }).slice(0, 40)}`;
    expect(readCache(torn)).toEqual(readCache(whole));
  });
});

describe("train: the numbers", () => {
  test("context is the whole prefix and reuse is the read share", () => {
    fc.assert(
      fc.property(arbCall(), (call) => {
        const got = readCache(`${usageRow(call)}\n`);
        expect(got).not.toBeNull();
        expect(got?.context).toBe(call.read + call.write + call.fresh);
        expect(got?.reuse).toBeCloseTo(call.read / (call.read + call.write), 10);
        expect(got?.at).toBe(call.at);
      }),
      { numRuns: 300 },
    );
  });

  test("the TTL comes from the row's own bucket, and is null when the row did not say", () => {
    fc.assert(
      fc.property(arbCall(), (call) => {
        const got = readCache(`${usageRow(call)}\n`);
        const want = call.bucket === "1h" ? HOUR : call.bucket === "5m" ? FIVE_MIN : null;
        expect(got?.ttlMs).toBe(want);
      }),
      { numRuns: 200 },
    );
  });
});

describe("train: which call it reports", () => {
  /**
   * METAMORPHIC. Appending a newer call must move the answer to that call and nowhere else —
   * a reader that took the first match, the biggest context or the last one it happened to parse
   * all pass a single-row test and fail this.
   */
  test("appending a newer call moves the answer to it", () => {
    fc.assert(
      fc.property(fc.array(arbCall(), { minLength: 1, maxLength: 8 }), arbCall(), (before, latest) => {
        // Order the history and put the new call strictly last, in file order.
        const rows = before.map((c, i) => usageRow({ ...c, at: 1_700_000_000_000 + i * 1000 }));
        const newest: Call = { ...latest, at: 1_700_000_000_000 + before.length * 1000 };
        const got = readCache(`${[...rows, usageRow(newest)].join("\n")}\n`);
        expect(got?.at).toBe(newest.at);
        expect(got?.context).toBe(newest.read + newest.write + newest.fresh);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * A subagent's usage describes the SUBAGENT's context. Counting it would report a number with
   * nothing to do with what User's next message costs — and subagent rows are always the newest
   * ones in the file while a fan-out is running, so this is the common case, not the exotic one.
   */
  test("sidechain rows are invisible, however new they are", () => {
    fc.assert(
      fc.property(arbCall(), arbCall(true), (mine, theirs) => {
        const main: Call = { ...mine, at: 1_700_000_000_000 };
        const sub: Call = { ...theirs, at: 1_700_000_500_000, sidechain: true };
        const got = readCache(`${usageRow(main)}\n${usageRow(sub)}\n`);
        expect(got?.at).toBe(main.at);
        expect(got?.context).toBe(main.read + main.write + main.fresh);
      }),
      { numRuns: 300 },
    );
  });

  test("a usage block with no input at all is skipped, not reported as a zero-cost turn", () => {
    const empty = usageRow({ at: 1_700_000_500_000, read: 0, write: 0, fresh: 0, bucket: null });
    const real = usageRow({ at: 1_700_000_000_000, read: 900, write: 100, fresh: 0, bucket: "1h" });
    const got = readCache(`${real}\n${empty}\n`);
    expect(got?.context).toBe(1000);
    expect(got?.reuse).toBeCloseTo(0.9, 10);
  });
});
