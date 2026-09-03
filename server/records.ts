/**
 * Project-record discovery: the left-column tree's data source (SPEC §Records).
 *
 * A record is any `.md` file whose frontmatter says `type: project` — the shape the `project`
 * skill writes (`project.md` in a directory, or next to its product like `toys/panda-walk.md`).
 * A core may ALSO declare a folder whose subdirectories are its records (`Core.records`), which is
 * how the work vault's epics get into the tree without adopting a second format.
 * loom derives the tree from `parent:`; nothing here writes, and a malformed record degrades to
 * "not a record" rather than an error, same contract as the transcript parser.
 *
 * Frontmatter is hand-parsed for exactly the fields the skill defines (type, status, created,
 * parent, references). A YAML library would accept more shapes than the skill promises, and the
 * skill's shape is the contract.
 */

import { CORES, coreFor, under, type Core, type CoreId, type FolderRecords } from "./cores.ts";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface RecordRef {
  path: string;
  why: string | null;
}

export interface RecordInfo {
  /** Absolute path of the record file — the stable id. */
  path: string;
  title: string;
  status: string;
  created: string | null;
  /** Absolute path of the parent record, resolved against this record's directory. */
  parent: string | null;
  references: RecordRef[];
  mtime: number;
  /**
   * Which core this record's sessions run in. Tagged by the SERVER so the rule has one home:
   * `coreFor` already decides it when a session is spawned, and a second copy in the client is a
   * rule that can disagree with itself. The panel only filters on this field.
   */
  core: CoreId;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".obsidian",
  ".trash",
  ".smart-env",
  "Archive",
  "Templates",
  "attachments",
  "test-results",
]);

/** Head bytes that must contain the whole frontmatter — a record's is a few hundred bytes. */
const HEAD_BYTES = 8 * 1024;

/**
 * Parse one record head. Null when this file is not a project record.
 *
 * `requireProjectType` is false only for a core that declares its own record folder: there the
 * FOLDER is the statement that this is a record, exactly as the work vault's own dashboard treats
 * it, and demanding a `type:` on top of that would drop half the epics for saying `task`.
 */
export function parseRecord(
  text: string,
  path: string,
  mtime: number,
  requireProjectType = true,
): RecordInfo | null {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  const front = text.slice(4, end);
  const body = text.slice(end + 4);

  const fields = new Map<string, string>();
  const references: RecordRef[] = [];
  let inRefs = false;
  let pending: { path: string; why: string | null } | null = null;

  for (const line of front.split("\n")) {
    const refItem = /^\s+-\s+path:\s*(.+)$/.exec(line);
    const refWhy = /^\s+why:\s*(.+)$/.exec(line);
    const top = /^(\w+):\s*(.*)$/.exec(line);
    if (inRefs && refItem?.[1] !== undefined) {
      if (pending !== null) references.push(pending);
      pending = { path: refItem[1].trim(), why: null };
      continue;
    }
    if (inRefs && refWhy?.[1] !== undefined && pending !== null) {
      pending.why = refWhy[1].trim();
      continue;
    }
    if (top !== null) {
      if (pending !== null) {
        references.push(pending);
        pending = null;
      }
      inRefs = top[1] === "references";
      if (!inRefs && top[1] !== undefined) fields.set(top[1], (top[2] ?? "").trim());
    }
  }
  if (pending !== null) references.push(pending);

  if (requireProjectType && fields.get("type") !== "project") return null;

  const dir = dirname(path);
  const parentRaw = fields.get("parent") ?? "";
  const heading = /^#\s+(.+)$/m.exec(body);
  const stem = path.split("/").slice(-1)[0]?.replace(/\.md$/, "") ?? path;
  // A file named for its slot rather than its subject is titled by the directory it speaks for.
  const namedForSlot = stem === "project" || stem === "README";

  return {
    path,
    title: heading?.[1]?.trim() ?? (namedForSlot ? (dir.split("/").slice(-1)[0] ?? stem) : stem),
    status: fields.get("status") ?? "unknown",
    created: fields.get("created") ?? null,
    parent: parentRaw.length > 0 ? resolve(isAbsolute(parentRaw) ? parentRaw : join(dir, parentRaw)) : null,
    references: references.map((r) => ({
      path: resolve(isAbsolute(r.path) ? r.path : join(dir, r.path)),
      why: r.why,
    })),
    mtime,
    core: coreFor(path).id,
  };
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 8) return; // a runaway symlink loop is not worth chasing
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), out, depth + 1);
    } else if (entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * The records of a core that keeps them as one directory per unit of work.
 *
 * Immediate subdirectories only, and only those holding the named file WITH frontmatter — an
 * `epics/<epic>/prototype/` folder is part of an epic, not a second epic, and a directory whose
 * README has no frontmatter is not yet a unit of work. Both clauses are the work dashboard's own
 * (`collect()` in `scripts/dashboard_refresh.py`), because two rules for what an epic is would
 * disagree the first time one of them was edited.
 */
async function folderRecords(spec: FolderRecords): Promise<RecordInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(resolve(spec.dir), { withFileTypes: true });
  } catch {
    return []; // a core whose folder is not on this machine simply has no records here
  }

  const records: RecordInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (spec.skip.includes(entry.name) || SKIP_DIRS.has(entry.name)) continue;
    const file = join(resolve(spec.dir), entry.name, spec.file);
    try {
      const handle = Bun.file(file);
      const head = await handle.slice(0, HEAD_BYTES).text();
      if (!head.startsWith("---\n")) continue;
      const stat = await handle.stat();
      const record = parseRecord(head, file, stat.mtimeMs, false);
      if (record !== null) records.push(record);
    } catch {
      continue; // an unreadable file is not a record
    }
  }
  return records;
}

