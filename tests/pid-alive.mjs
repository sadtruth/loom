/**
 * Is a pid a LIVE holder of a lock — the question `tests/playwright.config.mjs`'s pin lock asks,
 * pulled out into its own pure, testable module (item 59, verify-speed/pid-check.ts).
 *
 * `process.kill(pid, 0)` only asks "does this pid slot exist" — signal 0 is never delivered, so it
 * throws only when the kernel has nothing left at that pid. A ZOMBIE (exited, not yet reaped by its
 * parent) still occupies its slot, so `kill(pid, 0)` answers "alive" for it exactly as it does for a
 * running process — proved against a real zombie in verify-speed/pid-check.ts, and the mechanism
 * behind item 59: "a run refused against a runner that had been gone for six minutes."
 *
 * `/proc/<pid>/stat`'s state field tells the two apart. Plain `.mjs`, not `.ts`: `playwright.config.mjs`
 * is loaded directly by Node/Playwright with no build step, so this module has to be importable the
 * same way.
 */
import { readFileSync } from "node:fs";

/**
 * The state character from `/proc/<pid>/stat`, or `null` if the pid names nothing (already reaped,
 * never existed, or this is not Linux).
 *
 * Format: `pid (comm) state ppid ...`. `comm` is in parens and may itself contain spaces or parens
 * (a zombie's `comm` is whatever the exited program was called), so the state token is read after
 * the LAST `)`, never split on the first.
 */
export function pidState(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = raw.slice(raw.lastIndexOf(")") + 1).trim();
    return afterComm.split(/\s+/)[0] ?? null;
  } catch {
    return null; // no /proc entry — the process is genuinely gone
  }
}

/** Anything but a zombie or an absent pid: what the pin lock means by "someone still owns this". */
export function isLiveHolder(pid) {
  const state = pidState(pid);
  return state !== null && state !== "Z";
}
