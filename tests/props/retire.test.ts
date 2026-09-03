/**
 * A retired child always reports a terminal state (SPEC step 5, session-truth Next 3 / parent
 * item 64). `retire()` used to set `child.retiring = true` and say nothing; `reap()`'s guard —
 * `if (child.retiring || ...) return;` — then swallowed the exit it would otherwise have reported,
 * on every call site: a model/thinking-level change mid-turn, a dead pipe, eviction, and
 * `shutdown()`. User: *"i sometimes see 'working' spinning in session when in fact nothing is
 * happening there."*
 *
 * Driven against the REAL `Runner`, not a mock — `input.ts:533` spawns a real subprocess via
 * `Bun.spawn`, so `tests/stub-claude.ts` (the same stand-in the Playwright suite uses via
 * `LOOM_CLAUDE_BIN`) stands in for `claude`. Confirmed by spike before this file was written: the
 * constructor takes the stub path directly, no HTTP server required.
 *
 * NOT COVERED HERE, and said plainly rather than assumed: the "dead pipe" call site
 * (`input.ts:475`, `child.stdin.write` throwing). Three real-subprocess spikes (an immediately
 * exiting child, a child that closes its own stdin then sleeps, a large write to a closed-read-end
 * pipe) all show Bun's `FileSink.write()`/`flush()` completing WITHOUT throwing even once the read
 * end is provably gone — the error surfaces later, through `reap()`'s own exit-code path, not
 * through `send()`'s try/catch. That branch could not be driven into hermetically within this
 * build's effort budget; the other three call sites all route through the SAME `retire()`, so the
 * property under test — "queued > 0 at retire time ⇒ exactly one dropped event" — is exercised at
 * the one shared choke point regardless of which caller reached it.
 */

import { describe, expect, test } from "bun:test";
// evictionChoice is pure, so the cap's policy is pinned here without spawning anything.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner, escapeCwd, evictionChoice, type JobEvent, type StartRequest } from "../../server/input.ts";
import { createSpool, metaPath, sessionDir } from "../../server/spool.ts";

const HOUR = 60 * 60 * 1000;

describe("the child cap never cuts a live cache", () => {
  const NOW = 10 * HOUR;
  const cold = (id: string, lastUsed: number) => ({
    id,
    queued: 0,
    retiring: false,
    cacheAt: NOW - 2 * HOUR,
    lastUsed,
    background: false,
  });
  const warm = (id: string, lastUsed: number) => ({
    id,
    queued: 0,
    retiring: false,
    cacheAt: NOW - 60_000,
    lastUsed,
    background: false,
  });

  test("a cold idle child is the one chosen", () => {
    expect(evictionChoice([cold("a", 1), warm("b", 0)], NOW)).toBe("a");
  });

  test("the OLDEST cold child goes, not merely a cold one", () => {
    expect(evictionChoice([cold("a", 5), cold("b", 1), cold("c", 9)], NOW)).toBe("b");
  });

  // The whole point. Least-recently-used alone would answer "b" here and throw a live cache away.
  test("every child warm ⇒ nobody is cut, however many there are", () => {
    const many = [warm("a", 9), warm("b", 1), warm("c", 5), warm("d", 3), warm("e", 7), warm("f", 2)];
    expect(evictionChoice(many, NOW)).toBeNull();
  });

  test("a busy child is never cut even with a stone-cold cache", () => {
    const busy = { id: "a", queued: 3, retiring: false, cacheAt: 0, lastUsed: 0, background: false };
    expect(evictionChoice([busy], NOW)).toBeNull();
  });

  test("a child already retiring is not chosen again", () => {
    const going = { id: "a", queued: 0, retiring: true, cacheAt: 0, lastUsed: 0, background: false };
    expect(evictionChoice([going, cold("b", 5)], NOW)).toBe("b");
  });

  // Two-sided on the boundary itself, so a rule that simply never evicted could not pass.
  test("the boundary is the cache hour, exactly", () => {
    const justWarm = { id: "a", queued: 0, retiring: false, cacheAt: NOW - HOUR + 1, lastUsed: 0, background: false };
    const justCold = { id: "b", queued: 0, retiring: false, cacheAt: NOW - HOUR, lastUsed: 0, background: false };
    expect(evictionChoice([justWarm], NOW)).toBeNull();
    expect(evictionChoice([justCold], NOW)).toBe("b");
  });

  /**
   * The 2026-09-01 rule, and the mutation that must make it red: delete `|| c.background` from
   * `evictionChoice` and this test answers "a" instead of null. It calls the REAL function — a copy
   * of the policy asserted against itself would stay green with the guard gone, which is exactly how
   * the first build's mutation pin failed.
   */
  test("a child waiting on background work is never cut, however cold its cache", () => {
    const waiting = { id: "a", queued: 0, retiring: false, cacheAt: 0, lastUsed: 0, background: true };
    expect(evictionChoice([waiting], NOW)).toBeNull();
    // …and when there IS a cuttable child, the waiting one is passed over rather than preferred as
    // least-recently-used, which is precisely what it would be: `lastUsed: 0` is the oldest here.
    expect(evictionChoice([waiting, cold("b", 5)], NOW)).toBe("b");
  });
});

