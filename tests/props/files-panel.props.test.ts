import { test, describe, expect } from "bun:test";
import fc from "fast-check";
import { sections, visibleCount, type Folds } from "../../client/files-panel.ts";

const bandArb = fc.constantFrom("read", "code", "data" as const);
const rowArb = fc.record({
  path: fc.string(),
  name: fc.string(),
  band: bandArb,
  origins: fc.array(fc.string()),
  lastTs: fc.string(),
  bytes: fc.integer({ min: 0 }),
  pinned: fc.boolean(),
});
const rowsArb = fc.array(rowArb);
const foldsArb = fc.record({
  code: fc.boolean(),
  data: fc.boolean(),
});

describe("files-panel properties", () => {
  test("visibleCount(rows, folds) === sections(rows, folds).flatMap(s => s.rows).length", () => {
    fc.assert(
      fc.property(rowsArb, foldsArb, (rows, folds) => {
        const count = visibleCount(rows, folds);
        const actual = sections(rows, folds).flatMap((s) => s.rows).length;
        expect(count).toBe(actual);
      })
    );
  });

  test("Every input row appears in exactly one section, and no row appears twice, when fully expanded", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const folds: Folds = { code: false, data: false };
        const outRows = sections(rows, folds).flatMap((s) => s.rows);
        expect(outRows).toHaveLength(rows.length);
        // We just ensure reference equality counts match
        const inSet = new Set(rows);
        const outSet = new Set(outRows);
        expect(inSet.size).toBe(outSet.size);
        for (const row of outRows) {
          expect(inSet.has(row)).toBe(true);
        }
      })
    );
  });

  test("A pinned row is always in the Pinned section regardless of its band, and never also in its band's section", () => {
    fc.assert(
      fc.property(rowsArb, foldsArb, (rows, _folds) => {
        const out = sections(rows, { code: false, data: false });
        const pinnedSection = out.find((s) => s.title === "Pinned");
        const pinnedOut = pinnedSection ? pinnedSection.rows : [];
        const inPinned = rows.filter((r) => r.pinned);
        expect(pinnedOut).toHaveLength(inPinned.length);
        for (const s of out) {
          if (s.title !== "Pinned") {
            for (const r of s.rows) {
              expect(r.pinned).toBe(false);
            }
          }
        }
      })
    );
  });

  test("Collapsing a section never changes any other section's rows", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        const fullyOpen = sections(rows, { code: false, data: false });
        const codeClosed = sections(rows, { code: true, data: false });

        const getSec = (secs: ReturnType<typeof sections>, title: string) =>
          secs.find(s => s.title === title)?.rows ?? [];

        expect(getSec(fullyOpen, "Pinned")).toEqual(getSec(codeClosed, "Pinned"));
        expect(getSec(fullyOpen, "Reading")).toEqual(getSec(codeClosed, "Reading"));
        expect(getSec(fullyOpen, "Data")).toEqual(getSec(codeClosed, "Data"));

        const dataClosed = sections(rows, { code: false, data: true });
        expect(getSec(fullyOpen, "Pinned")).toEqual(getSec(dataClosed, "Pinned"));
        expect(getSec(fullyOpen, "Reading")).toEqual(getSec(dataClosed, "Reading"));
        expect(getSec(fullyOpen, "Code")).toEqual(getSec(dataClosed, "Code"));
      })
    );
  });

  test("Section order is fixed: Pinned, Reading, Code, Data — for any input permutation", () => {
    fc.assert(
      fc.property(rowsArb, foldsArb, (rows, _folds) => {
        const out = sections(rows, _folds);
        const titles = out.map((s) => s.title);
        const expectedOrder = ["Pinned", "Reading", "Code", "Data"];
        let lastIdx = -1;
        for (const title of titles) {
          const idx = expectedOrder.indexOf(title);
          expect(idx).toBeGreaterThan(lastIdx);
          lastIdx = idx;
        }
      })
    );
  });
});