/**
 * The scan is CACHED — SPEC 231. User, 2026-08-23, clicking between two projects in the rail:
 * *"each click goes longer than a second to load the session"*. Measured against the running
 * server, the whole wait was one request: `/api/records/sessions` answered in 783ms and the socket
 * could not open until it did, while everything after the socket cost 70ms. Behind it is the walk
 * below — 4,487 `.md` files opened and read to find 185 records, 227-312ms benchmarked alone, fired
 * by four routes at once on Bun's one thread on every click.
 *
 * Three mechanisms, each closing a different hole, and none of them redundant:
 *
 *  - `inFlight` COALESCES. Concurrent callers await the scan already running instead of starting a
 *    second walk. This is not staleness at all: it answers questions asked microseconds apart with
 *    the same true answer, and on its own it is what removes the measured second.
 *  - `TTL_MS` decides when a held answer needs REFRESHING — never when a reader must wait. Past it
 *    the answer still goes out immediately and the walk runs behind it, so the reader pays nothing
 *    and the memory is one walk behind at worst. A plain make-them-wait TTL was tried first and
 *    measured on 2026-08-23: the click still paid 457ms, because his clicks are seconds apart and
 *    every one of them landed past a two-second TTL. 2,000ms is chosen under the client's own
 *    `RECORDS_POLL_MS = 4000` (`client/app.ts`), so a record another Claude session writes on disk
 *    is in the rail within about one poll without anyone having waited for it.
 *  - `invalidateRecords()` is called by every route that WRITES a record, and it is not optional:
 *    `submitCreate`, `submitRename` and `writeRecordStatus` in the client all re-fetch
 *    `/api/records` the moment their own POST resolves and expect to see their own write. A
 *    TTL-only cache would serve those stale for up to two seconds, which is the "the rail shows a
 *    stale or missing project" failure that is worse than being slow.
 *
 * And the race the third one introduces: a scan already reading files when a write lands started
 * BEFORE that write, so seating its result after the invalidation would silently restore the
 * staleness the invalidation just removed. Each scan therefore captures `generation` when it starts
 * and only keeps its answer if nothing invalidated while it ran. The answer is still returned to
 * whoever awaited it — it is simply not remembered, so the next reader walks for real.
 *
 * NOT `fs.watch` on the roots: they are Resilio-synced, so a sync client rewriting files produces
 * event storms that have nothing to do with loom's own writes, and recursively watching 4,475
 * directories is inotify-hungry and flaky under bulk churn — a second staleness mechanism to reason
 * about, for no correctness the TTL does not already give. NOT a background refresher either:
 * coalescing already keeps the hot path warm, and a walk every idle two seconds buys freshness
 * nobody is between clicks.
 */
