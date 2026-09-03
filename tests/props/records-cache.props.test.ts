/**
 * The record scan's cache (SPEC 231).
 *
 * User, 2026-08-23, clicking between two projects in the rail: *"each click goes longer than a
 * second to load the session"*. Measured, the whole wait was `/api/records/sessions` at 783ms
 * waiting on an uncached walk of 4,487 files, fired by four routes at once.
 *
 * WHAT THESE CASES OBSERVE. A walk is not directly countable from outside without a mock, and a
 * mock of the filesystem would test the mock. So they use the array IDENTITY of the answer: a
 * cached or coalesced answer is the same array instance the walk produced, and a real second walk
 * can only ever be a new one. That makes "did it walk again?" observable without touching the
 * scanner, and it is the same question the cache exists to answer.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateRecords, scanRecords, scanRecordsUncached } from "../../server/records.ts";

const RECORD = `---
type: project
status: active
created: 2026-08-23
---

# A project
`;

/** A root nobody else in this file shares — the cache is keyed by the roots, so this is isolation. */
function root(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `loom-cache-${name}-`));
  mkdirSync(join(dir, "one"));
  writeFileSync(join(dir, "one", "project.md"), RECORD);
  return dir;
}

const TTL_MS = Number(Bun.env["LOOM_RECORDS_TTL_MS"] ?? 2_000);

describe("the record scan is cached", () => {
  test("two concurrent asks make ONE walk", async () => {
    const dir = root("flight");
    const [a, b] = await Promise.all([scanRecords([dir]), scanRecords([dir])]);
    expect(a).toHaveLength(1);
    // Same instance means the second caller awaited the first walk instead of starting its own.
    expect(a).toBe(b);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a second ask inside the TTL is served from memory", async () => {
    const dir = root("ttl-hit");
    const first = await scanRecords([dir]);
    const second = await scanRecords([dir]);
    expect(second).toBe(first);
    rmSync(dir, { recursive: true, force: true });
  });

  test("past the TTL the held answer still goes out at once, and the walk runs behind it", async () => {
    const dir = root("ttl-refresh");
    const first = await scanRecords([dir]);
    // A record written by something other than loom — nothing invalidates for it.
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "project.md"), RECORD);
    await Bun.sleep(TTL_MS + 100);

    // The reader waits for nothing: it gets the very array it got before.
    const served = await scanRecords([dir]);
    expect(served).toBe(first);
    expect(served).toHaveLength(1);

    // And the refresh that ask started lands, so the next reader sees the new record.
    await Bun.sleep(300);
    const after = await scanRecords([dir]);
    expect(after).not.toBe(first);
    expect(after).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("two roots are two questions and never share an answer", async () => {
    const a = root("key-a");
    const b = root("key-b");
    mkdirSync(join(b, "two"));
    writeFileSync(join(b, "two", "project.md"), RECORD);
    expect(await scanRecords([a])).toHaveLength(1);
    expect(await scanRecords([b])).toHaveLength(2);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});

describe("a write loom makes is visible to the very next read (231)", () => {
  test("invalidateRecords drops the answer, and the new record is in the next one", async () => {
    const dir = root("invalidate");
    const before = await scanRecords([dir]);
    expect(before).toHaveLength(1);

    mkdirSync(join(dir, "second"));
    writeFileSync(join(dir, "second", "project.md"), RECORD);
    // Without the invalidation this is still the stale answer — that is the point of the case.
    expect(await scanRecords([dir])).toBe(before);

    invalidateRecords();
    const after = await scanRecords([dir]);
    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a walk already running when a write lands is NOT remembered", async () => {
    const dir = root("race");
    // Start the walk, then invalidate while it is still reading — the shape of a POST landing in
    // the middle of a scan that began before it.
    const running = scanRecords([dir]);
    invalidateRecords();
    const raced = await running;
    // The caller still gets an answer; it must simply not have been kept.
    expect(raced).toHaveLength(1);
    const next = await scanRecords([dir]);
    expect(next).not.toBe(raced);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a miss is never answered from memory (231)", () => {
  test("scanRecordsUncached sees a record written after the cached answer", async () => {
    const dir = root("heal");
    const cached = await scanRecords([dir]);
    expect(cached).toHaveLength(1);
    mkdirSync(join(dir, "fresh"));
    writeFileSync(join(dir, "fresh", "project.md"), RECORD);
    expect(await scanRecords([dir])).toHaveLength(1); // still the cached answer
    expect(await scanRecordsUncached([dir])).toHaveLength(2); // the way past it
    rmSync(dir, { recursive: true, force: true });
  });
});
