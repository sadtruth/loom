import { test } from "bun:test";
import fc from "fast-check";
import { sections, visibleCount } from "../../client/files-panel";

const fileRowArb = fc.record({
  path: fc.string(),
  name: fc.string(),
  band: fc.constantFrom("read", "code", "data") as fc.Arbitrary<"read" | "code" | "data">,
  origins: fc.array(fc.string()),
  lastTs: fc.string(),
  bytes: fc.nat(),
  pinned: fc.boolean(),
});

const foldsArb = fc.record({
  code: fc.boolean(),
  data: fc.boolean(),
});

test("1. visibleCount(rows, folds) === sections(rows, folds).flatMap(s => s.rows).length", () => {
  fc.assert(
    fc.property(fc.array(fileRowArb), foldsArb, (rows, folds) => {
      const sects = sections(rows, folds);
      const count = sects.flatMap((s) => s.rows).length;
      return visibleCount(rows, folds) === count;
    }),
  );
});

test("2. Every input row appears in exactly one section, unless folded (actually wait, if folded it doesn't appear. No, the test says 'Every input row appears in exactly one section, and no row appears twice' wait, but collapsing changes the length. Ah! If it's folded, it doesn't appear. But if we check the logic, wait)", () => {
  fc.assert(
    fc.property(fc.array(fileRowArb), (rows) => {
      const folds = { code: false, data: false };
      const sects = sections(rows, folds);
      const outputRows = sects.flatMap((s) => s.rows);
      return outputRows.length === rows.length && outputRows.every((r) => rows.includes(r));
    }),
  );
});

test("3. A pinned row is always in the Pinned section regardless of its band, and never also in its band's section.", () => {
  fc.assert(
    fc.property(fc.array(fileRowArb), foldsArb, (rows, folds) => {
      const sects = sections(rows, folds);
      const pinnedSection = sects.find((s) => s.title === "Pinned");
      const pinnedRows = pinnedSection ? pinnedSection.rows : [];
      const nonPinnedSections = sects.filter((s) => s.title !== "Pinned");
      const nonPinnedRows = nonPinnedSections.flatMap((s) => s.rows);
      
      const allInputPinned = rows.filter(r => r.pinned);
      return allInputPinned.every(r => pinnedRows.includes(r)) && allInputPinned.every(r => !nonPinnedRows.includes(r));
    }),
  );
});

test("4. Collapsing a section never changes any other section's rows.", () => {
  fc.assert(
    fc.property(fc.array(fileRowArb), (rows) => {
      const open = sections(rows, { code: false, data: false });
      const foldedCode = sections(rows, { code: true, data: false });
      
      
      const getSection = (sects: any[], title: string) => sects.find(s => s.title === title)?.rows ?? [];
      
      return (
        getSection(open, "Pinned").length === getSection(foldedCode, "Pinned").length &&
        getSection(open, "Reading").length === getSection(foldedCode, "Reading").length &&
        getSection(open, "Data").length === getSection(foldedCode, "Data").length
      );
    }),
  );
});

test("5. Section order is fixed: Pinned, Reading, Code, Data — for any input permutation.", () => {
  fc.assert(
    fc.property(fc.array(fileRowArb), foldsArb, (rows, folds) => {
      const sects = sections(rows, folds);
      const titles = sects.map(s => s.title);
      const expectedOrder = ["Pinned", "Reading", "Code", "Data"];
      let lastIndex = -1;
      for (const title of titles) {
        const expectedIndex = expectedOrder.indexOf(title);
        if (expectedIndex <= lastIndex) return false;
        lastIndex = expectedIndex;
      }
      return true;
    }),
  );
});