const TTL_MS = Number(Bun.env["LOOM_RECORDS_TTL_MS"] ?? 2_000);

interface CacheEntry {
  at: number;
  records: RecordInfo[];
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RecordInfo[]>>();
let generation = 0;

/**
 * What makes two scans the same question. In production this collapses to ONE key — `RECORD_ROOTS`
 * is computed once at boot and every call site passes it unchanged, with the default cores. The map
 * exists for the tests, which point each case at its own `mkdtempSync` tree: keyed by the roots,
 * two cases cannot see each other's answer, so no test-only reset hook is needed.
 */
function cacheKey(roots: readonly string[], cores: readonly Core[]): string {
  const declared = cores.map((core) => `${core.id}:${core.records?.dir ?? ""}`).join(",");
  return `${roots.join("\u0000")}\u0001${declared}`;
}

/**
 * Forget everything — called after loom writes a record file, so the client's own read-after-write
 * sees what it just wrote. Bumps the generation so a walk already in progress cannot seat its
 * older answer on top of this.
 */
export function invalidateRecords(): void {
  generation += 1;
  cache.clear();
  inFlight.clear();
}

/** Scan the given roots for project records. Roots that do not exist contribute nothing. */
export async function scanRecords(
  roots: readonly string[],
  cores: readonly Core[] = CORES,
): Promise<RecordInfo[]> {
  const key = cacheKey(roots, cores);
  const held = cache.get(key);
  if (held !== undefined) {
    // SERVE, THEN REFRESH. A TTL that makes the reader WAIT for the new walk fixes nothing on the
    // path that matters: measured on the branch, 2026-08-23, with a plain 2,000ms TTL the click
    // still paid 457ms, because User's clicks are seconds apart and every one of them landed
    // past the TTL. The answer is already in memory and it is at most one refresh out of date, so
    // it goes out now and the walk happens behind it. What bounds the staleness is not the reader
    // waiting — it is the refresh started here plus the client's own 4-second `/api/records` poll,
    // and, for anything loom itself writes, `invalidateRecords()`, which drops the entry outright
    // so the next read is a real walk.
    if (Date.now() - held.at >= TTL_MS) void refresh(key, roots, cores);
    return held.records;
  }
  const running = inFlight.get(key);
  if (running !== undefined) return running;

  return refresh(key, roots, cores);
}

/**
 * One walk, coalesced and seated. Every caller of this either has nothing to serve yet and awaits
 * it, or already served a held answer and only wants the memory brought up to date.
 */
function refresh(key: string, roots: readonly string[], cores: readonly Core[]): Promise<RecordInfo[]> {
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const gen = generation;
  const scan = scanRecordsUncached(roots, cores)
    .then((records) => {
      // Only if nothing invalidated while this walk was reading files. If something did, the caller
      // still gets this answer — it is the best that exists — but it is never remembered.
      if (gen === generation) cache.set(key, { at: Date.now(), records });
      return records;
    })
    .finally(() => {
      if (inFlight.get(key) === scan) inFlight.delete(key);
    });
  inFlight.set(key, scan);
  return scan;
}

/**
 * The walk itself, unchanged and uncached — also the way past the cache when a lookup MISSES and
 * the answer "no such record" would otherwise be wrong (SPEC 231).
 */
export async function scanRecordsUncached(
  roots: readonly string[],
  cores: readonly Core[] = CORES,
): Promise<RecordInfo[]> {
  const files: string[] = [];
  for (const root of roots) await walk(resolve(root), files, 0);

  const records: RecordInfo[] = [];
  for (const file of files) {
    try {
      const handle = Bun.file(file);
      const head = await handle.slice(0, HEAD_BYTES).text();
      if (!head.startsWith("---\n") || !head.includes("type: project")) continue;
      const stat = await handle.stat();
      const record = parseRecord(head, file, stat.mtimeMs);
      if (record !== null) records.push(record);
    } catch {
      continue; // an unreadable file is not a record
    }
  }

  // A core's own record folder is scanned only when the caller's roots already cover it. The roots
  // are what loom is allowed to look at; a core must widen nothing, or a test pointed at a tmp dir
  // would quietly return the real work vault's epics.
  const seen = new Set(records.map((r) => r.path));
  for (const core of cores) {
    const spec = core.records;
    if (spec === undefined) continue;
    if (!roots.some((root) => under(spec.dir, root))) continue;
    // Tagged by the core that DECLARED the folder, not by `coreFor` on the path: the two agree in
    // the vault, and where they could not, the declaration is the one that meant something.
    for (const record of await folderRecords(spec)) {
      if (!seen.has(record.path)) records.push({ ...record, core: core.id });
    }
  }

  return records.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Derived staleness over the tree (SPEC 88).
 *
 * For each record, its own freshness is the max of the record file's own mtime and its sessions'
 * mtimes. A parent's staleness is the min over itself and its children's, so one active leaf keeps
 * the whole chain current. This is a pure function so it can be property-tested.
 *
 * "staleness is the min" = max of mtimes (freshest timestamp).
 */
export function recordsWithStaleness<T extends { path: string; parent: string | null; mtime: number }>(
  records: readonly T[],
): (T & { derivedMtime: number })[] {
  const byPath = new Map<string, T & { derivedMtime: number }>();
  const childrenMap = new Map<string, string[]>();

  for (const r of records) {
    byPath.set(r.path, { ...r, derivedMtime: r.mtime });
  }

  for (const r of records) {
    if (r.parent !== null && byPath.has(r.parent)) {
      let kids = childrenMap.get(r.parent);
      if (kids === undefined) {
        kids = [];
        childrenMap.set(r.parent, kids);
      }
      kids.push(r.path);
    }
  }

  // Relaxation until fixed point: handles arbitrary depths and cycles safely without recursion limits.
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records) {
      const node = byPath.get(r.path)!;
      let maxMtime = node.derivedMtime;
      for (const childPath of childrenMap.get(r.path) ?? []) {
        const childNode = byPath.get(childPath)!;
        if (childNode.derivedMtime > maxMtime) maxMtime = childNode.derivedMtime;
      }
      if (maxMtime > node.derivedMtime) {
        node.derivedMtime = maxMtime;
        changed = true;
      }
    }
  }
  return records.map((r) => byPath.get(r.path)!);
}

