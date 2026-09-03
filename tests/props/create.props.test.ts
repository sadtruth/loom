/**
 * Hand creation and rename (SPEC §Create-and-rename). Same posture as tasks.props: these writes
 * land in the vault, so the properties are about what they may NOT do — creation under a parent
 * must add exactly its own two lines and nothing else; rename must touch exactly the `#` line and
 * exactly the parent's referencing lead. The metamorphic anchor is rename A→B→A: both files must
 * come back byte-identical, which no single-run assertion can fake.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import fc from "fast-check";
import { createRecord, parseRecord, renameRecord, writeAtomic } from "../../server/tasks.ts";

const TITLE = fc.stringMatching(/^[A-Za-zА-Яа-я0-9 ,.()—-]{1,40}$/).filter((t) => t.trim().length > 0);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const PARENT = `---
type: project
status: active
created: 2026-08-05
---

# Fixture parent for creation

## Frame

**Need.** Prove hand creation stays confined.

## Next

1. [x] **Already done** — result was earned.
   result: shipped. — 2026-08-05
2. [ ] **Still open** — untouched by anything here.

## Log

- 2026-08-05 — the round happened.
`;

async function freshParent(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-create-"));
  const path = join(dir, "project.md");
  await writeAtomic(path, PARENT);
  return path;
}

describe("createRecord under a parent", () => {
  test("adds exactly its own two lines to the parent, and the child parses", async () => {
    await fc.assert(
      fc.asyncProperty(TITLE, async (title) => {
        const parent = await freshParent();
        const before = PARENT.split("\n");
        const { child } = await createRecord(title, parent, dirname(parent), "2026-08-09");

        const childText = await readFile(child, "utf8");
        const childDoc = parseRecord(childText);
        expect(/^#\s+(.+)$/m.exec(childText)?.[1]).toBe(oneLine(title).replace(/\s+—\s+/, " — "));
        expect(/^status: framing$/m.test(childText)).toBe(true);
        expect(await Bun.file(join(dirname(child), "brief.md")).exists()).toBe(false);
        expect(childDoc.tasks.length).toBe(1);

        const after = (await readFile(parent, "utf8")).split("\n");
        expect(after.length).toBe(before.length + 2);
        // CONFINEMENT at the creation grain: strip the two inserted lines and the parent is
        // byte-identical to what it was.
        let at = 0;
        while (at < before.length && after[at] === before[at]) at += 1;
        expect([...after.slice(0, at), ...after.slice(at + 2)]).toEqual(before);

        const added = parseRecord(after.join("\n")).tasks.at(-1);
        expect(added?.status).toBe("promoted");
        expect(added === undefined || added.subproject === null ? null : resolve(dirname(parent), added.subproject)).toBe(
          resolve(child),
        );
      }),
      { numRuns: 40 },
    );
  });

  test("a colliding title gets the -2 directory, both records live", async () => {
    const parent = await freshParent();
    const first = await createRecord("Same name", parent, dirname(parent), "2026-08-09");
    const second = await createRecord("Same name", parent, dirname(parent), "2026-08-09");
    expect(dirname(first.child).endsWith("same-name")).toBe(true);
    expect(dirname(second.child).endsWith("same-name-2")).toBe(true);
    expect(await Bun.file(first.child).exists()).toBe(true);
    expect(await Bun.file(second.child).exists()).toBe(true);
  });
});

describe("createRecord at the root", () => {
  test("no parent line, directory under the root, skeleton parses", async () => {
    await fc.assert(
      fc.asyncProperty(TITLE, async (title) => {
        const root = mkdtempSync(join(tmpdir(), "loom-root-"));
        const { child } = await createRecord(title, null, root, "2026-08-09");
        const text = await readFile(child, "utf8");
        expect(dirname(dirname(child))).toBe(root);
        expect(/^parent:/m.test(text)).toBe(false);
        expect(/^status: framing$/m.test(text)).toBe(true);
        expect(parseRecord(text).tasks.length).toBe(1);
      }),
      { numRuns: 25 },
    );
  });
});

describe("renameRecord", () => {
  test("A→B changes exactly the # line and the parent's lead; A→B→A restores both byte-identical", async () => {
    await fc.assert(
      fc.asyncProperty(TITLE, TITLE, async (a, b) => {
        fc.pre(oneLine(a) !== oneLine(b));
        const parent = await freshParent();
        const { child } = await createRecord(a, parent, dirname(parent), "2026-08-09");
        const childBefore = await readFile(child, "utf8");
        const parentBefore = await readFile(parent, "utf8");
        const titleA = /^#\s+(.+)$/m.exec(childBefore)?.[1] ?? "";

        await renameRecord(child, b, titleA);

        const childAfter = (await readFile(child, "utf8")).split("\n");
        const childWas = childBefore.split("\n");
        const changed = childWas.filter((line, i) => childAfter[i] !== line);
        expect(childAfter.length).toBe(childWas.length);
        expect(changed).toEqual([`# ${titleA}`]);

        const parentAfter = (await readFile(parent, "utf8")).split("\n");
        const parentWas = parentBefore.split("\n");
        expect(parentAfter.length).toBe(parentWas.length);
        const parentChanged = parentWas.filter((line, i) => parentAfter[i] !== line);
        expect(parentChanged.length).toBe(1);
        expect(parentChanged[0]?.includes("[>]")).toBe(true);

        const titleB = /^#\s+(.+)$/m.exec(childAfter.join("\n"))?.[1] ?? "";
        await renameRecord(child, titleA, titleB);
        expect(await readFile(child, "utf8")).toBe(childBefore);
        expect(await readFile(parent, "utf8")).toBe(parentBefore);
      }),
      { numRuns: 40 },
    );
  });

  test("a stale expect is refused and writes nothing", async () => {
    const parent = await freshParent();
    const { child } = await createRecord("Original title", parent, dirname(parent), "2026-08-09");
    const before = await readFile(child, "utf8");
    await expect(renameRecord(child, "New title", "What someone else saw")).rejects.toThrow(/changed under you/);
    expect(await readFile(child, "utf8")).toBe(before);
  });
});
