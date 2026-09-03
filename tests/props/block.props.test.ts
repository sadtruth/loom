/**
 * P16 — the 5-hour block arithmetic (server/block.ts).
 *
 * The rule is short and every part of it is a place to be off by one: the boundary floors to a
 * 10-minute mark, a block runs exactly five hours from there, a call with no billable input may
 * not OPEN one, and the chain restarts at the first call past the previous end. The cases cannot
 * be enumerated — any sequence of timestamps is a case — so the rules are stated and fast-check
 * hunts the counterexample.
 *
 * The metamorphic one is the one that matters, and it is not decoration: `bar.ts` feeds these
 * blocks by appending PER FILE, so its call list arrives interleaved rather than in time order.
 * If the grouping depended on input order at all, the live meter would disagree with the offline
 * report at random, which is precisely the failure nobody would notice.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { barOf, billableOf, blocksOf, BLOCK_MS, ROUND_MS, type Call } from "../../server/block.ts";

const BASE = 1_786_000_000_000;

const callArb = fc.record({
  ts: fc.integer({ min: 0, max: 40 * 60 * 60 * 1000 }).map((d) => BASE + d),
  model: fc.constantFrom("opus", "sonnet", "fable", "haiku", "other"),
  read: fc.integer({ min: 0, max: 400_000 }),
  write: fc.integer({ min: 0, max: 400_000 }),
  input: fc.integer({ min: 0, max: 5_000 }),
  output: fc.integer({ min: 0, max: 30_000 }),
});

const callsArb = fc.array(callArb, { maxLength: 120 });

describe("block boundaries", () => {
  test("a block starts on a 10-minute mark and runs exactly five hours", () => {
    fc.assert(
      fc.property(callsArb, (calls) => {
        for (const block of blocksOf(calls)) {
          expect(block.start % ROUND_MS).toBe(0);
          expect(block.end - block.start).toBe(BLOCK_MS);
        }
      }),
    );
  });

  test("blocks never overlap and run forward", () => {
    fc.assert(
      fc.property(callsArb, (calls) => {
        const blocks = blocksOf(calls);
        for (let i = 1; i < blocks.length; i++)
          expect(blocks[i]!.start).toBeGreaterThanOrEqual(blocks[i - 1]!.end);
      }),
    );
  });

  test("every billable call lands in exactly one block, and none is lost", () => {
    fc.assert(
      fc.property(callsArb, (calls) => {
        const billable = calls.filter((c) => billableOf(c) > 0);
        const blocks = blocksOf(calls);
        expect(blocks.reduce((s, b) => s + b.calls, 0)).toBe(billable.length);
        const bar = billable.reduce((s, c) => s + barOf(c), 0);
        expect(blocks.reduce((s, b) => s + b.bar, 0)).toBeCloseTo(bar, 3);
      }),
    );
  });

  test("a call with no billable input never opens a block", () => {
    fc.assert(
      fc.property(callsArb, fc.integer({ min: 0, max: 30_000 }), (calls, output) => {
        // Drop one in a hole far from everything else: the 429 record's own shape.
        const lonely: Call = { ts: BASE - 9e6, model: "opus", read: 0, write: 0, input: 0, output };
        const before = blocksOf(calls);
        const after = blocksOf([lonely, ...calls]);
        expect(after.length).toBe(before.length);
      }),
    );
  });

  test("METAMORPHIC: the grouping does not depend on the order the calls arrive in", () => {
    fc.assert(
      fc.property(callsArb, (calls) => {
        const inOrder = blocksOf([...calls].sort((a, b) => a.ts - b.ts));
        const shuffled = blocksOf([...calls].reverse());
        expect(shuffled.map((b) => [b.start, b.end, b.calls])).toEqual(
          inOrder.map((b) => [b.start, b.end, b.calls]),
        );
      }),
    );
  });
});

describe("what the bar weighs", () => {
  test("output is priced far above cache reads, and sonnet is NOT discounted", () => {
    // Not a tautology over the constants: these two are the FINDING (bar-report.ts), and a future
    // edit that quietly discounts Sonnet to save the bar would be reverting a measurement.
    const base = { ts: BASE, read: 0, write: 0, input: 0, output: 0 };
    const read = barOf({ ...base, model: "opus", read: 1000 });
    const output = barOf({ ...base, model: "opus", output: 1000 });
    expect(output / read).toBeGreaterThanOrEqual(50);
    expect(barOf({ ...base, model: "sonnet", read: 1000 })).toBe(read);
  });

  test("a call's draw rises with every component", () => {
    fc.assert(
      fc.property(callArb, fc.integer({ min: 1, max: 10_000 }), (call, more) => {
        expect(barOf({ ...call, output: call.output + more })).toBeGreaterThan(barOf(call));
        expect(barOf({ ...call, read: call.read + more })).toBeGreaterThan(barOf(call));
      }),
    );
  });
});
