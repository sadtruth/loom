/**
 * The block after a restart — `restorable()` (SPEC §Recap, requirement 180).
 *
 * The function is pure so the four ways it must say NO can be hunted rather than imagined. Three of
 * them are stated as relationships between two runs over the same generated world, which is where
 * the power is: "the same ledger, read against an older car, must be silent" cannot be satisfied by
 * a function that happens to return the right thing for the case I thought of.
 *
 * Mutations shown red before this was believed — see VERIFY.md's registry entry.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { restorable } from "../../server/recap/service.ts";
import type { Entry } from "../../server/recap/ledger.ts";

const id = fc.string({ minLength: 4, maxLength: 8, unit: fc.constantFrom(..."0123456789abcdef") }).map((s) => `car-${s}`);
const ids = fc.uniqueArray(id, { minLength: 1, maxLength: 6 }).map((xs) => xs.map((x) => ({ id: x })));

function entry(sessionId: string, writtenAt: string, body: string): Entry {
  return { sessionId, title: `recap of ${sessionId}`, writtenAt, atTurn: 4, supersedes: null, body };
}

describe("restorable", () => {
  test("the newest car with a car behind it and an entry about it gets the block", () => {
    fc.assert(
      fc.property(ids, (cars) => {
        fc.pre(cars.length >= 2);
        const prev = cars.at(-2)!.id;
        const here = cars.at(-1)!.id;
        const got = restorable(cars, here, [entry(prev, "2026-08-13T10:00:00Z", "x")], {});
        expect(got?.sessionId).toBe(prev);
      }),
      { numRuns: 200 },
    );
  });

  test("no car but the newest ever shows one — the same world, read from an older seat", () => {
    fc.assert(
      fc.property(ids, fc.nat(), (cars, pick) => {
        fc.pre(cars.length >= 3);
        const entries = cars.map((c, i) => entry(c.id, `2026-08-13T1${i}:00:00Z`, "x"));
        // Any seat except the last one. The block is "where you left off", and the car before an
        // old car is not that — it is a car he went on to have.
        const older = cars[pick % (cars.length - 1)]!.id;
        expect(restorable(cars, older, entries, {})).toBeNull();
        expect(restorable(cars, cars.at(-1)!.id, entries, {})).not.toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  test("a refusal for this session silences the same ledger that would otherwise answer", () => {
    fc.assert(
      fc.property(ids, (cars) => {
        fc.pre(cars.length >= 2);
        const here = cars.at(-1)!.id;
        const entries = [entry(cars.at(-2)!.id, "2026-08-13T10:00:00Z", "x")];
        expect(restorable(cars, here, entries, {})).not.toBeNull();
        expect(restorable(cars, here, entries, { [here]: "2026-08-13T11:00:00Z" })).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  test("a re-run's superseded entry never reaches the screen", () => {
    fc.assert(
      fc.property(ids, fc.string({ minLength: 1, maxLength: 20 }), (cars, tail) => {
        fc.pre(cars.length >= 2);
        const prev = cars.at(-2)!.id;
        const old = entry(prev, "2026-08-13T09:00:00Z", `old ${tail}`);
        const fresh = entry(prev, "2026-08-13T10:00:00Z", `new ${tail}`);
        // Both orders in the file: append-only means the newest is last, but a hand-edited or
        // re-synced ledger must not be able to put the stale one on screen either.
        expect(restorable(cars, cars.at(-1)!.id, [old, fresh], {})?.body).toBe(fresh.body);
        expect(restorable(cars, cars.at(-1)!.id, [fresh, old], {})?.body).toBe(fresh.body);
      }),
      { numRuns: 200 },
    );
  });

  test("a lone car, an unknown session and an empty ledger all answer nothing", () => {
    fc.assert(
      fc.property(ids, (cars) => {
        const here = cars.at(-1)!.id;
        const prev = cars.at(-2)?.id ?? "nobody";
        // The first session of a record: nothing behind it to recap.
        expect(restorable([{ id: here }], here, [entry("nobody", "2026-08-13T10:00:00Z", "x")], {})).toBeNull();
        // A session that is not in this train at all.
        expect(restorable(cars, "car-not-here", [entry(prev, "2026-08-13T10:00:00Z", "x")], {})).toBeNull();
        // Nothing written about the car behind it.
        expect(restorable(cars, here, [], {})).toBeNull();
        // No session at all — the seam is cut and nothing has been created yet.
        expect(restorable(cars, "", [entry(prev, "2026-08-13T10:00:00Z", "x")], {})).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
