import { describe, expect, test, afterEach } from "bun:test";
import fc from "fast-check";
import { pruneSnapshots, saveSnapshot, loadSnapshot, type Snapshot } from "../../client/snapshot.ts";

describe("snapshot pure properties", () => {
  test("pruneSnapshots: keeps exactly the newest cap by at, deletes the rest, never deletes when under cap, deterministic", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.string(),
            at: fc.integer(),
          }),
          { minLength: 0, maxLength: 20 }
        ),
        fc.integer({ min: 1, max: 10 }),
        (entries, cap) => {
          // ensure unique keys by prepending index
          const uniqueEntries = entries.map((e, i) => ({ key: `${i}-${e.key}`, at: e.at }));
          const deleted = pruneSnapshots(uniqueEntries, cap);

          if (uniqueEntries.length <= cap) {
            expect(deleted).toEqual([]);
          } else {
            expect(deleted.length).toBe(uniqueEntries.length - cap);
            const keptKeys = new Set(uniqueEntries.map(e => e.key).filter(k => !deleted.includes(k)));
            const keptEntries = uniqueEntries.filter(e => keptKeys.has(e.key));
            const deletedEntries = uniqueEntries.filter(e => deleted.includes(e.key));

            // every kept entry should be >= every deleted entry in `at`
            const minKeptAt = Math.min(...keptEntries.map(e => e.at));
            const maxDeletedAt = Math.max(...deletedEntries.map(e => e.at));
            expect(minKeptAt).toBeGreaterThanOrEqual(maxDeletedAt);

            // Deterministic permuted arrays
            const shuffledEntries = [...uniqueEntries].reverse();
            const deletedShuffled = pruneSnapshots(shuffledEntries, cap);
            expect(deleted.sort()).toEqual(deletedShuffled.sort());
          }
        }
      )
    );
  });
});

describe("snapshot Cache API round-trip", () => {
  afterEach(() => {
    // @ts-ignore
    delete globalThis.caches;
  });

  test("saveSnapshot/loadSnapshot round-trip against a fake caches object", async () => {
    const fakeStore = new Map<string, Response>();
    const fakeCache = {
      put: async (req: string | Request, res: Response) => {
        // the real API puts using `/snap/key`
        const urlStr = typeof req === "string" ? req : (req as Request).url;
        fakeStore.set(urlStr, res.clone()); // need to clone since body can only be read once
      },
      match: async (req: string | Request) => {
        const urlStr = typeof req === "string" ? req : (req as Request).url;
        // Check if fakeStore has the URL or the pathname
        let key = urlStr;
        if (urlStr.startsWith("http")) {
          key = new URL(urlStr).pathname;
        }
        const res = fakeStore.get(key);
        return res ? res.clone() : undefined;
      },
      keys: async () => {
        return Array.from(fakeStore.keys()).map(k => new Request(new URL(k, "http://localhost")));
      },
      delete: async (req: string | Request) => {
        const urlStr = typeof req === "string" ? req : (req as Request).url;
        let key = urlStr;
        if (urlStr.startsWith("http")) {
          key = new URL(urlStr).pathname;
        }
        fakeStore.delete(key);
        return true;
      }
    };

    // @ts-ignore
    globalThis.caches = {
      open: async () => fakeCache as any
    };

    const dummySnap: Snapshot = {
      at: 123456789,
      cwd: "/test",
      messages: [],
      artifacts: [],
      pins: {},
      accepts: []
    };

    const key = "test-session/123";
    await saveSnapshot(key, dummySnap);
    let loaded = await loadSnapshot(key);

    expect(loaded).toEqual(dummySnap);

    // Write enough snapshots to trigger prune
    const entries: {key: string, at: number}[] = [];
    for (let i = 0; i < 12; i++) {
      const snapKey = `test/${i}`;
      const snap = { ...dummySnap, at: i };
      await saveSnapshot(snapKey, snap);
      entries.push({ key: snapKey, at: i });
    }

    const currentKeys = await fakeCache.keys();
    expect(currentKeys.length).toBe(8);
  });
});
