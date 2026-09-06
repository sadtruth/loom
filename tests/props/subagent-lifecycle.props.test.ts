import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SubagentWatcher } from "../../server/subagent-watcher.ts";

/**
 * `start()` opened a 2-second directory poller and threw the handle away, so `stop()` had nothing
 * to clear. That is not a leaked timer: the interval closure holds the SubagentWatcher, whose
 * `onEmit` closes over the Watcher that owns the session's fully parsed transcript — so every
 * detached session stayed resident forever and kept scanning its directory. Prod, 2026-09-06:
 * 6.3 GB after 14 hours at a steady 20% CPU (record item 88).
 *
 * These tests count live intervals directly, because the symptom — memory that never comes back —
 * is only visible over hours, while the cause is one missing clearInterval.
 */
function withIntervalCounter<T>(body: (live: Set<unknown>) => T): T {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const live = new Set<unknown>();
  (globalThis as any).setInterval = (fn: any, ms: number) => {
    const handle = realSet(fn, ms);
    live.add(handle);
    return handle;
  };
  (globalThis as any).clearInterval = (handle: any) => {
    live.delete(handle);
    return realClear(handle);
  };
  try {
    return body(live);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

function scratchSession(): string {
  return mkdtempSync(join(tmpdir(), "loom-subagent-"));
}

const noRunner = { running: () => false } as any;

describe("a watcher that is stopped stops polling", () => {
  test("stop() clears the directory poller, not just the file watchers", () => {
    const dir = scratchSession();
    try {
      withIntervalCounter((live) => {
        const watcher = new SubagentWatcher(dir, () => {}, noRunner, "session-1");
        watcher.start();
        expect(live.size).toBe(1);
        watcher.stop();
        expect(live.size).toBe(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("many opened-and-closed sessions leave no poller behind", () => {
    const dirs = Array.from({ length: 20 }, () => scratchSession());
    try {
      withIntervalCounter((live) => {
        for (const [i, dir] of dirs.entries()) {
          const watcher = new SubagentWatcher(dir, () => {}, noRunner, `session-${i}`);
          watcher.start();
          watcher.stop();
        }
        expect(live.size).toBe(0);
      });
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stop() still closes the per-file watchers it opened", () => {
    const dir = scratchSession();
    mkdirSync(join(dir, "subagents"));
    writeFileSync(
      join(dir, "subagents", "agent-abc.jsonl"),
      JSON.stringify({ type: "assistant", stop_reason: "end_turn" }) + "\n",
    );
    try {
      withIntervalCounter((live) => {
        const emitted: unknown[] = [];
        const watcher = new SubagentWatcher(dir, (f) => emitted.push(f), noRunner, "session-2");
        watcher.start();
        // The file existed before start(), so the first pollDir picked it up and emitted it once.
        expect(emitted.length).toBe(1);
        expect(live.size).toBe(1);
        watcher.stop();
        expect(live.size).toBe(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
