/**
 * Per-session ATTENTION facts for the project tree (SPEC §Attention).
 *
 * Three numbers per session: when the assistant last SAID something, when that saying last ENDED A
 * TURN, and when User last TYPED something. Everything the tree draws — the unread letter, the
 * active ring — is derived from those on the client, because the remaining input is per-device
 * (what this browser has seen) and the server has no business knowing it.
 *
 * Reads the TAIL of each transcript, escalating only when the tail did not carry both facts, and
 * caches per (mtime, size) so the poll costs one stat per session in the steady state. A malformed
 * row degrades to "not a fact", never an error — the same contract as the transcript parser.
 */

import { readdir, stat } from "node:fs/promises";
// The turn-ending test lives in the pure transcript module, so the tree's envelope and the
// transcript's answer glyph read the SAME rule (SPEC 111, 190).
import { endsTurn } from "./transcript.ts";
// The SAME reader the usage rail uses (SPEC 259). Two readers of the prompt-cache window would be
// two rules free to drift, and the row and the rail must never state different numbers of minutes.
import { readCache } from "./train.ts";
import { basename, join } from "node:path";

export interface SessionActivity {
  id: string;
  /**
   * The transcript STORE this session's file sits in — the directory's own name, which is the key
   * the socket is addressed by. SPEC 234, 2026-08-23.
   *
   * Carried because the client cannot derive it at the moment it needs it. `enterRecord` opens the
   * socket in the click's own tick from activity alone, and `sessionStoreKey()` reads the store off
   * the session's file in `state.sessions` — a list that still describes the project being LEFT
   * until its fetch returns. Without this the optimistic connect was addressed to the record's own
   * directory, which since cores (2026-08-16) is not where the session lives: the socket failed and
   * the reader waited out a full second of reconnect backoff before the corrected one opened.
   */
  store: string;
  mtime: number;
  /** ms epoch of the newest assistant message carrying real text; 0 when there is none. */
  lastReply: number;
  /** ms epoch of the newest assistant text that ENDED its turn; 0 when there is none. */
  lastEnded: number;
  /** ms epoch of the newest message User typed HIMSELF — never a tool result, never a reminder. */
  lastTyped: number;
  /**
   * ms epoch of the last API call this transcript recorded, or null when the tail carried none.
   *
   * Read off the SAME slice `readActivity` was given, by `readCache` from `train.ts` (SPEC 259).
   * That slice is smaller than the train's, so when it holds no usage row the answer is null — a
   * row with no bar — never a different number from the one the rail shows.
   */
  cacheAt: number | null;
  /** The prompt-cache bucket that call wrote into (1h or 5m), or null when it stated none. */
  ttlMs: number | null;
  /**
   * A turn is producing output here right now (SPEC 260).
   *
   * Derived PER REQUEST and never memoised: the whole point is that it decays on silence, and a
   * value cached against (mtime, size) would keep saying `true` forever for a child that died —
   * the file stops changing, so the cache key stops changing with it.
   */
  running: boolean;
}

/**
 * How long a transcript may go unwritten and still count as WORKING (SPEC 260).
 *
 * Five minutes rather than one poll, because for a session loom did not spawn the transcript is the
 * only witness there is. A tool call that writes nothing for five minutes reads as not-working,
 * which is the honest direction: the alternative is a row that marches forever for a dead child,
 * and "working" is the one state that means "wait rather than act".
 */
export const WORKING_SILENCE_MS = 5 * 60 * 1000;

/**
 * The transcript's own answer to "is a turn in flight here" — the weaker of the two witnesses.
 *
 * The newest complete row did not END a turn (the `stop_reason` test of SPEC 111) AND the file was
 * written inside the silence window. `runner.running(id)` is the exact witness for a child loom
 * spawned; `main.ts` unions the two, so an exact `true` is never argued down by this one.
 */
export function isWorking(
  session: { mtime: number; lastReply: number; lastEnded: number; lastTyped: number },
  now: number,
): boolean {
  const newest = Math.max(session.lastReply, session.lastTyped);
  if (newest === 0) return false; // nothing has happened here at all
  if (session.lastEnded >= newest) return false; // the newest thing in the file ended its turn
  return now - session.mtime < WORKING_SILENCE_MS;
}

/** Tail sizes tried in order: a reply sitting behind a huge tool output needs more than the first. */
const STEPS = [128 * 1024, 1024 * 1024, 8 * 1024 * 1024] as const;

const cache = new Map<string, { sig: string; value: SessionActivity }>();
const CACHE_MAX = 4000;

/**
 * How many transcript tails may be in memory AT ONCE, across every store (2026-08-30).
 *
 * `listActivity` fans out over a whole store with `Promise.all`, and `/api/activity` fans THAT out
 * over up to 200 stores and 200 records — so one poll from a freshly loaded page started every read
 * in the archive at the same moment. Each read holds an 8 MB slice as a UTF-16 string plus the
 * array `split("\n")` makes of it, so the archive's 1.2 GB became tens of gigabytes of live objects
 * in about two seconds: loom peaked at 23 GB, the machine started swapping and went unresponsive.
 *
 * The reads are I/O, so a small gate costs almost nothing in latency and bounds the peak at roughly
 * `GATE × 40 MB` no matter how large the archive grows.
 */
