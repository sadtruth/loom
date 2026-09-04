import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { readDraft, writeDraft, newerDraft } from "../../server/drafts.ts";

const arbKey = fc.stringMatching(/^(new:)?[A-Za-z0-9._-]{1,200}$/);
const arbBadKey = fc.string().filter((s) => !/^(new:)?[A-Za-z0-9._-]{1,200}$/.test(s));
const arbText = fc.string({ maxLength: 200000 }).filter((s) => s.length > 0);
const arbAt = fc.integer({ min: 0, max: 2_000_000_000_000 });
const arbDraft = fc.record({ text: arbText, at: arbAt });

describe("newerDraft pure properties", () => {
  test("picks the one with the larger at, ties to a", () => {
    fc.assert(
      fc.property(arbDraft, arbDraft, (a, b) => {
        const picked = newerDraft(a, b);
        if (a.at > b.at) expect(picked).toBe(a);
        else if (b.at > a.at) expect(picked).toBe(b);
        else expect(picked).toBe(a);
      })
    );
  });
});

describe("drafts filesystem properties", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "loom-drafts-test-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("keys outside regex are refused and write nothing", async () => {
    await fc.assert(
      fc.asyncProperty(arbBadKey, arbDraft, async (key, draft) => {
        const res = await writeDraft(tmpDir, key, draft);
        expect(res).toEqual({ text: "", at: 0 });
        const read = await readDraft(tmpDir, key);
        expect(read).toEqual({ text: "", at: 0 });
      })
    );
  });

  test("a value survives a read after write, empty text deletes", async () => {
    await fc.assert(
      fc.asyncProperty(arbKey, arbDraft, async (key, draft) => {
        await writeDraft(tmpDir, key, draft);
        const read = await readDraft(tmpDir, key);
        expect(read).toEqual(draft);

        await writeDraft(tmpDir, key, { text: "", at: draft.at + 1 });
        const readDeleted = await readDraft(tmpDir, key);
        expect(readDeleted).toEqual({ text: "", at: 0 });
      })
    );
  });

  test("last-writer-wins is order-independent and idempotent; an older at never overwrites a newer", async () => {
    await fc.assert(
      fc.asyncProperty(arbKey, fc.array(arbDraft, { minLength: 2, maxLength: 10 }), async (key, drafts) => {
        // Reset file for each property run
        const draftPath = join(tmpDir, "drafts", `${key}.json`);
        if (existsSync(draftPath)) rmSync(draftPath);

        const sortedDrafts = [...drafts].sort((a, b) => b.at - a.at);
        const newest = sortedDrafts[0];
        if (!newest) return;

        for (const draft of drafts) {
          await writeDraft(tmpDir, key, draft);
        }

        const read = await readDraft(tmpDir, key);
        expect(read.at).toBe(newest.at);

        const expectedDrafts = drafts.filter(d => d.at === newest.at);
        const expected = expectedDrafts[expectedDrafts.length - 1];
        if (!expected) return;
        expect(read.text).toBe(expected.text);
      })
    );
  });

  test("the text cap is enforced", async () => {
    await fc.assert(
      fc.asyncProperty(arbKey, async (key) => {
        const res = await writeDraft(tmpDir, key, { text: "x".repeat(200_001), at: 1 });
        expect(res).toEqual({ text: "", at: 0 });
        const read = await readDraft(tmpDir, key);
        expect(read).toEqual({ text: "", at: 0 });
      })
    );
  });
});
