/**
 * Session index for the picker. Reads only the head and tail of each transcript — a full parse of 64
 * sessions is ~28k rows and the picker needs five fields.
 */

import { type SessionPick } from "./picks.ts";
import { PROJECTS_ROOT } from "./projects.ts";
import { AGY_PROJECTS_ROOT } from "./agy.ts";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface SessionInfo {
  id: string;
  file: string;
  bytes: number;
  mtime: number;
  /** ms epoch of the first row carrying a timestamp — where this session sits in a train's order. */
  startedAt: number;
  title: string | null;
  firstPrompt: string | null;
  gitBranch: string | null;
  pick: SessionPick | null;
  family: "claude" | "google";
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * One summary per (file, mtime, size) — SPEC 232, found while measuring 231.
 *
 * With the record scan cached, `/api/records/sessions` still answered in 332-390ms and it is the
 * request the rail waits on before the socket can open. This is where that went: the store holds
 * 251 transcripts and a gigabyte, and every call read 256KiB of head plus 64KiB of tail from each
 * one and JSON-parsed both, to fill in five fields.
 *
 * A transcript is append-only, so `mtime:size` names its content exactly: the same signature can
 * only be the same bytes, and a session being typed into changes both. That makes this cache have
 * no staleness at all, unlike the record scan's — it is a pure memo, and the same shape
 * `server/activity.ts` already uses for the same store.
 */
const summaries = new Map<string, { sig: string; value: SessionInfo }>();
const SUMMARY_MAX = 4_000;

function firstText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return null;
}

/** Whole lines only — a byte-sliced head ends mid-line and mid-character. */
function completeLines(text: string, dropFirst: boolean): string[] {
  const lines = text.split("\n");
  if (dropFirst) lines.shift();
  else lines.pop();
  return lines.filter((l) => l.length > 0);
}

/** Derive session family from disk path if not explicitly stated. */
export function familyForDir(dir: string, agyRoot: string = AGY_PROJECTS_ROOT): "claude" | "google" {
  try {
    const rDir = resolve(dir);
    const rAgy = resolve(agyRoot);
    return rDir.startsWith(rAgy) || rDir.includes("/.loom/agy/projects") || rDir.includes("/agy/")
      ? "google"
      : "claude";
  } catch {
    return "claude";
  }
}

async function summarise(dir: string, file: string, family?: "claude" | "google"): Promise<SessionInfo | null> {
  const path = join(dir, file);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return null;
  }

  const bytes = info.size;
  const sig = `${String(info.mtimeMs)}:${String(bytes)}`;
  const remembered = summaries.get(path);
  if (remembered !== undefined && remembered.sig === sig) return remembered.value;

  const handle = Bun.file(path);
  let head = "";
  let tail = "";
  try {
    head = await handle.slice(0, Math.min(bytes, HEAD_BYTES)).text();
    if (bytes > HEAD_BYTES) tail = await handle.slice(Math.max(0, bytes - TAIL_BYTES), bytes).text();
  } catch {
    return null;
  }

  const session: SessionInfo = {
    id: file.replace(/\.jsonl$/, ""),
    file: path,
    bytes,
    mtime: info.mtimeMs,
    startedAt: 0,
    title: null,
    firstPrompt: null,
    gitBranch: null,
    pick: null,
    family: family ?? familyForDir(dir),
  };

  const scan = (lines: readonly string[]): void => {
    for (const line of lines) {
      let row: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        row = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof row["gitBranch"] === "string" && session.gitBranch === null) {
        session.gitBranch = row["gitBranch"];
      }
      // The HEAD is scanned first, so the first stamped row wins — that is when this session began,
      // which is what orders a train (SPEC §Train). mtime would order by when it was last touched.
      if (session.startedAt === 0 && typeof row["timestamp"] === "string") {
        const at = Date.parse(row["timestamp"]);
        if (!Number.isNaN(at)) session.startedAt = at;
      }
      if (row["type"] === "ai-title" && typeof row["aiTitle"] === "string") {
        session.title = row["aiTitle"];
      }
      if (session.firstPrompt === null && row["type"] === "user" && row["isSidechain"] !== true) {
        const message = row["message"];
        if (typeof message === "object" && message !== null) {
          const text = firstText((message as { content?: unknown }).content);
          if (text !== null && !text.trimStart().startsWith("<")) {
            session.firstPrompt = text.slice(0, 300);
          }
        }
      }
    }
  };

  scan(completeLines(head, false));
  if (tail.length > 0) scan(completeLines(tail, true));
  // Bounded, because a long-lived server sees every session in every store. Oldest-first eviction,
  // which for an append-only store is close enough to least-recently-useful.
  if (summaries.size >= SUMMARY_MAX) {
    const oldest = summaries.keys().next();
    if (oldest.done !== true) summaries.delete(oldest.value);
  }
  summaries.set(path, { sig, value: session });
  return session;
}

