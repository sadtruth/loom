/**
 * P17 — the live block meter's INCREMENTAL reader (server/bar.ts).
 *
 * The arithmetic is pinned next door (block.props.test.ts). The risk here is different and it is
 * all in the tailing: a file grows while it is being read, the last line is half-written, and one
 * API call writes several records that must be counted ONCE. Each of those, got wrong, produces a
 * meter that is merely a bit off — the failure mode nobody catches by looking.
 *
 * So the oracle is a differential one: the same rows, read incrementally in pieces, must produce
 * exactly what a cold index of the finished file produces. That comparison cannot be satisfied by
 * accident, and it does not depend on my guessing which split is the awkward one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBar, resetBarIndex } from "../../server/bar.ts";

let dir = "";
const NOW = Date.now();

/** One assistant record, in the shape the CLI writes. */
function record(at: number, requestId: string, read: number, output: number): string {
  return (
    JSON.stringify({
      type: "assistant",
      requestId,
      timestamp: new Date(at).toISOString(),
      sessionId: "s1",
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "hi" }],
        usage: {
          cache_read_input_tokens: read,
          cache_creation_input_tokens: 0,
          input_tokens: 1,
          output_tokens: output,
        },
      },
    }) + "\n"
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loom-bar-"));
  await mkdir(join(dir, "proj"), { recursive: true });
  process.env["LOOM_BAR_ARCHIVE"] = dir;
  resetBarIndex();
});

afterEach(async () => {
  delete process.env["LOOM_BAR_ARCHIVE"];
  await rm(dir, { recursive: true, force: true });
});

describe("the meter reads a live archive", () => {
  test("an empty archive is an empty block, not an error", async () => {
    const bar = await readBar(NOW, 0);
    expect(bar.spent).toBe(0);
    expect(bar.calls).toBe(0);
    expect(bar.used).toBe(0);
  });

  test("one API call's several records are counted ONCE", async () => {
    const path = join(dir, "proj", "a.jsonl");
    // A parallel tool batch: three content blocks, three records, one requestId, one bill.
    await writeFile(
      path,
      record(NOW - 60_000, "req-1", 100_000, 500) +
        record(NOW - 60_000, "req-1", 100_000, 500) +
        record(NOW - 60_000, "req-1", 100_000, 500),
    );
    const bar = await readBar(NOW, 0);
    expect(bar.calls).toBe(1);
  });

  test("DIFFERENTIAL: reading in pieces equals reading it whole", async () => {
    const path = join(dir, "proj", "a.jsonl");
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) rows.push(record(NOW - (40 - i) * 60_000, `req-${i}`, 90_000 + i, 300 + i));

    // Incremental: write a few rows, read the meter, write a few more — the live case.
    for (let i = 0; i < rows.length; i += 7) {
      await appendFile(path, rows.slice(i, i + 7).join(""));
      await readBar(NOW, 0);
    }
    const incremental = await readBar(NOW, 0);

    // Cold: a fresh index over the finished file.
    resetBarIndex();
    const cold = await readBar(NOW, 0);

    expect(incremental.calls).toBe(cold.calls);
    expect(incremental.spent).toBe(cold.spent);
    expect(incremental.calls).toBe(40);
  });

  test("a half-written last line is picked up once it is finished, never dropped", async () => {
    const path = join(dir, "proj", "a.jsonl");
    const first = record(NOW - 60_000, "req-1", 100_000, 500);
    const second = record(NOW - 30_000, "req-2", 100_000, 500);

    // The shape that matters: a COMPLETE line the reader must consume and advance past, followed
    // by a torn one it must leave behind. A file holding only a torn line exercises a different
    // branch and would pass against an offset that jumps straight to the file size.
    await writeFile(path, first + second.slice(0, 40));
    expect((await readBar(NOW, 0)).calls).toBe(1);

    // The writer finishes the row. An offset parked past it loses the call for good.
    await writeFile(path, first + second);
    expect((await readBar(NOW, 0)).calls).toBe(2);
  });

  test("a file holding nothing but a torn line yields nothing, and recovers", async () => {
    const path = join(dir, "proj", "a.jsonl");
    const whole = record(NOW - 60_000, "req-1", 100_000, 500);
    await writeFile(path, whole.slice(0, 40));
    expect((await readBar(NOW, 0)).calls).toBe(0);
    await writeFile(path, whole);
    expect((await readBar(NOW, 0)).calls).toBe(1);
  });

  test("the reading answers the question it is drawn for", async () => {
    const path = join(dir, "proj", "a.jsonl");
    let rows = "";
    for (let i = 0; i < 20; i++) rows += record(NOW - (20 - i) * 60_000, `req-${i}`, 145_000, 430);
    await writeFile(path, rows);
    const bar = await readBar(NOW, 0);

    expect(bar.calls).toBe(20);
    expect(bar.context).toBeGreaterThan(140_000);
    // ~24% of a real block is output; a meter that lost the output component would read ~0 here.
    expect(bar.outputShare).toBeGreaterThan(0.1);
    // The block runs five hours from the first call, floored to the 10-minute mark.
    expect(bar.resets).toBeGreaterThan(NOW);
    expect(bar.callsLeft).toBeGreaterThan(0);
  });
});
