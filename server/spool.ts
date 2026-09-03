/**
 * Where a session's `claude` child lives ON DISK, so that stopping loom is a detach and not a
 * killing (SPEC 255).
 *
 * WHY THIS FILE EXISTS. Until 2026-08-29 a child was tied to loom by three pipes. `KillMode=process`
 * spared it the restart's SIGTERM, but the kernel still closed loom's ends: the CLI read EOF on
 * stdin, finished what it had and exited, and anything it wrote after that would have been an
 * EPIPE. So every deploy ended every live session — 2026-08-05 twice, and again on 2026-08-15 in
 * the middle of User's work.
 *
 * The shape here removes both halves, and it is driven rather than reasoned (record item 6,
 * `restart-without-killing-sessions/project.md`):
 *
 *   stdin  — a FIFO opened `O_RDWR` and handed to the child as fd 0. The child is therefore its
 *            own writer, so "loom went away" is not end-of-file. `/proc/<pid>/fdinfo/0` reads
 *            `flags: 0100002` on a real child, which is the proof rather than the intention.
 *   stdout — a plain file the child appends to and loom TAILS BY BYTE OFFSET, exactly as the read
 *            path already tails the transcript. A write to a file cannot EPIPE, so turn status now
 *            survives a restart the way the reply text already did.
 *   meta   — one small JSON file per session, rewritten at turn boundaries, holding the pid, the
 *            spawn fingerprint, the queue and how far loom has read. It is what the NEXT loom needs
 *            to pick the child up instead of leaving it orphaned.
 *
 * NOT in the vault and not in `state/`: the vault is Resilio-synced and a FIFO is not a thing to
 * sync, and `state/` is inside the repo. The default is `~/.cache/loom/children/<port>/`, keyed by
 * PORT so a worktree loom on 4346 can never adopt the children of the real one on 4173.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One accepted-but-unanswered message, as the queue holds it. Mirrors `QueuedMessage` in input.ts. */
export interface SpooledMessage {
  text: string;
  at: number;
}

/**
 * Everything a loom that did not spawn this child needs in order to take it over. Written at turn
 * boundaries only — a send and a `result` — because those are the only moments the durable half
 * changes, and a write per stdout frame would be a write per token.
 */
export interface SpoolMeta {
  sessionId: string;
  pid: number;
  port: number;
  /** The spawn fingerprint (model|effort|mode|cwd|browser). A send that disagrees must respawn. */
  spec: string;
  bornAt: number;
  cacheAt: number;
  lastUsed: number;
  lastCache: string;
  pending: SpooledMessage[];
  /**
   * How many bytes of `out.jsonl` this loom had consumed when the meta was written. An adopting
   * loom resumes there. Frames written after it are re-read, which is exactly right: the only frame
   * that moves durable state is `result`, and re-reading one that arrived while loom was down is
   * how a turn that finished in the gap gets reported at all.
   */
  readOffset: number;
}

export function spoolRoot(port: number): string {
  const base = Bun.env["LOOM_SPOOL"] ?? join(homedir(), ".cache", "loom", "children");
  return join(base, String(port));
}

export function sessionDir(port: number, sessionId: string): string {
  return join(spoolRoot(port), sessionId);
}

export const fifoPath = (dir: string): string => join(dir, "in");
export const outPath = (dir: string): string => join(dir, "out.jsonl");
export const errPath = (dir: string): string => join(dir, "err.log");
export const metaPath = (dir: string): string => join(dir, "meta.json");

/**
 * A fresh, empty spool for a child about to be spawned. Any previous one for the same session is
 * removed first: a stale FIFO would still hold the last child's unread bytes, which the new child
 * would read as its first turn.
 */
export function createSpool(port: number, sessionId: string): string {
  const dir = sessionDir(port, sessionId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // node has no mkfifo, and a FIFO is the whole mechanism, so this is not an optional dependency.
  execFileSync("mkfifo", [fifoPath(dir)]);
  writeFileSync(outPath(dir), "");
  writeFileSync(errPath(dir), "");
  return dir;
}

/** Atomic, because an adopting loom reads this file at a moment nobody chose. */
export function writeMeta(dir: string, meta: SpoolMeta): void {
  const tmp = `${metaPath(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta));
  renameSync(tmp, metaPath(dir));
}

export function readMeta(dir: string): SpoolMeta | null {
  try {
    const meta = JSON.parse(readFileSync(metaPath(dir), "utf8")) as Partial<SpoolMeta>;
    if (typeof meta.sessionId !== "string" || typeof meta.pid !== "number") return null;
    return {
      sessionId: meta.sessionId,
      pid: meta.pid,
      port: typeof meta.port === "number" ? meta.port : 0,
      spec: typeof meta.spec === "string" ? meta.spec : "",
      bornAt: typeof meta.bornAt === "number" ? meta.bornAt : 0,
      cacheAt: typeof meta.cacheAt === "number" ? meta.cacheAt : 0,
      lastUsed: typeof meta.lastUsed === "number" ? meta.lastUsed : 0,
      lastCache: typeof meta.lastCache === "string" ? meta.lastCache : "no turn yet",
      pending: Array.isArray(meta.pending) ? (meta.pending as SpooledMessage[]) : [],
      readOffset: typeof meta.readOffset === "number" ? meta.readOffset : 0,
    };
  } catch {
    // A half-written or absent meta means there is nothing to adopt, never a crash on boot.
    return null;
  }
}

export function dropSpool(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Is this pid still the child this meta describes? The pid alone is not enough — pids are reused,
 * and adopting a stranger would mean writing a user's message into an unrelated process's stdin.
 * The session id is in the child's own argv (`--session-id` / `--resume`), so the command line is
 * the check that actually identifies it.
 */
export function isOurChild(pid: number, sessionId: string): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 tests existence and permission, and delivers nothing.
  } catch {
    return false;
  }
  const cmdline = readCmdline(pid);
  if (cmdline === null) return false; // Cannot identify it — do not touch it.
  return cmdline.includes(sessionId);
}

function readCmdline(pid: number): string | null {
  try {
    // Linux. NUL-separated, so the raw bytes are searched rather than split.
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    // The MacBook has no /proc. `ps` is the portable answer and is only reached there.
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    } catch {
      return null;
    }
  }
}

/** Open the FIFO for writing WITHOUT ever blocking, and without stealing the child's bytes. */
export function openWriter(dir: string): number {
  // O_RDWR rather than O_WRONLY: opening a FIFO write-only BLOCKS until a reader arrives, and if the
  // child has just died that block is forever. O_RDWR returns at once. Loom never reads this fd, so
  // every byte still goes to the child; liveness is decided by the pid check above, not by a hang.
  return openSync(fifoPath(dir), 2 /* O_RDWR */);
}

export function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed on the way out; nothing here is worth failing a shutdown for.
  }
}

/** Every session directory currently under this port's spool, whether live or abandoned. */
export function spooledSessions(port: number): Array<{ dir: string; meta: SpoolMeta }> {
  const root = spoolRoot(port);
  if (!existsSync(root)) return [];
  const found: Array<{ dir: string; meta: SpoolMeta }> = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const meta = readMeta(dir);
    if (meta !== null) found.push({ dir, meta });
  }
  return found;
}
