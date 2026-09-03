/**
 * A restart does not kill the sessions running inside loom (SPEC 255).
 *
 * This is the file the whole `restart-without-killing-sessions` record exists for. Three incidents
 * — 2026-08-05 twice, 2026-08-15 once — ended a live session mid-work because a deploy restarted
 * loom, and `KillMode=process` only ever spared the child the SIGTERM: the kernel still closed
 * loom's ends of its pipes, the CLI saw EOF on stdin, and it exited.
 *
 * Driven against the REAL `Runner` and a REAL subprocess (`tests/stub-claude.ts`, the same stand-in
 * the Playwright suite injects as `LOOM_CLAUDE_BIN`), because everything under test here is process
 * and file-descriptor behaviour: a mock of a pipe proves nothing about a pipe. The one thing not
 * driven here is the real `claude` binary, which is proved separately and by hand — the probe under
 * the record measured `flags: 0100002` on a real child's fd 0 and drove a `kill -9` of its parent
 * mid-turn (record "Where it stands" item 6).
 *
 * WHY THERE IS NO FAIL-FIRST RUN. The defect is an absence: before this build there was no detach
 * and no adopt to call, so these cases could not have been red against the old code — they could
 * not have compiled. They are MUTATION-proven instead, and the mutations are recorded in VERIFY.md.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runner, type JobEvent, type StartRequest } from "../../server/input.ts";
import { metaPath, sessionDir, spoolRoot } from "../../server/spool.ts";

const ROOT = join(import.meta.dir, "..", "..");
const STUB = join(ROOT, "tests", "stub-claude.ts");
/** Not a real listening port — only the key the spool tree is partitioned by. */
const PORT = 4999;

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

interface World {
  cwd: string;
  events: JobEvent[];
  boot: () => Runner;
  cleanup: () => Promise<void>;
}

/**
 * A scratch world with a spool tree of its own. `boot()` stands a NEW `Runner` up over the same
 * tree, which is exactly what a restart is: a different process, the same directory, the same
 * children still running in it.
 */