const ROOT = join(import.meta.dir, "..", "..");
const STUB = join(ROOT, "tests", "stub-claude.ts");

function base(sessionId: string, cwd: string): StartRequest {
  return {
    sessionId,
    resume: false,
    cwd,
    text: "",
    mode: "auto",
    model: "default",
    effort: "default",
    browser: false,
    images: [],
  };
}

/** A fresh Runner, a scratch transcript root the stub writes into, and a matching scratch cwd. */
async function harness(): Promise<{
  runner: Runner;
  events: JobEvent[];
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  const projectsRoot = await mkdtemp(join(tmpdir(), "loom-retire-projects-"));
  const cwd = await mkdtemp(join(tmpdir(), "loom-retire-cwd-"));
  // Each Runner owns a spool tree of its own (SPEC 241): a shared one would let one case adopt the
  // previous case's children, which is exactly the isolation the per-port keying buys in production.
  const spool = await mkdtemp(join(tmpdir(), "loom-retire-spool-"));
  process.env["LOOM_SPOOL"] = spool;
  // `spawn` inherits `process.env` (input.ts's `Bun.spawn` call), so setting this on the TEST
  // process is what the real server does via its own environment at boot.
  process.env["LOOM_PROJECTS_ROOT"] = projectsRoot;
  const events: JobEvent[] = [];
  const runner = new Runner(STUB, "http://127.0.0.1:1/no-permit-in-this-test", 0, (e: JobEvent) => events.push(e));
  return {
    runner,
    events,
    cwd,
    cleanup: async () => {
      runner.shutdown();
      await rm(projectsRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(spool, { recursive: true, force: true });
    },
  };
}

describe("retire(): a turn in flight always gets exactly one terminal event", () => {
  test("model change mid-turn drops the turn that was queued, exactly once", async () => {
    const { runner, events, cwd, cleanup } = await harness();
    try {
      const id = "retire-model-change";
      const first = runner.send({ ...base(id, cwd), text: "slow" });
      expect(first.ok).toBe(true);
      await Bun.sleep(150); // the "slow" turn is genuinely queued before the picker changes model
      const second = runner.send({ ...base(id, cwd), text: "second turn", model: "opus" });
      expect(second.ok).toBe(true);

      const dropped = events.filter((e) => e.sessionId === id && e.detail?.includes("dropped") === true);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.state).toBe("error");
      expect(dropped[0]?.detail).toContain("respawn for a new model or thinking level");

      // Let the fresh child (spawned for the new model) actually answer, then confirm the ONE
      // dropped event never grows a second — `reap()`'s guard is what used to (and must still)
      // stop a late exit frame from resurrecting a report for a retirement already announced.
      await Bun.sleep(500);
      const droppedAfter = events.filter((e) => e.sessionId === id && e.detail?.includes("dropped") === true);
      expect(droppedAfter).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("shutdown() mid-turn drops every session that still had one queued, exactly once each", async () => {
    const { runner, events, cwd, cleanup } = await harness();
    try {
      const busy = "retire-shutdown-busy";
      const idle = "retire-shutdown-idle";
      const busySend = runner.send({ ...base(busy, cwd), text: "slow" });
      expect(busySend.ok).toBe(true);
      const idleSend = runner.send({ ...base(idle, cwd), text: "quick hello" });
      expect(idleSend.ok).toBe(true);
      await Bun.sleep(150); // "quick hello" has almost certainly already answered; "slow" has not
      // long enough for the quick turn's `result` frame to land and clear its queue
      await Bun.sleep(400);

      runner.shutdown();
      await Bun.sleep(100);

      const busyDropped = events.filter((e) => e.sessionId === busy && e.detail?.includes("dropped") === true);
      expect(busyDropped).toHaveLength(1);
      expect(busyDropped[0]?.detail).toContain("loom shutting down");

      // The idle session had nothing queued when shutdown reached it — the design's "where idle, it
      // clears the flag" case: no dropped-turn event, because there was no turn to drop.
      const idleDropped = events.filter((e) => e.sessionId === idle && e.detail?.includes("dropped") === true);
      expect(idleDropped).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("an idle eviction (queued === 0) reports nothing dropped — there was no turn to lose", async () => {
    const { runner, events, cwd, cleanup } = await harness();
    try {
      // MAX_LIVE is 4 (server/input.ts, not exported): the 5th DISTINCT idle session forces the
      // LRU idle child out via `evictIfCrowded` → `retire(oldestId, "making room")`, the same
      // queued-always-0 shape as the real idle-timeout path (`armIdle`'s `retire(id, "idle")`),
      // without needing to wait out `idleDelay`'s real five-minute floor.
      const ids = ["evict-1", "evict-2", "evict-3", "evict-4", "evict-5"];
      for (const id of ids) {
        const result = runner.send({ ...base(id, cwd), text: `hello from ${id}` });
        expect(result.ok).toBe(true);
        // Answered (a `result` frame) before the NEXT one spawns, so every prior child is IDLE —
        // `evictIfCrowded` only ever retires an idle one; a busy one is never the one it picks.
        await Bun.sleep(250);
      }

      const dropped = events.filter((e) => e.detail?.includes("dropped") === true);
      expect(dropped).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});

/**
 * The 2026-09-01 loss, end to end: a session that had launched an hour-long sweep looked exactly
 * like one nobody was using, the idle timer retired it, and SIGKILL took the background subprocess
 * with it — the command's output never landed at all, and the resume re-wrote 174,202 tokens.
 * User: *"this is a catastrophe!"*
 *
 * Driven against the real `Runner`, its real timer and a real transcript on disk, with `LOOM_IDLE_MS`
 * standing in for the hour. The predicate's own shapes are pinned purely in
 * `background-work.props.test.ts`; what is untested until here is whether the TIMER consults it —
 * and that is the call site that did the damage. The cap's half is `evictionChoice`, pinned above.
 */
describe("the idle timer never retires a session waiting on work it started", () => {
  const launch = `${JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 3600", run_in_background: true } },
      ],
    },
  })}\n${JSON.stringify({
    // The result a background Bash gets back IMMEDIATELY. It says the command started, not what it
    // said — and clearing the pending entry on it is precisely the bug this file exists to catch.
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_bg",
          content: "Command running in background with ID: bgz1. Output is being written to: /tmp/bgz1.output",
        },
      ],
    },
  })}\n`;

  const done = `${JSON.stringify({
    type: "user",
    message: { role: "user", content: "<task-notification>\n<task-id>bgz1</task-id>\n<status>completed</status>\n</task-notification>" },
  })}\n`;

  test("it defers while the command runs, and retires once the notification lands", async () => {
    // Short enough to drive, long enough that a plant lands before the first firing.
    process.env["LOOM_IDLE_MS"] = "200";
    const { runner, cwd, cleanup } = await harness();
    const sessionId = "idle-waiting";
    try {
      // Written BEFORE the child exists, so there is no race with the first timer: the stub appends
      // its own rows to this same file, exactly where a real `claude` would.
      const dir = join(process.env["LOOM_PROJECTS_ROOT"] ?? "", escapeCwd(cwd));
      mkdirSync(dir, { recursive: true });
      const transcript = join(dir, `${sessionId}.jsonl`);
      writeFileSync(transcript, launch);

      expect(runner.send({ ...base(sessionId, cwd), text: "hello" }).ok).toBe(true);
      // Four idle windows. Under the old rule the first one killed it.
      await Bun.sleep(800);
      expect(runner.testLive(sessionId)).toBe(true);

      // Now the command reports. The child must go — and it can only go if the deferring timer
      // RE-ARMED: that timer has already fired, so a deferral that merely returns makes the child
      // immortal, which is a different bug and just as wrong.
      appendFileSync(transcript, done);
      await Bun.sleep(800);
      expect(runner.testLive(sessionId)).toBe(false);
    } finally {
      delete process.env["LOOM_IDLE_MS"];
      await cleanup();
    }
  });

  test("with nothing in flight the same timer retires on schedule — the pin is two-sided", async () => {
    process.env["LOOM_IDLE_MS"] = "200";
    const { runner, cwd, cleanup } = await harness();
    try {
      const sessionId = "idle-quiet";
      expect(runner.send({ ...base(sessionId, cwd), text: "hello" }).ok).toBe(true);
      await Bun.sleep(800);
      expect(runner.testLive(sessionId)).toBe(false);
    } finally {
      delete process.env["LOOM_IDLE_MS"];
      await cleanup();
    }
  });
});

/**
 * A reap drops only the spool its own child owns (dropIfStillOurs).
 *
 * When a session respawns (for a new model or thinking level), the retiring child and the new child
 * share a spool directory keyed by session id. In the window between `createSpool` and the new child
 * persisting its `meta.json`, `readMeta` returns null. A reap for the retiring child must NOT fall
 * through and delete the newly spawned child's spool.
 */
describe("a reap only drops the spool its own child owns", () => {
  test("a retiring child never drops a respawned child's spool in the pre-meta window", async () => {
    const { runner, cwd, cleanup } = await harness();
    const sessionId = "reap-pre-meta-spool";
    try {
      const first = runner.send({ ...base(sessionId, cwd), text: "slow" });
      expect(first.ok).toBe(true);
      await Bun.sleep(150);

      const dir = sessionDir(0, sessionId);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(metaPath(dir))).toBe(true);

      // Simulate the second child's spawn window: createSpool recreated the directory, but meta.json
      // is not yet written.
      createSpool(0, sessionId);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(metaPath(dir))).toBe(false);

      // Run the reap path for the first child.
      runner.testRetire(sessionId, "respawn for a new model or thinking level");
      await Bun.sleep(200);

      // The new child's spool must still be there.
      expect(existsSync(dir)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

