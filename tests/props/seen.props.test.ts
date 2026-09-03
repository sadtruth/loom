/**
 * Global read state properties (server/seen.ts, SPEC 263-266).
 *
 * P-seen-1: Union is lossless — for any two files, every session's merged value is the max of the two.
 * P-seen-2: Merging is order-independent and idempotent.
 * P-seen-3: Merged watermark is the minimum positive one; all-zero/absent yields 0.
 * P-seen-4: Corrupted files (bad types, negative numbers, strings) are ignored and do not destroy good entries.
 * P-seen-5: writeOwn caps at 300 entries, keeping the 300 newest by value, and never touches another device's file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { mergeSeen, readAll, writeOwn, type SeenState } from "../../server/seen.ts";

const arbSessionId = fc.stringMatching(/^[a-z0-9-]{1,16}$/);
const arbTimestamp = fc.integer({ min: 1, max: 2_000_000_000_000 });
const arbWatermark = fc.integer({ min: 0, max: 2_000_000_000_000 });

const arbSeenMap = fc.dictionary(arbSessionId, arbTimestamp, { maxKeys: 30 });
const arbFileState = fc.record({
  watermark: arbWatermark,
  seen: arbSeenMap,
});

describe("mergeSeen pure properties", () => {
  test("P-seen-1: union is lossless — for any two files, every session's merged value is the max of the two", () => {
    fc.assert(
      fc.property(arbFileState, arbFileState, (f1, f2) => {
        const merged = mergeSeen([f1, f2]);
        const allKeys = new Set([...Object.keys(f1.seen), ...Object.keys(f2.seen)]);
        for (const key of allKeys) {
          const v1 = Object.hasOwn(f1.seen, key) ? f1.seen[key]! : 0;
          const v2 = Object.hasOwn(f2.seen, key) ? f2.seen[key]! : 0;
          expect(merged.seen[key]).toBe(Math.max(v1, v2));
        }
        expect(Object.keys(merged.seen).length).toBe(allKeys.size);
      }),
    );
  });

  test("P-seen-2: merging is order-independent and idempotent", () => {
    fc.assert(
      fc.property(fc.array(arbFileState, { minLength: 1, maxLength: 6 }), (files) => {
        const direct = mergeSeen(files);
        const reversed = mergeSeen([...files].reverse());
        expect(direct).toEqual(reversed);

        // Idempotent: merging the merged state with itself yields the same
        const idempotent = mergeSeen([direct, direct]);
        expect(idempotent).toEqual(direct);

        // Duplicate files
        const duplicated = mergeSeen([...files, ...files]);
        expect(duplicated).toEqual(direct);
      }),
    );
  });

  test("P-seen-3: merged watermark is the minimum positive one; all-zero/absent yields 0", () => {
    fc.assert(
      fc.property(fc.array(arbFileState, { minLength: 0, maxLength: 8 }), (files) => {
        const merged = mergeSeen(files);
        const positiveWatermarks = files
          .map((f) => f.watermark)
          .filter((w) => typeof w === "number" && Number.isFinite(w) && w > 0);
        if (positiveWatermarks.length > 0) {
          expect(merged.watermark).toBe(Math.min(...positiveWatermarks));
        } else {
          expect(merged.watermark).toBe(0);
        }
      }),
    );
  });

  test("P-seen-4: corrupted inputs (bad types, negative numbers, strings, arrays) are ignored and do not destroy good entries", () => {
    const arbCorrupted = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.constant("junk"),
      fc.constant(12345),
      fc.array(fc.anything()),
      fc.record({
        watermark: fc.oneof(fc.constant(-100), fc.constant("invalid"), fc.constant(NaN), fc.constant(Infinity)),
        seen: fc.dictionary(fc.string(), fc.oneof(fc.constant(-50), fc.constant("invalid"), fc.constant(null), fc.constant(NaN))),
      }),
      fc.record({
        watermark: fc.constant(null),
        seen: fc.constant("not-an-object"),
      }),
    );

    fc.assert(
      fc.property(arbFileState, fc.array(arbCorrupted, { minLength: 1, maxLength: 5 }), (good, corrupt) => {
        const goodMerged = mergeSeen([good]);
        const mixed = mergeSeen([...corrupt.slice(0, 2), good, ...corrupt.slice(2)]);
        expect(mixed).toEqual(goodMerged);

        const onlyCorrupt = mergeSeen(corrupt);
        expect(onlyCorrupt).toEqual({ watermark: 0, seen: {} });
      }),
    );
  });
});

describe("writeOwn and readAll filesystem properties", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "loom-seen-test-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("P-seen-5: writeOwn caps at 300 entries, keeping the 300 newest by value, and never touches another device's file", async () => {
    // Generate a patch with > 300 entries
    const entries: Record<string, number> = {};
    for (let i = 1; i <= 350; i++) {
      entries[`session-${i}`] = i * 1000;
    }
    await writeOwn({ watermark: 5000, seen: entries }, tmpDir, "device-a");

    const fileA = join(tmpDir, "device-a.json");
    expect(existsSync(fileA)).toBe(true);
    const contentA = JSON.parse(readFileSync(fileA, "utf8")) as SeenState;
    expect(Object.keys(contentA.seen).length).toBe(300);
    expect(contentA.watermark).toBe(5000);

    // Verify it kept the 300 newest by value (sessions 51 to 350, dropping 1 to 50)
    for (let i = 1; i <= 50; i++) {
      expect(contentA.seen[`session-${i}`]).toBeUndefined();
    }
    for (let i = 51; i <= 350; i++) {
      expect(contentA.seen[`session-${i}`]).toBe(i * 1000);
    }

    // Write to device-b
    await writeOwn({ watermark: 2000, seen: { "session-b-1": 999999 } }, tmpDir, "device-b");
    const fileB = join(tmpDir, "device-b.json");
    expect(existsSync(fileB)).toBe(true);
    const rawBBefore = readFileSync(fileB, "utf8");

    // Write again to device-a
    await writeOwn({ seen: { "session-a-new": 1000000 } }, tmpDir, "device-a");

    // device-b file must be byte-identical
    const rawBAfter = readFileSync(fileB, "utf8");
    expect(rawBAfter).toBe(rawBBefore);

    // readAll merges both
    const all = await readAll(tmpDir);
    expect(all.watermark).toBe(2000); // min(5000, 2000)
    expect(all.seen["session-b-1"]).toBe(999999);
    expect(all.seen["session-a-new"]).toBe(1000000);
  });
});
