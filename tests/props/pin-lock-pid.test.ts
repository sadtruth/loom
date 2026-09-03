/**
 * The pin lock's holder check (item 59, `tests/playwright.config.mjs:48`).
 *
 * `process.kill(pid, 0)` only asks "does this pid slot exist" — a zombie (a process that has
 * exited but whose parent has not called `wait()`) still occupies its slot, so it answers yes.
 * `verify-speed/pid-check.ts` proved this against a REAL zombie, not an assertion: a run refused
 * against a runner that had been gone for six minutes (parent record item 59).
 *
 * The fix reads the state field of `/proc/<pid>/stat` and treats `Z` — and a missing/unreadable
 * entry, i.e. the process already reaped — as "no live holder". `pid-alive.mjs` is the extracted,
 * pure, testable version of that check; `playwright.config.mjs` imports it rather than repeating
 * the `process.kill(pid, 0)` logic it replaces.
 *
 * Both zombie and live cases are BUILT, not asserted: a bash parent backgrounds a short-lived
 * child and then `exec`s into a long sleep without ever calling `wait()` on it, so the same OS pid
 * keeps running while its child sits defunct. Bun/Node's own child-process handling cannot
 * interfere — libuv only auto-reaps its OWN direct child (the bash parent), never a grandchild bash
 * itself forgot to reap.
 */

import { describe, expect, test } from "bun:test";
import { isLiveHolder, pidState } from "../pid-alive.mjs";

async function spawnZombie(): Promise<{ parent: ReturnType<typeof Bun.spawn>; childPid: number }> {
  const parent = Bun.spawn({
    cmd: ["bash", "-c", "sleep 0.3 & echo $! & exec sleep 30"],
    stdout: "pipe",
    stderr: "ignore",
  });
  // NOT reading stdout to EOF: the exec'd `sleep 30` inherits the pipe and never closes it, so
  // reading to EOF would block for the full 30s. Read only the first line (the child's pid).
  const reader = parent.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const childPid = Number(buffered.trim().split("\n")[0]);
  if (!Number.isInteger(childPid) || childPid <= 0) {
    parent.kill("SIGKILL");
    throw new Error(`could not read the backgrounded child's pid: ${JSON.stringify(buffered)}`);
  }
  return { parent, childPid };
}

describe("pid-alive: the pin lock's /proc state check (item 59)", () => {
  test("a real zombie reads state Z and is not a live holder", async () => {
    const { parent, childPid } = await spawnZombie();
    try {
      // The backgrounded child (sleep 0.3) has exited by now, but its parent bash — now `exec`ed
      // into `sleep 30` — never called wait() on it, so it sits defunct.
      await Bun.sleep(700);
      const state = pidState(childPid);
      expect(state).toBe("Z");
      expect(isLiveHolder(childPid)).toBe(false);
    } finally {
      parent.kill("SIGKILL");
      await parent.exited;
    }
  }, 10_000);

  test("a real running process reads a live state and IS a live holder", async () => {
    const proc = Bun.spawn({ cmd: ["sleep", "5"], stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(100);
      const state = pidState(proc.pid);
      expect(state).not.toBeNull();
      expect(state).not.toBe("Z");
      expect(isLiveHolder(proc.pid)).toBe(true);
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  }, 10_000);

  test("an absent pid is not a live holder", () => {
    expect(pidState(999_999_999)).toBeNull();
    expect(isLiveHolder(999_999_999)).toBe(false);
  });
});
