import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fc from "fast-check";
import { pruneSnapshots, saveSnapshot, loadSnapshot } from "../../client/snapshot.ts";

describe("pruneSnapshots pure properties", () => {
  test("P-snap-1: keeps exactly the newest `cap` by `at`, deletes the rest, never deletes when under the cap, is deterministic under permutation", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ key: fc.string(), at: fc.integer() }), { minLength: 0, maxLength: 20 }),
        fc.integer({ min: 1, max: 10 }),
        (entries, cap) => {
          const deleted = pruneSnapshots(entries, cap);
          if (entries.length <= cap) {
            expect(deleted).toHaveLength(0);
          } else {
            expect(deleted).toHaveLength(entries.length - cap);
            const sorted = [...entries].sort((a, b) => {
              if (a.at !== b.at) return b.at - a.at;
              return a.key.localeCompare(b.key);
            });
            const expectedDeleted = sorted.slice(cap).map(e => e.key);
            expect(deleted).toEqual(expectedDeleted);
          }

          // Determinism under permutation
          const reversed = [...entries].reverse();
          expect(pruneSnapshots(reversed, cap)).toEqual(deleted);
        }
      )
    );
  });
});

describe("saveSnapshot and loadSnapshot round trip", () => {
  let fakeCache: Map<string, Response>;

  beforeEach(() => {
    fakeCache = new Map();
    // @ts-ignore
    globalThis.caches = {
      // @ts-ignore
      open: async (_name: string) => ({
        // @ts-ignore
        put: async (req: any, res: Response) => {
          let u = typeof req === "string" ? req : req.url;
          fakeCache.set(u.toString(), res);
        },
        // @ts-ignore
        match: async (req: any) => {
          let u = typeof req === "string" ? req : req.url;
          const res = fakeCache.get(u.toString());
          if (!res) return null;
          const text = await res.clone().text();
          return { json: async () => JSON.parse(text) };
        },
        // @ts-ignore
        keys: async () => {
          return Array.from(fakeCache.keys()).map(url => ({ url }));
        },
        // @ts-ignore
        delete: async (req: any) => {
          let u = typeof req === "string" ? req : req.url;
          fakeCache.delete(u.toString());
        }
      })
    };
  });

  afterEach(() => {
    // @ts-ignore
    delete globalThis.caches;
  });

  const snapshotArb = fc.record({
    at: fc.integer({ min: 1, max: 2000000000000 }),
    cwd: fc.oneof(fc.string(), fc.constant(null)),
    messages: fc.array(fc.anything(), { maxLength: 5 }),
    artifacts: fc.array(fc.anything(), { maxLength: 5 }),
    pins: fc.dictionary(fc.string(), fc.anything(), { maxKeys: 5 }),
    accepts: fc.oneof(fc.constant(undefined), fc.array(fc.anything(), { maxLength: 5 }))
  });

  test("round trip of saveSnapshot and loadSnapshot", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), snapshotArb, async (key, snap) => {
        fakeCache.clear();
        await saveSnapshot(key, snap);
        const loaded = await loadSnapshot(key);
        const expected = JSON.parse(JSON.stringify(snap));
        expect(loaded).toEqual(expected);
      })
    );
  });
});