/**
 * A record's `## Frame`, capped — what a session needs to not misunderstand its own job.
 *
 * User, 2026-08-16: *"but wouldnt every session instantly try to read the project file it was
 * given a link to, wasting a whole turn?"*. He is right, and a `Read` is the expensive direction:
 * an extra round trip re-sending the whole conversation as a write, against text in the system
 * prompt that rides the cached prefix at a fraction of that after the first turn. So the frame is
 * INLINED and the path is named only for anything deeper.
 *
 * Capped hard: a long record must not tax every session started under it.
 *
 * A core's own records say the same thing under their own heading: a work epic opens with
 * `## Цель и контекст`, which is its frame in every sense that matters here. Whichever comes
 * first in the file wins, so a record with both is read once.
 */
const FRAME_HEADINGS = ["\n## Frame", "\n## Цель и контекст"];

export async function frameOf(recordPath: string, limit = 1200): Promise<string | null> {
  let text: string;
  try {
    text = await Bun.file(recordPath).slice(0, 16 * 1024).text();
  } catch {
    return null;
  }
  const start = FRAME_HEADINGS.map((h) => text.indexOf(h))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (start === undefined) return null;
  const after = text.indexOf("\n## ", start + 1);
  const frame = (after < 0 ? text.slice(start) : text.slice(start, after)).trim();
  if (frame.length === 0) return null;
  return frame.length <= limit ? frame : `${frame.slice(0, limit).trimEnd()}\n… (truncated; the record has the rest)`;
}
