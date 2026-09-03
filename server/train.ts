/**
 * The train: one record's sessions, ordered as one line of work (SPEC §Train).
 *
 * A train is DERIVED, never stored. `/api/input` spawns a record's children with cwd = the record's
 * directory, so every session started from a record lands in the same transcript store by
 * construction — the train is just that store, read oldest-first. Nothing here writes, and a train
 * is a reading order plus a spawn policy.
 *
 * This file used to say that nothing is carried from one session into the next and no context is
 * summarised forward. That stopped being true on 2026-08-12: SPEC §Recap carries ONE thing across a
 * seam — a recap of the session just left, written by a cheap model, injected once as context and
 * never as a turn. The boundary it bends is narrow and deliberate: the PREVIOUS session only, never
 * the current one, never mid-session, and refusable on the block. loom still does not reimplement
 * the loop. See DECISIONS.md, 2026-08-12.
 *
 * The second thing it carries is what typing into a car COSTS. That is not a guess: the CLI writes
 * its own token accounting into the transcript, so the last assistant row says how big the prefix
 * is, how much of it the last call reused, and which cache bucket it went into. loom reports those
 * facts and leaves the judgement to User — cache age is not the same question as "is it safe to
 * start a new session here", and this module deliberately does not answer the second one.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { escapeCwd } from "./input.ts";
import { listSessions, type SessionInfo } from "./sessions.ts";

export interface CacheState {
  /** ms epoch of the last API call in this session. */
  at: number;
  /** Tokens the next turn's prefix carries — what a cold turn would have to re-write. */
  context: number;
  /** The LAST call's measured reuse, 0..1. Measured, not predicted. */
  reuse: number;
  /** The bucket that call wrote into, from the row's own `ephemeral_*` counters. Null = unstated. */
  ttlMs: number | null;
}

export interface TrainCar extends SessionInfo {
  cache: CacheState | null;
}

export interface Train {
  record: string;
  cwd: string;
  /** The transcript store this record's sessions live in; null when it has none yet. */
  key: string | null;
  /** Oldest first — reading order, not recency. */
  cars: TrainCar[];
}

const HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;

/** Tail sizes tried in order — a usage row can sit behind a very large tool result. */
const STEPS = [128 * 1024, 1024 * 1024, 8 * 1024 * 1024] as const;

const cache = new Map<string, { sig: string; value: CacheState | null }>();
const CACHE_MAX = 2000;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The newest real API call's accounting, scanning complete lines newest-first.
 *
 * PURE, like `readActivity` next door: the property drives this over generated transcripts without
 * a filesystem. Sidechain rows are skipped because a subagent's usage describes the SUBAGENT's
 * context — counting it would report a number that has nothing to do with what User's next
 * message costs.
 */
export function readCache(text: string): CacheState | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;

    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue; // a truncated or half-written line is not an accounting
    }

    if (row["type"] !== "assistant" || row["isSidechain"] === true) continue;
    const message = row["message"];
    if (typeof message !== "object" || message === null) continue;
    const usage = (message as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as Record<string, unknown>;

    const read = num(u["cache_read_input_tokens"]);
    const write = num(u["cache_creation_input_tokens"]);
    const fresh = num(u["input_tokens"]);
    const context = read + write + fresh;
    if (context === 0) continue; // a usage block with no input is not a call worth reporting

    const buckets = u["cache_creation"];
    let ttlMs: number | null = null;
    if (typeof buckets === "object" && buckets !== null) {
      const b = buckets as Record<string, unknown>;
      if (num(b["ephemeral_1h_input_tokens"]) > 0) ttlMs = HOUR_MS;
      else if (num(b["ephemeral_5m_input_tokens"]) > 0) ttlMs = FIVE_MIN_MS;
    }

    const stamp = row["timestamp"];
    const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    return {
      at: Number.isNaN(at) ? 0 : at,
      context,
      reuse: read + write > 0 ? read / (read + write) : 0,
      ttlMs,
    };
  }
  return null;
}