async function world(): Promise<World> {
  const projectsRoot = await mkdtemp(join(tmpdir(), "loom-adopt-projects-"));
  const cwd = await mkdtemp(join(tmpdir(), "loom-adopt-cwd-"));
  const spool = await mkdtemp(join(tmpdir(), "loom-adopt-spool-"));
  process.env["LOOM_PROJECTS_ROOT"] = projectsRoot;
  process.env["LOOM_SPOOL"] = spool;
  const events: JobEvent[] = [];
  const runners: Runner[] = [];
  return {
    cwd,
    events,
    boot: () => {
      const runner = new Runner(STUB, "http://127.0.0.1:1/no-permit-in-this-test", PORT, (e: JobEvent) =>
        events.push(e),
      );
      runners.push(runner);
      return runner;
    },
    cleanup: async () => {
      for (const runner of runners) runner.shutdown();
      await Bun.sleep(200);
      await rm(projectsRoot, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      await rm(spool, { recursive: true, force: true });
    },
  };
}

function childPid(sessionId: string): number {
  const meta = JSON.parse(readFileSync(metaPath(sessionDir(PORT, sessionId)), "utf8")) as { pid: number };
  return meta.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

describe("a restart hands live sessions over instead of killing them", () => {
  test("the child outlives the loom that spawned it, and the NEXT loom talks to the same process", async () => {
    const w = await world();
    try {
      const id = "adopt-handover";
      const first = w.boot();
      expect(first.send({ ...base(id, w.cwd), text: "slow one" }).ok).toBe(true);
      await Bun.sleep(300);
      const pid = childPid(id);
      expect(alive(pid)).toBe(true);

      // The restart. This is what the SIGTERM handler does, and the whole claim of the build is
      // that the process on the other side of it does not care.
      first.detach();
      await Bun.sleep(500);
      expect(alive(pid)).toBe(true); // ← the old shape died here, on EOF

      const second = w.boot();
      second.adopt();
      // Adopted, not respawned: the same operating-system process, still holding the prompt cache
      // that is the entire reason a child is long-lived at all (SPEC 105).
      expect(childPid(id)).toBe(pid);
      // And still holding the turn that was in flight when loom went away.
      expect(second.queued(id)).toBe(1);

      // The turn finishes and is REPORTED, through a loom that never spawned it.
      expect(await until(() => w.events.some((e) => e.sessionId === id && e.state === "done"), 15000)).toBe(true);
      expect(second.queued(id)).toBe(0);

      // The FIFO is writable from the new process too — a send lands and is answered.
      expect(second.send({ ...base(id, w.cwd), text: "after the restart" }).ok).toBe(true);
      expect(
        await until(() => w.events.filter((e) => e.sessionId === id && e.state === "done").length >= 2, 15000),
      ).toBe(true);
      expect(childPid(id)).toBe(pid); // still no respawn
    } finally {
      await w.cleanup();
    }
  }, 40000);

  test("a turn that lands WHILE loom is down is reported when it comes back", async () => {
    const w = await world();
    try {
      const id = "adopt-turn-in-the-gap";
      const first = w.boot();
      expect(first.send({ ...base(id, w.cwd), text: "slow one" }).ok).toBe(true);
      await Bun.sleep(300);
      first.detach();
      // Long enough for the stub's six-second turn to finish with nobody reading its stdout. The
      // frames go to a FILE, so there is nothing to lose and nothing to EPIPE on.
      await Bun.sleep(8000);
      w.events.length = 0;

      const second = w.boot();
      second.adopt();
      expect(await until(() => w.events.some((e) => e.sessionId === id && e.state === "done"), 10000)).toBe(true);
      expect(second.queued(id)).toBe(0);
    } finally {
      await w.cleanup();
    }
  }, 40000);

  test("a child that really died is swept, not adopted", async () => {
    const w = await world();
    try {
      const id = "adopt-dead-child";
      const first = w.boot();
      expect(first.send({ ...base(id, w.cwd), text: "hello" }).ok).toBe(true);
      await Bun.sleep(300);
      const pid = childPid(id);
      first.detach();
      process.kill(pid, "SIGKILL");
      expect(await until(() => !alive(pid), 5000)).toBe(true);

      const second = w.boot();
      second.adopt();
      expect(second.queued(id)).toBe(0);
      expect(second.running(id)).toBe(false);
      // The directory is gone, so nothing will try to adopt this pid again after it is reused.
      expect(await Bun.file(metaPath(sessionDir(PORT, id))).exists()).toBe(false);
    } finally {
      await w.cleanup();
    }
  }, 30000);

  test("a child left behind past its cache's life is ended rather than adopted", async () => {
    const w = await world();
    try {
      const id = "adopt-cold-child";
      const first = w.boot();
      expect(first.send({ ...base(id, w.cwd), text: "hello" }).ok).toBe(true);
      await Bun.sleep(300);
      const pid = childPid(id);
      first.detach();

      // Age the meta past the hour a child is kept FOR. Keeping it any longer buys nothing — the
      // prompt cache it was held for is gone — and this is also what stops a loom that never comes
      // back from leaking children forever.
      const path = metaPath(sessionDir(PORT, id));
      const meta = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      meta["cacheAt"] = Date.now() - 3 * 60 * 60 * 1000;
      await Bun.write(path, JSON.stringify(meta));

      const second = w.boot();
      second.adopt();
      expect(second.queued(id)).toBe(0);
      expect(await until(() => !alive(pid), 10000)).toBe(true);
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      await w.cleanup();
    }
  }, 30000);

  test("the spool tree is partitioned by port, so a worktree loom cannot take the real one's children", async () => {
    // Not a scenario that can be reached through the UI, and the one that would be silent if it
    // broke: a dev server on 4346 adopting the 4173 children would move User's live sessions into
    // a loom he is not looking at.
    expect(spoolRoot(4173)).not.toBe(spoolRoot(4346));
    expect(spoolRoot(4173).endsWith("/4173")).toBe(true);
  });
});
