/**
 * Which project a session belongs to.
 *
 * Until 2026-08-16 the answer was DERIVED: a session's cwd was its project, and the escaped cwd was
 * the key (`projects.ts`). That made the cwd load-bearing for identity, which is why every loom
 * session ran inside its own project directory — and why such a session saw none of the vault's
 * skills and none of its output style, both of which the CLI reads from the cwd and does not walk
 * up to find. User, 2026-08-16: *"i dont really see the benefit of having loom change cwd for each
 * project. The only thing is matching session to project but that can be achieved by storing links
 * in projects to its sessions"*.
 *
 * So the link is a thing loom STORES, and derivation survives as the FALLBACK — a session loom did
 * not spawn (a plain `claude` in a terminal) still belongs to the project its cwd names. Removing
 * the fallback would trade one silent failure for another: those sessions would belong nowhere.
 */

import { appendFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

export type Resolution =
  | { kind: "linked"; record: string }
  | { kind: "derived"; key: string };

/**
 * The resolution rule, kept PURE so its shape is testable without a filesystem — the same reason
 * `files.ts` keeps its root ladder pure. `derivedKey` is the escaped cwd the caller already has;
 * this module never computes it, so it cannot drift from the one `projects.ts` enumerates.
 *
 * A stored link WINS. An empty record is not a link: a half-written entry falls through to the
 * fallback rather than resolving a session to nothing.
 */
export function resolveProject(
  session: string,
  derivedKey: string,
  links: ReadonlyMap<string, string>,
): Resolution {
  const record = links.get(session);
  if (record !== undefined && record.trim().length > 0) return { kind: "linked", record };
  return { kind: "derived", key: derivedKey };
}

/** Sessions linked to a record, in the order they were stored. */
export function sessionsOf(record: string, links: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [session, path] of links) if (path === record) out.push(session);
  return out;
}

/**
 * A record's sessions from BOTH stores: its own directory, plus the ones the link claims out of the
 * shared core store (SPEC 217).
 *
 * There were three hand-written copies of this merge — `/api/train`, `/api/records/sessions`, and
 * `/api/activity` once it was fixed. Three copies of one rule is the drift SPEC 152 warns about,
 * and the copies had already diverged: one of them did not re-sort.
 *
 * ORDER IS THE CONTRACT, newest first: the client takes the head of this list as the session to
 * open. Concatenating without re-sorting put an older linked session ahead of a newer own one and
 * `journey2-input` lost the session it was typing into (2026-08-16).
 */
export function mergeByLink<T extends { id: string; mtime: number }>(
  own: readonly T[],
  core: readonly T[],
  linked: ReadonlySet<string>,
): T[] {
  const seen = new Set(own.map((s) => s.id));
  const fromCore = core.filter((s) => linked.has(s.id) && !seen.has(s.id));
  return [...own, ...fromCore].sort((a, b) => b.mtime - a.mtime);
}

export function linksPath(stateDir: string): string {
  return join(stateDir, "links.json");
}

/**
 * A stored entry, one per appended line. `at` is kept for a human reading the file by hand
 * (requirement: still `cat`-able during a diagnosis) — it is not consulted by the fold.
 */
type Entry = { session: string; record: string; at: number };

/**
 * Whether `line` (already trimmed) is a well-formed NEW-format entry — used both to fold the log
 * and to DECIDE the file's format in the first place (see `readLinks`).
 */
function parseEntry(line: string): Entry | null {
  try {
    const obj: unknown = JSON.parse(line);
    if (typeof obj !== "object" || obj === null) return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec["session"] !== "string" || rec["session"].length === 0) return null;
    if (typeof rec["record"] !== "string") return null;
    const at = typeof rec["at"] === "number" ? rec["at"] : 0;
    return { session: rec["session"], record: rec["record"], at };
  } catch {
    return null;
  }
}

/**
 * Unreadable and malformed both answer "no links", never a throw: losing the file degrades to the
 * old derived behaviour rather than taking the server down.
 *
 * Two shapes on disk. The OLD one (until this build) was a single pretty-printed JSON object,
 * rewritten whole on every write — `readLinks` used to just `JSON.parse` it. The NEW one is
 * append-only: one compact `{session, record, at}` line per write, folded here keeping the LAST
 * entry per session id (a later write for the same session wins, same as the old rewrite did). The
 * format is decided from the first non-blank line — the old shape's `JSON.stringify(..., null, 2)`
 * always opens on a line that is just `{` (or `{}` for zero entries), which is never a valid
 * `{session, record}` entry on its own, so there is no ambiguity in practice. A live `links.json` on
 * disk is real data (his sessions), so this is read-time migration, not a one-shot converter that
 * could be skipped.
 *
 * Per-LINE malformed entries in the new shape are dropped rather than failing the whole file, the
 * same tolerance `parseAliases` gives a bad pair — an append cut short by a crash mid-write leaves
 * one truncated trailing line, and every entry before it is still real.
 */