/** Escalating tail read, memoised per (mtime, size) — an idle train costs one stat per car. */
async function cacheOf(path: string): Promise<CacheState | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return null;
  }

  const sig = `${info.mtimeMs}:${info.size}`;
  const hit = cache.get(path);
  if (hit !== undefined && hit.sig === sig) return hit.value;

  let value: CacheState | null = null;
  const handle = Bun.file(path);
  for (const step of STEPS) {
    const from = Math.max(0, info.size - step);
    let text: string;
    try {
      text = await handle.slice(from, info.size).text();
    } catch {
      break;
    }
    // A byte-sliced tail opens mid-line and mid-character: its first line is not a line.
    value = readCache(from > 0 ? text.slice(text.indexOf("\n") + 1) : text);
    if (value !== null || from === 0) break;
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(path, { sig, value });
  return value;
}

/**
 * The cars of one store, oldest first.
 *
 * Ordered by when a session STARTED, not by its mtime: a session resumed after a newer one began
 * would otherwise jump the queue and the history would read out of order. mtime is the fallback for
 * a transcript whose first row carries no timestamp.
 */
export async function assembleTrain(dir: string, family?: "claude" | "google"): Promise<TrainCar[]> {
  const sessions = await listSessions(dir, family);
  const cars = await Promise.all(
    sessions.map(async (session) => ({ ...session, cache: await cacheOf(session.file) })),
  );
  return cars.sort((a, b) => (a.startedAt || a.mtime) - (b.startedAt || b.mtime));
}

/**
 * A record's cars once its sessions stop sharing one store (cores, 2026-08-16).
 *
 * Two sources: the record's OWN directory — everything spawned before the change, and every session
 * started from a terminal — and the sessions LINKED to it inside its core's store. Ordered by start
 * time as one line of work, which is what a train is; which file a car happens to live in is not
 * the reader's business, and `SessionInfo.file` is absolute so a car stays self-describing.
 */
export async function assembleTrainFor(
  ownDir: string,
  coreDir: string,
  linked: ReadonlySet<string>,
  ownAgyDir?: string,
  coreAgyDir?: string,
): Promise<TrainCar[]> {
  const ownClaude = await assembleTrain(ownDir, "claude");
  const ownAgy = ownAgyDir !== undefined ? await assembleTrain(ownAgyDir, "google") : [];
  const ownSeen = new Set<string>();
  const own: TrainCar[] = [];
  for (const c of [...ownClaude, ...ownAgy].sort((a, b) => (a.startedAt || a.mtime) - (b.startedAt || b.mtime))) {
    if (!ownSeen.has(c.id)) {
      ownSeen.add(c.id);
      own.push(c);
    }
  }

  if (ownDir === coreDir && (ownAgyDir === undefined || ownAgyDir === coreAgyDir)) return own;

  const coreClaude = await assembleTrain(coreDir, "claude");
  const coreAgy = coreAgyDir !== undefined ? await assembleTrain(coreAgyDir, "google") : [];
  const coreSeen = new Set<string>();
  const core: TrainCar[] = [];
  for (const c of [...coreClaude, ...coreAgy].sort((a, b) => (a.startedAt || a.mtime) - (b.startedAt || b.mtime))) {
    if (!coreSeen.has(c.id)) {
      coreSeen.add(c.id);
      core.push(c);
    }
  }

  const fromCore = core.filter((c) => linked.has(c.id) && !ownSeen.has(c.id));
  return [...own, ...fromCore].sort((a, b) => (a.startedAt || a.mtime) - (b.startedAt || b.mtime));
}

/** Does this store exist at all? A record whose first session is unsent has no directory yet. */
export async function storeExists(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/** Where a record's store sits — the same escape `/api/input` spawns its children under. */
export function storeKeyOf(cwd: string): string {
  return escapeCwd(cwd);
}

/** Where a record's store sits on disk. */
export function storeDir(root: string, cwd: string): string {
  return join(root, storeKeyOf(cwd));
}
