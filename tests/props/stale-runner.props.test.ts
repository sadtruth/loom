/**
 * Runner staleness and queue reconciliation (SPEC 267, 268).
 *
 * The runner's witness of "a turn is in flight" must be able to say "no" when the transcript shows
 * the turn ended and frames have gone silent for WORKING_SILENCE_MS. When found stale, the runner
 * reconciles immediately: queued turns are cleared, stepper is reset, and idle is armed.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKING_SILENCE_MS } from "../../server/activity.ts";
import { Runner, type JobEvent, type StartRequest } from "../../server/input.ts";

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

async function harness(): Promise<{
  runner: Runner;
  events: JobEvent[];
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  const projectsRoot = await mkdtemp(join(tmpdir(), "loom-stale-projects-"));
  const cwd = await mkdtemp(join(tmpdir(), "loom-stale-cwd-"));
  const spool = await mkdtemp(join(tmpdir(), "loom-stale-spool-"));
  process.env["LOOM_SPOOL"] = spool;
  process.env["LOOM_PROJECTS_ROOT"] = projectsRoot;
  const events: JobEvent[] = [];
  const runner = new Runner(STUB, "http://127.0.0.1:1/no-permit", 0, (e: JobEvent) => events.push(e));
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

describe("Runner.stale (SPEC 267, 268)", () => {
  test("stale is false while frames keep arriving, whatever the transcript says", async () => {
    const { runner, cwd, cleanup } = await harness();
    try {
      const id = "fresh-frames-session";
      const res = runner.send({ ...base(id, cwd), text: "slow" });
      expect(res.ok).toBe(true);
      expect(runner.queued(id)).toBe(1);

      // Frame arrived recently (now is within silence window of lastFrameAt)
      const now = Date.now();
      expect(runner.stale(id, true, now)).toBe(false);
      expect(runner.stale(id, false, now)).toBe(false);
      expect(runner.queued(id)).toBe(1);
      expect(runner.running(id)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("stale is false when transcript's newest row does not end a turn (long-running Bash case)", async () => {
    const { runner, cwd, cleanup } = await harness();
    try {
      const id = "long-bash-session";
      const res = runner.send({ ...base(id, cwd), text: "slow" });
      expect(res.ok).toBe(true);
      expect(runner.queued(id)).toBe(1);

      // 20 minutes of silence have elapsed, but transcript says newest row is a tool_use (did NOT end turn)
      const twentyMinutesLater = Date.now() + 20 * 60 * 1000;
      const transcriptSaysEnded = false; // e.g. stop_reason is tool_use

      expect(runner.stale(id, transcriptSaysEnded, twentyMinutesLater)).toBe(false);
      expect(runner.queued(id)).toBe(1);
      expect(runner.running(id)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("stale is true only when both conditions hold, and reconciling sets queued to 0 and clears pending", async () => {
    const { runner, events, cwd, cleanup } = await harness();
    try {
      const id = "stale-session-reconcile";
      const res1 = runner.send({ ...base(id, cwd), text: "turn 1" });
      const res2 = runner.send({ ...base(id, cwd), text: "turn 2" });
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(runner.queued(id)).toBe(2);
      expect(runner.pending(id)).toHaveLength(2);

      // Advance clock past WORKING_SILENCE_MS with transcript indicating ended turn
      const pastSilence = Date.now() + WORKING_SILENCE_MS + 1000;
      const isStale = runner.stale(id, true, pastSilence);
      expect(isStale).toBe(true);

      // Queue is reconciled immediately
      expect(runner.queued(id)).toBe(0);
      expect(runner.pending(id)).toEqual([]);
      expect(runner.running(id)).toBe(false);
      expect(runner.step(id)).toEqual({ step: null, stepMs: 0 });

      // Emitted a terminal done event
      const doneEvents = events.filter((e) => e.sessionId === id && e.state === "done");
      expect(doneEvents.length).toBeGreaterThan(0);
      const lastDone = doneEvents[doneEvents.length - 1];
      expect(lastDone?.queued).toBe(0);
      expect(lastDone?.pending).toEqual([]);
      expect(lastDone?.detail).toContain("reconciled stale queue");

      // Subsequent check is no longer stale (queued is 0)
      expect(runner.stale(id, true, pastSilence)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("stale is false when queued is already 0", async () => {
    const { runner, cleanup } = await harness();
    try {
      const id = "idle-session";
      expect(runner.queued(id)).toBe(0);
      expect(runner.stale(id, true, Date.now() + 1000_000)).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("Queue conservation (Part B property and pins)", () => {
  test("property: after N sends and N landings, queued is 0", async () => {
    const { runner, cwd, cleanup } = await harness();
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (numSends) => {
          const id = "props-queue-" + crypto.randomUUID().slice(0, 8);
          for (let i = 0; i < numSends; i++) {
            const res = runner.send({ ...base(id, cwd), text: "send " + i });
            expect(res.ok).toBe(true);
          }
          expect(runner.queued(id)).toBe(numSends);

          // Wait for all turns to land
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline && runner.queued(id) > 0) {
            await Bun.sleep(50);
          }
          expect(runner.queued(id)).toBe(0);
          expect(runner.pending(id)).toEqual([]);
        }),
        { numRuns: 10 },
      );
    } finally {
      await cleanup();
    }
  });

  test("reproduction pin 1: interrupt settles queued to 0", async () => {
    const { runner, cwd, cleanup } = await harness();
    try {
      const id = "pin-interrupt";
      runner.send({ ...base(id, cwd), text: "slow" });
      expect(runner.queued(id)).toBe(1);
      await Bun.sleep(150);
      const intOk = await runner.interrupt(id);
      expect(intOk).toBe(true);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && runner.queued(id) > 0) {
        await Bun.sleep(50);
      }
      expect(runner.queued(id)).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test("reproduction pin 2: two turns queued both land, queued returns to 0", async () => {
    const { runner, cwd, cleanup } = await harness();
    try {
      const id = "pin-two-turns";
      runner.send({ ...base(id, cwd), text: "turn 1" });
      runner.send({ ...base(id, cwd), text: "turn 2" });
      expect(runner.queued(id)).toBe(2);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && runner.queued(id) > 0) {
        await Bun.sleep(50);
      }
      expect(runner.queued(id)).toBe(0);
      expect(runner.pending(id)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("reproduction pin 3: send after retire leaves child cleanly tracked", async () => {
    const { runner, cwd, cleanup } = await harness();
    try {
      const id = "pin-retire-send";
      runner.send({ ...base(id, cwd), text: "slow" });
      expect(runner.queued(id)).toBe(1);
      runner.testRetire(id, "pin test retire");
      expect(runner.queued(id)).toBe(0);
      runner.send({ ...base(id, cwd), text: "turn after retire" });
      expect(runner.queued(id)).toBe(1);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && runner.queued(id) > 0) {
        await Bun.sleep(50);
      }
      expect(runner.queued(id)).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