export async function readLinks(stateDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let raw: string;
  try {
    raw = await Bun.file(linksPath(stateDir)).text();
  } catch {
    return out; // no file yet
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return out;
  const lines = trimmed.split("\n");
  const firstLine = lines[0]?.trim() ?? "";

  if (parseEntry(firstLine) !== null) {
    // NEW shape: NDJSON, fold last-entry-wins, skipping any line that does not parse.
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.length === 0) continue;
      const entry = parseEntry(trimmedLine);
      if (entry === null) continue; // a truncated or corrupt line — skip it, keep the rest
      if (entry.record.trim().length === 0) {
        out.delete(entry.session);
        continue;
      }
      out.set(entry.session, entry.record);
    }
    return out;
  }

  // OLD shape: one JSON object for the whole file.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return out;
    for (const [session, record] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof record === "string" && record.trim().length > 0) out.set(session, record);
    }
  } catch {
    // A broken file — the fallback covers it same as a missing one.
  }
  return out;
}

/**
 * Idempotent in effect (linking a session to the record it already names produces a new,
 * redundant-but-harmless line — folded away on the next read or compaction), and now an APPEND
 * rather than a read-modify-write: two concurrent callers each add their own line instead of each
 * reading the file before the other has written it back, which is how 39 of 40 concurrent writers
 * used to lose their entry (item 55, session-truth/spike.ts). `appendFile`'s default flag is `"a"`
 * (`O_APPEND`) — the write is a single syscall the kernel places at the current end of the file, so
 * two writers cannot interleave into each other's line the way a read-then-write pair could.
 *
 * Assumes the file is already in the NEW shape (or absent) — appending an NDJSON line onto an
 * untouched OLD whole-object file would corrupt it. `compactLinks`, run at boot before the server
 * takes its first request, is what makes that assumption hold; see its doc comment.
 */
export async function writeLink(stateDir: string, session: string, record: string): Promise<void> {
  if (session.length === 0 || record.trim().length === 0) return;
  await mkdir(stateDir, { recursive: true });
  const entry: Entry = { session, record, at: Date.now() };
  await appendFile(linksPath(stateDir), `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Boot-time compaction: rewrite the log to exactly one line per session — the same fold
 * `readLinks` already does, made permanent on disk. Two triggers, not one:
 *
 * - The log is in the OLD whole-object shape: migrated unconditionally, whatever its size, because
 *   `writeLink` only ever APPENDS — appending an NDJSON line onto an untouched old-shape file
 *   produces neither valid JSON nor valid NDJSON, so the very first write in a process's lifetime
 *   must land on an already-migrated file. This is why `compactLinks` runs at boot, before the
 *   server starts accepting the requests that call `writeLink`.
 * - The log is already NDJSON but has grown past `threshold` lines — folded for the same reason
 *   any append-only log eventually is: unbounded growth, not correctness.
 *
 * Never mid-write: a write during compaction would race the rewrite the same way the OLD
 * read-modify-write writer raced itself, which is why this is a separate function the caller
 * invokes once at startup rather than something `writeLink` triggers itself.
 *
 * Writes to a temp file and `rename`s over the log — a rename is atomic on the same filesystem, so
 * a reader never sees a half-written compacted file, and a crash mid-compaction leaves the
 * untouched original log rather than a truncated one.
 */
export async function compactLinks(stateDir: string, threshold = 500): Promise<void> {
  const path = linksPath(stateDir);
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return; // no file yet — nothing to compact
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const lines = trimmed.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const isNewShape = parseEntry(firstLine) !== null;
  const lineCount = lines.filter((l) => l.trim().length > 0).length;
  if (isNewShape && lineCount <= threshold) return; // already the new shape, not yet worth folding

  const links = await readLinks(stateDir);
  const body = [...links.entries()]
    .map(([session, record]) => JSON.stringify({ session, record, at: Date.now() } satisfies Entry))
    .join("\n");
  const tmp = `${path}.compact-${String(process.pid)}-${String(Date.now())}.tmp`;
  await Bun.write(tmp, body.length > 0 ? `${body}\n` : "");
  await rename(tmp, path);
}
