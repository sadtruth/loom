/**
 * The git window (SPEC §Recap, requirement 172).
 *
 * The recap is allowed to say what LANDED only about commits it can see. That window is derived —
 * from the session's own first and last spoken timestamps, and from the repository found by walking
 * up from the session's cwd. It is never chosen by hand: on the 2026-08-12 spike a hand-picked
 * window named the wrong days, and the recap duly reported committed work as unconfirmed.
 *
 * When the cwd is gone — a build worktree that `session.sh land` removed — there is no window, and
 * the caller must move every "Landed" line to "Claimed but unconfirmed" rather than guess.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Window {
  repo: string;
  since: string;
  until: string;
  /** `git log` output, or "" when the range is empty. */
  log: string;
}

export type Run = (repo: string, args: readonly string[]) => { ok: boolean; out: string };

const defaultRun: Run = (repo, args) => {
  const proc = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: new TextDecoder().decode(proc.stdout) };
};

/** The repository a directory belongs to, or null. Walks up; handles worktrees, where `.git` is a file. */
export function findRepo(cwd: string | null): string | null {
  if (cwd === null || cwd.length === 0) return null;
  // The directory must still BE there. Walking up from a path that no longer exists finds the first
  // ancestor with a `.git` — so a landed worktree deep inside a repo produced a window over that
  // repo's unrelated commits, and the recap would have reported them as this session's landed work.
  // Requirement 172 says no cwd means no window, and this is the line that makes that true.
  if (!existsSync(cwd)) return null;
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * A window around the session, padded at the end: work is committed after the last thing said, not
 * before it. The pad is why the spike's own commit would have been found — it landed four minutes
 * after the final message.
 */
export function windowFor(
  cwd: string | null,
  firstTs: string,
  lastTs: string,
  run: Run = defaultRun,
): Window | null {
  const repo = findRepo(cwd);
  if (repo === null) return null;
  if (firstTs.length === 0 || lastTs.length === 0) return null;
  // A timestamp that is not a date is the same situation as no timestamp: no window. It used to
  // throw `RangeError: Invalid Date`, which the caller's catch turned into a failed recap — the
  // block said the recap had failed when the documented answer is a recap with nothing under
  // "Landed".
  const end = new Date(lastTs).getTime();
  if (!Number.isFinite(end)) return null;
  const until = new Date(end + 30 * 60 * 1000).toISOString();
  const res = run(repo, [
    "log",
    `--since=${firstTs}`,
    `--until=${until}`,
    "--pretty=format:%h %ad %s",
    "--date=format:%Y-%m-%d %H:%M",
    "--name-only",
  ]);
  if (!res.ok) return null;
  return { repo, since: firstTs, until, log: res.out.trim() };
}

/** What the agent is told when there is no window. Stated once, so both callers say the same thing. */
export const NO_WINDOW =
  "No git window could be built for this session — its working directory no longer exists, or it " +
  "was not in a repository. Put EVERY claim about landed work under 'Claimed but unconfirmed'. " +
  "Do not guess which commits are related.";