const BUDGET = 64 * 1024 * 1024;
let held = 0;
const queued: { cost: number; admit: () => void }[] = [];

/**
 * Hold `cost` bytes of the budget for the duration of `read`.
 *
 * A BYTE budget rather than a count of files, because the sizes differ by three orders of magnitude:
 * a gate of N files either serialises the 128 KB reads that are most of the archive (the first cold
 * pass took 55 s at N=4) or lets N of the 8 MB ones run at once. Charging what a read can actually
 * hold keeps hundreds of small tails in flight and only ever queues the big ones.
 */
async function gated<T>(cost: number, read: () => Promise<T>): Promise<T> {
  // A file larger than the whole budget still has to run, or the queue deadlocks on it.
  const charge = Math.min(cost, BUDGET);
  // Charged HERE when it fits, and by whoever admits it when it does not — never twice.
  if (held + charge > BUDGET) await new Promise<void>((admit) => queued.push({ cost: charge, admit }));
  else held += charge;
  try {
    return await read();
  } finally {
    held -= charge;
    // Admit in arrival order, so a big read at the head is not starved by the small ones behind it:
    // the loop stops at the first waiter that does not fit rather than looking past it.
    for (;;) {
      const next = queued[0];
      if (next === undefined || held + next.cost > BUDGET) break;
      queued.shift();
      held += next.cost;
      next.admit();
    }
  }
}

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

/**
 * Did this assistant message END the turn, or is it a word said on the way through?
 *
 * The transcript already carries the answer: the API's `stop_reason`. `tool_use` means the CLI is
 * about to run something and keep going; everything else means the model stopped and the floor is
 * back with User. Stated as "not `tool_use`" rather than "is `end_turn`" because the real files
 * carry `stop_sequence` too (13 of 146 finished turns in the store, measured 2026-08-07), and a
 * stop reason nobody has seen yet still cannot be continued without a tool call. A row with no
 * `stop_reason` at all is a row the CLI never finished writing — not a fact.
 */

export interface ActivityFacts {
  lastReply: number;
  lastEnded: number;
  lastTyped: number;
}

/**
 * Scan complete lines newest-first, filling only the facts still missing.
 *
 * A `user` row is not the same thing as User: tool results ride back as user rows, and so do
 * system reminders and slash-command envelopes. The typed test is the one the session index already
 * uses for `firstPrompt` — a text block that does not open with `<`.
 */
export function readActivity(
  text: string,
  fallbackTs: number,
  into: ActivityFacts = { lastReply: 0, lastEnded: 0, lastTyped: 0 },
): ActivityFacts {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (into.lastReply > 0 && into.lastEnded > 0 && into.lastTyped > 0) break;
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;

    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue; // a truncated or half-written line is not a fact
    }

    if (row["isSidechain"] === true) continue;
    const kind = row["type"];
    if (kind !== "user" && kind !== "assistant") continue;
    if (kind === "user" ? into.lastTyped > 0 : into.lastReply > 0 && into.lastEnded > 0) continue;

    const message = row["message"];
    if (typeof message !== "object" || message === null) continue;
    const body = firstText((message as { content?: unknown }).content);
    if (body === null || body.trim().length === 0) continue;
    if (kind === "user" && body.trimStart().startsWith("<")) continue;

    const raw = row["timestamp"];
    const at = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    const when = Number.isNaN(at) ? fallbackTs : at;
    if (kind === "user") {
      into.lastTyped = when;
    } else {
      if (into.lastReply === 0) into.lastReply = when;
      if (into.lastEnded === 0 && endsTurn(message)) into.lastEnded = when;
    }
  }
  return into;
}

/**
 * Reads in flight, keyed by path AND signature.
 *
 * The client polls activity every few seconds, and the first pass over a cold archive takes far
 * longer than one poll interval — so without this the second poll misses the same cache the first
 * one has not filled yet and reads every transcript a second time, on top of the first. The cost
 * multiplies by however many polls the pass outlives.
 */
const pending = new Map<string, Promise<SessionActivity | null>>();

export async function activityOf(dir: string, file: string): Promise<SessionActivity | null> {
  const path = join(dir, file);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return null;
  }

  const sig = `${info.mtimeMs}:${info.size}`;
  const hit = cache.get(path);
  if (hit !== undefined && hit.sig === sig) return hit.value;
  const already = pending.get(`${path} ${sig}`);
  if (already !== undefined) return already;
  const read = readOne(path, file, dir, { size: info.size, mtimeMs: info.mtimeMs });
  pending.set(`${path} ${sig}`, read);
  try {
    return await read;
  } finally {
    pending.delete(`${path} ${sig}`);
  }
}

