/**
 * The session summary memo (SPEC 232).
 *
 * Found while measuring 231: with the record scan cached, `/api/records/sessions` still took
 * 332-390ms, and that is the request the rail waits on before a clicked project's socket can open.
 * The store holds 251 transcripts and a gigabyte; every call was reading 256KiB of head and 64KiB
 * of tail from each and parsing both to fill in five fields.
 *
 * A transcript is append-only, so `mtime:size` names its bytes exactly. These cases hold the memo
 * to that claim: the same file is summarised once, and a file that GREW is summarised again.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions } from "../../server/sessions.ts";

const ROW = (text: string, at: string): string =>
  `${JSON.stringify({ type: "user", timestamp: at, message: { content: text } })}\n`;

function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-summaries-"));
  writeFileSync(join(dir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl"), ROW("first", "2026-08-23T10:00:00.000Z"));
  return dir;
}

describe("a session is summarised once per (mtime, size)", () => {
  test("an unchanged file is not read again", async () => {
    const dir = store();
    const first = await listSessions(dir);
    const second = await listSessions(dir);
    expect(first).toHaveLength(1);
    // The ARRAY is rebuilt each call; the summary inside it is the remembered object.
    expect(second[0]).toBe(first[0]);
    expect(first[0]?.firstPrompt).toBe("first");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file that grew is summarised again, and the new content is in it", async () => {
    const dir = store();
    const file = join(dir, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
    const before = await listSessions(dir);
    appendFileSync(file, JSON.stringify({ type: "ai-title", aiTitle: "A named session" }) + "\n");
    const after = await listSessions(dir);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]?.title).toBe("A named session");
    expect(after[0]?.bytes).toBeGreaterThan(before[0]?.bytes ?? 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("two stores do not share a summary", async () => {
    const a = store();
    const b = store();
    const one = await listSessions(a);
    const two = await listSessions(b);
    expect(two[0]).not.toBe(one[0]);
    expect(two[0]?.file).not.toBe(one[0]?.file);
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});