export async function listSessions(dir: string, family?: "claude" | "google"): Promise<SessionInfo[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const all = await Promise.all(files.map((f) => summarise(dir, f, family)));
  return all
    .filter((s): s is SessionInfo => s !== null)
    .sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : (b.startedAt || 0) - (a.startedAt || 0)));
}

export interface SessionSource {
  dir: string;
  family?: "claude" | "google";
}

/**
 * Merges multiple session arrays, deduplicating by session ID (keeping the newest by mtime),
 * and sorting newest-first.
 */
export function mergeSessionLists(lists: readonly (readonly SessionInfo[])[]): SessionInfo[] {
  const all = lists.flat();
  all.sort((a, b) => (b.mtime !== a.mtime ? b.mtime - a.mtime : (b.startedAt || 0) - (a.startedAt || 0)));
  const seen = new Set<string>();
  const out: SessionInfo[] = [];
  for (const s of all) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}

/**
 * Lists sessions from multiple source directories, deduplicating by ID and sorting newest-first.
 */
export async function listSessionsFromSources(sources: readonly (string | SessionSource)[]): Promise<SessionInfo[]> {
  const lists = await Promise.all(
    sources.map((src) => {
      if (typeof src === "string") {
        return listSessions(src);
      }
      return listSessions(src.dir, src.family);
    }),
  );
  return mergeSessionLists(lists);
}

/**
 * Lists sessions for a project key across Claude and Agy roots.
 */
export async function listSessionsForProject(
  key: string,
  claudeRoot: string = PROJECTS_ROOT,
  agyRoot: string = AGY_PROJECTS_ROOT,
): Promise<SessionInfo[]> {
  return listSessionsFromSources([
    { dir: join(claudeRoot, key), family: "claude" },
    { dir: join(agyRoot, key), family: "google" },
  ]);
}

/**
 * Resolves a session id to its transcript path on disk.
 * If the transcript exists under agyRoot, returns that path.
 * If it exists under claudeRoot, returns that path.
 * Otherwise defaults to claudeRoot.
 */
export function transcriptPath(
  projectKey: string,
  sessionId: string,
  claudeRoot: string = PROJECTS_ROOT,
  agyRoot: string = AGY_PROJECTS_ROOT,
): string | null {
  if (!SAFE.test(projectKey) || !SAFE.test(sessionId)) return null;
  const agyFile = join(agyRoot, projectKey, `${sessionId}.jsonl`);
  if (existsSync(agyFile)) return agyFile;
  const claudeFile = join(claudeRoot, projectKey, `${sessionId}.jsonl`);
  if (existsSync(claudeFile)) return claudeFile;
  return claudeFile;
}

/**
 * Resolves a session id directly to the transcript path for the given family.
 */
export function transcriptPathForFamily(
  projectKey: string,
  sessionId: string,
  family: "claude" | "google",
  claudeRoot: string = PROJECTS_ROOT,
  agyRoot: string = AGY_PROJECTS_ROOT,
): string | null {
  if (!SAFE.test(projectKey) || !SAFE.test(sessionId)) return null;
  return family === "google"
    ? join(agyRoot, projectKey, `${sessionId}.jsonl`)
    : join(claudeRoot, projectKey, `${sessionId}.jsonl`);
}

export function attachPicks(sessions: SessionInfo[], picks: Record<string, SessionPick>): SessionInfo[] {
  for (const s of sessions) {
    const p = picks[s.id];
    if (p !== undefined) {
      s.pick = p;
    }
  }
  return sessions;
}

