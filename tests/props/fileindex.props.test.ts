import { test, expect } from "bun:test";
import fc from "fast-check";
import { bandOf, mergeOrigins, type FilePinMap } from "../../server/fileindex.ts";
import { DENY_SEGMENT, DENY_NAME } from "../../server/files.ts";

// Helper for fast-check: generate a single path segment
const segmentArbitrary = fc.string({ minLength: 1, maxLength: 20 }).filter(s => {
  return !s.includes("/") && !s.includes("\0") && s.trim().length > 0;
});

// Helper for fast-check: generate an absolute path
const pathArbitrary = fc.array(segmentArbitrary, { minLength: 1, maxLength: 5 }).map(segs => "/" + segs.join("/"));

// 1. Every path lands in exactly one band.
// 2. bandOf is independent of origins: the same path with any origin set gets the same band.
test("bandOf property: exactly one band and independent of origins", () => {
  fc.assert(
    fc.property(pathArbitrary, (path) => {
      const band = bandOf(path);
      expect(["read", "code", "data"]).toContain(band);
    })
  );
});

// 3. The union merge is order-independent — shuffling the input origin lists gives the identical row set
test("mergeOrigins is order-independent", () => {
  const dateArbitrary = fc.oneof(
    fc.constant(""),
    fc.integer({ min: 0, max: 2000000000000 }).map(ms => new Date(ms).toISOString()),
    fc.constant("2026-09-04T00:00:00.000Z")
  );
  const originArbitrary = fc.record({
    path: pathArbitrary,
    origin: fc.constantFrom("record", "written", "edited", "read", "linked"),
    ts: dateArbitrary,
    bytes: fc.nat()
  });

  const pinsArbitrary: fc.Arbitrary<FilePinMap> = fc.dictionary(
    pathArbitrary,
    fc.record({ ts: dateArbitrary })
  );

  fc.assert(
    fc.property(fc.array(originArbitrary), pinsArbitrary, (inputs, pins) => {
      const shuffled = [...inputs].sort(() => Math.random() - 0.5);
      const res1 = mergeOrigins(inputs, pins);
      const res2 = mergeOrigins(shuffled, pins);
      expect(res1).toEqual(res2);
    })
  );
});

// 3b. The union merge is idempotent
test("mergeOrigins is idempotent", () => {
  const dateArbitrary = fc.oneof(
    fc.constant(""),
    fc.integer({ min: 0, max: 2000000000000 }).map(ms => new Date(ms).toISOString()),
    fc.constant("2026-09-04T00:00:00.000Z")
  );
  const originArbitrary = fc.record({
    path: pathArbitrary,
    origin: fc.constantFrom("record", "written", "edited", "read", "linked"),
    ts: dateArbitrary,
    bytes: fc.nat()
  });

  const pinsArbitrary: fc.Arbitrary<FilePinMap> = fc.dictionary(
    pathArbitrary,
    fc.record({ ts: dateArbitrary })
  );

  fc.assert(
    fc.property(fc.array(originArbitrary), pinsArbitrary, (inputs, pins) => {
      const first = mergeOrigins(inputs, pins);

      // Merge a result with itself means running mergeOrigins on the generated rows as if they were origins...
      // Wait, idempotent means merging the identical lists again doesn't change anything.
      // But mergeOrigins takes OriginInput[], not FileRow[].
      // So idempotent means mergeOrigins([...inputs, ...inputs], pins) === mergeOrigins(inputs, pins)
      const second = mergeOrigins([...inputs, ...inputs], pins);
      expect(first).toEqual(second);
    })
  );
});

// 4. No row's path contains a denied segment or matches a denied name.
test("No row contains a denied segment or denied name", () => {
  const badSegmentPath = pathArbitrary.map(p => `/.git${p}`);
  const badNamePath = pathArbitrary.map(p => `${p}/.env`);

  const badInputsArbitrary = fc.array(fc.record({
    path: fc.oneof(badSegmentPath, badNamePath),
    origin: fc.constant("record"),
    ts: fc.constant(new Date().toISOString()),
    bytes: fc.nat()
  }));

  fc.assert(
    fc.property(badInputsArbitrary, (inputs) => {
      const rows = mergeOrigins(inputs, {});
      expect(rows.length).toBe(0);
    })
  );

  // Mixed valid and invalid paths
  const allPathArbitrary = fc.oneof(pathArbitrary, badSegmentPath, badNamePath);
  const mixedInputsArbitrary = fc.array(fc.record({
    path: allPathArbitrary,
    origin: fc.constant("record"),
    ts: fc.constant(new Date().toISOString()),
    bytes: fc.nat()
  }));

  fc.assert(
    fc.property(mixedInputsArbitrary, (inputs) => {
      const rows = mergeOrigins(inputs, {});
      for (const row of rows) {
        const segments = row.path.split("/");
        for (const segment of segments) {
          expect(DENY_SEGMENT.has(segment)).toBe(false);
        }
        const name = segments[segments.length - 1]!;
        expect(DENY_NAME.test(name)).toBe(false);
      }
    })
  );
});

// 5. Sorting is total and stable: two rows with equal lastTs come back in path order, for any input permutation.
test("Sorting is total and stable", () => {
  const dateArbitrary = fc.oneof(
    fc.constant(""),
    fc.integer({ min: 0, max: 2000000000000 }).map(ms => new Date(ms).toISOString()),
    fc.constant("2026-09-04T00:00:00.000Z")
  );

  const variedPathArbitrary = fc.oneof(
    pathArbitrary,
    pathArbitrary.map(p => p.toUpperCase()),
    pathArbitrary.map(p => p + "/")
  );

  const originArbitrary = fc.record({
    path: variedPathArbitrary,
    origin: fc.constantFrom("record", "written", "edited", "read", "linked"),
    ts: dateArbitrary,
    bytes: fc.nat()
  });

  const pinsArbitrary: fc.Arbitrary<FilePinMap> = fc.dictionary(
    variedPathArbitrary,
    fc.record({ ts: dateArbitrary })
  );

  fc.assert(
    fc.property(fc.array(originArbitrary), pinsArbitrary, (inputs, pins) => {
      const rows = mergeOrigins(inputs, pins);

      // rows should be sorted correctly
      for (let i = 0; i < rows.length - 1; i++) {
        const a = rows[i]!;
        const b = rows[i + 1]!;

        const bandRank = { data: 3, code: 2, read: 1 };

        if (a.band !== b.band) {
          expect(bandRank[a.band]).toBeGreaterThan(bandRank[b.band]);
        } else if (a.lastTs !== b.lastTs) {
          expect(a.lastTs > b.lastTs).toBe(true);
        } else {
          expect(a.path < b.path).toBe(true);
        }
      }

      const shuffled = [...inputs].sort(() => Math.random() - 0.5);
      const rowsFromShuffled = mergeOrigins(shuffled, pins);
      expect(rowsFromShuffled).toEqual(rows);
    })
  );
});