async function readOne(
  path: string,
  file: string,
  dir: string,
  info: { size: number; mtimeMs: number },
): Promise<SessionActivity | null> {
  const sig = `${info.mtimeMs}:${info.size}`;

  const found: ActivityFacts = { lastReply: 0, lastEnded: 0, lastTyped: 0 };
  // The widest slice actually read, kept so the cache window comes off the SAME bytes the facts did
  // rather than a second read of the file (SPEC 259).
  // Behind the gate as ONE unit, not per step: a file that escalates to 8 MB must not hand its slot
  // back between steps and then take a second one while the first slice is still live.
  const tail = await gated(Math.min(info.size, STEPS[STEPS.length - 1] ?? info.size), async () => {
    let widest = "";
    const handle = Bun.file(path);
    for (const step of STEPS) {
      const from = Math.max(0, info.size - step);
      let text: string;
      try {
        text = await handle.slice(from, info.size).text();
      } catch {
        break;
      }
      // A byte-sliced head ends mid-line and mid-character: the first line of a slice is not a line.
      widest = from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
      readActivity(widest, info.mtimeMs, found);
      // Deliberately NOT escalating for a missing `lastEnded`: a session whose tail has a reply but no
      // finished turn is a session mid-turn, and the only end-of-turn further back is one User
      // already answered — he had to type to start this turn at all. Reading megabytes to find a
      // letter that would be stale anyway is the wrong trade, so it stays absent until the turn lands.
      if (from === 0 || (found.lastReply > 0 && found.lastTyped > 0)) break;
    }
    return widest;
  });

  const window = readCache(tail);
  const value: SessionActivity = {
    id: file.replace(/\.jsonl$/, ""),
    store: basename(dir),
    mtime: info.mtimeMs,
    lastReply: found.lastReply,
    lastEnded: found.lastEnded,
    lastTyped: found.lastTyped,
    // Null when this slice held no usage row — the honest absence, never a guessed hour.
    cacheAt: window === null ? null : window.at,
    ttlMs: window?.ttlMs ?? null,
    // Placeholder only. The memo below is keyed by (mtime, size), so a `true` stored here would
    // outlive the turn it described; `listActivity` recomputes it against the caller's clock.
    running: false,
  };
  if (cache.size >= CACHE_MAX) cache.clear(); // a viewer's cache may be dumb; it may not be unbounded
  cache.set(path, { sig, value });
  return value;
}

/** Activity for every session of one transcript store. A store that does not exist yields nothing. */
export async function listActivity(dir: string, now: number = Date.now()): Promise<SessionActivity[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const all = await Promise.all(files.map((f) => activityOf(dir, f)));
  return all
    .filter((a): a is SessionActivity => a !== null)
    // A FRESH object per answer, not the memoised one: `running` is the only field that changes
    // while the file does not, and the caller is free to raise it (main.ts unions `runner`).
    .map((a) => ({ ...a, running: isWorking(a, now) }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Activity for every session across multiple transcript stores, deduplicated by ID and sorted newest-first. */
export async function listActivityForDirs(dirs: readonly string[], now: number = Date.now()): Promise<SessionActivity[]> {
  const lists = await Promise.all(dirs.map((d) => listActivity(d, now)));
  const all = lists.flat();
  all.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set<string>();
  const out: SessionActivity[] = [];
  for (const a of all) {
    if (!seen.has(a.id)) {
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}

export interface AnsweredRecords {
  /** One entry per requested path, known or not — the shape `/api/activity` has always returned. */
  data: Record<string, SessionActivity[]>;
  /**
   * The requested paths this answer actually RESOLVED, as opposed to defaulted. A record the scan
   * does not know about (renamed, deleted, or a stale rail row) still gets `[]` in `data` — one
   * bad path must not blank every other record's marks — but it is never `answered`: the client
   * must not read "genuinely has nothing" from a record it could not actually ask about.
   *
   * SPEC requirement 237. Before this, `state.activity[path] ?? []` on the client was one value
   * doing two jobs — "I asked and there is nothing" and "I have not asked yet" — and a busy
   * project wore the "new" badge for the whole first poll because the two could not be told apart.
   */
  answered: string[];
}

/**
 * Sort every wanted record path into `data` (always) and `answered` (only when the scan actually
 * knows it) — pure, so the property that a dropped path can never silently answer can be pinned
 * without touching a filesystem. `resolve` is called only for a known path, so a caller that never
 * looked one up cannot accidentally mark it answered either.
 */
export function answerRecords(
  wanted: readonly string[],
  knownPaths: ReadonlySet<string>,
  resolve: (record: string) => SessionActivity[],
): AnsweredRecords {
  // `Object.create(null)` — a record path is an untrusted string (a vault filename), and a plain
  // `{}` treats the key `__proto__` as the prototype slot rather than an own property: `data`
  // would then answer that one path from `Object.prototype`, which is never a real activity list.
  const data: Record<string, SessionActivity[]> = Object.create(null) as Record<string, SessionActivity[]>;
  const answered: string[] = [];
  for (const record of wanted) {
    if (!knownPaths.has(record)) {
      data[record] = [];
      continue;
    }
    data[record] = resolve(record);
    answered.push(record);
  }
  return { data, answered };
}
