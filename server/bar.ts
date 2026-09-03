/**
 * The LIVE 5-hour block meter (SPEC §Bar).
 *
 * User exhausts a 5-hour block in about two hours — all four 429s in the archive landed at
 * 1h54m, 2h11m, 2h26m, 1h59m — and then sits locked out for three. Today he learns this at the
 * moment of the refusal. This module is the number that would have let him choose instead:
 * what the open block has drawn, what it has left, and how fast it is going.
 *
 * ── WHY IT TAILS INSTEAD OF SCANNING ──────────────────────────────────────────────────────
 *
 * The bar is ACCOUNT-wide, so the meter must count every session on the machine, not just
 * loom's — a terminal session in another directory draws the same bar. That is ~90 files and
 * ~90 MB, far too much to re-read on a poll. So the index is incremental, on `activity.ts`'s
 * pattern: remember each file's size, re-read only the bytes that were appended, and never
 * parse a line twice.
 *
 * A transcript writes ONE RECORD PER CONTENT BLOCK, all sharing a `requestId`. Counting
 * records counts a parallel tool batch several times — the trap `batch-report.ts` documents —
 * so usage is taken once per requestId and the rest of the group is dropped.
 *
 * ── WHAT IT CANNOT SEE ────────────────────────────────────────────────────────────────────
 *
 * Calls made on the work MacBook draw the same account bar and are not in this archive. The
 * meter therefore reads LOW, never high, and cannot be made exact from this side.
 *
 * ── THE FITTED PRICE STOPPED BEING THE HEADLINE, 2026-08-26 ──────────────────────────────
 *
 * `spent`/`limit`/`used` above (now `BlockReading`) are the fitted weights against the invented
 * 9.0M ceiling — run against the live archive it once read 100% spent while the account's own
 * quota endpoint (`server/usage.ts`) said 55%. `BlockReading` and `readBar()` are UNCHANGED and
 * kept exactly as they were: the block BOUNDARY they compute is still correct (`readBar()`'s
 * `resets` matched the endpoint to the second) and `spent`/`limit` still feed `bar-report.ts`.
 * What changed is what `/api/bar` reports as the headline: `BarReading`/`readBarReading()` below
 * read the real quota and use the block only to find each session's SHARE of it — the weights
 * only have to be right in RATIO, not in absolute value, and a ratio error is far smaller than
 * the old absolute one.
 *
 * `scale` (window-percent per weighted unit) absorbs any usage this archive cannot see — a call
 * made on another device inflates every per-turn figure derived from it. `multi-device-usage`
 * already made that a non-case in practice.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { barOf, billableOf, blocksOf, callsLeft, family, LIMIT, type Block, type Call } from "./block.ts";
import { readCurrentQuota, type Quota } from "./usage.ts";

/**
 * Read per index pass, not once at import: a spec points HOME at a fixture archive, and a
 * constant frozen at module load would quietly index the real one instead.
 */
function projectsDir(): string {
  return process.env["LOOM_BAR_ARCHIVE"] ?? join(process.env["HOME"] ?? "", ".claude", "projects");
}

/**
 * How far back the index reaches. A block cannot start more than 5h before now, but the block
 * CHAIN — each block opening where the previous one expired — needs history behind it to place
 * that boundary. Seven days is the whole archive and costs nothing at this size.
 */
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

interface FileState {
  /** Byte offset of the first UNPARSED complete line. */
  offset: number;
}

/** A `Call` plus which session wrote it — needed only for the per-session split below, so it is
 *  kept local rather than added to `block.ts`'s `Call`, which every other consumer of that module
 *  has no use for. */
type SessionCall = Call & { sessionId: string };

const files = new Map<string, FileState>();
const seenRequests = new Set<string>();
let calls: SessionCall[] = [];
/** Guards against two polls indexing at once; a second caller reads the previous index. */
let indexing: Promise<void> | null = null;
let lastIndexed = 0;

/**
 * The fitted-weight reading `readBar()` has always returned. UNCHANGED shape and UNCHANGED
 * meaning — see the file header. Named `BlockReading` (not `BarReading`) because `BarReading`
 * below is now what `/api/bar` actually answers with.
 */
export interface BlockReading {
  /** Weighted units drawn in the open block. */
  spent: number;
  limit: number;
  /** 0..1, clamped — the fraction of the block's allowance already drawn. */
  used: number;
  /** ms epoch when the open block expires and the allowance returns. */
  resets: number;
  calls: number;
  /** Calls the block has room for at the rate it has been running. */
  callsLeft: number;
  /** Mean billable input per call — the context size the reads are paying for (task 12). */
  context: number;
  /** Share of the block's bar that is OUTPUT, 0..1. ~0.24 in every measured block. */
  outputShare: number;
  /** ms epoch of the projected exhaustion at the recent rate, or null when it is not moving. */
  exhausts: number | null;
  /** ms epoch of the newest call the index has seen; 0 when the block is empty. */
  latest: number;
}

async function* transcripts(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // no archive on this machine — the meter degrades to empty, never to an error
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* transcripts(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

function parse(text: string): void {
  for (const line of text.split("\n")) {
    // Cheap reject first: most lines in a transcript are tool results and user rows.
    if (line.length === 0 || !line.includes('"usage"')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn line degrades to "not a call", the same contract as the tail parser
    }
    const ts = Date.parse(String(row["timestamp"] ?? ""));
    if (Number.isNaN(ts)) continue;
    const requestId = row["requestId"];
    if (typeof requestId !== "string") continue;
    if (seenRequests.has(requestId)) continue;
    const message = row["message"] as Record<string, unknown> | undefined;
    const usage = message?.["usage"] as Record<string, unknown> | undefined;
    if (usage === undefined) continue;
    seenRequests.add(requestId);
    if (seenRequests.size > 10000) {
      const it = seenRequests.values();
      for (let i = 0; i < 5000; i++) seenRequests.delete(it.next().value as string);
    }
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const sessionId = row["sessionId"];
    calls.push({
      ts,
      model: family(String(message?.["model"] ?? "?")),
      read: n(usage["cache_read_input_tokens"]),
      write: n(usage["cache_creation_input_tokens"]),
      input: n(usage["input_tokens"]),
      output: n(usage["output_tokens"]),
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "?",
    });
  }
}

async function index(now: number): Promise<void> {
  const horizon = now - HORIZON_MS;
  for await (const path of transcripts(projectsDir())) {
    let size: number;
    let mtime: number;
    try {
      const info = await stat(path);
      size = info.size;
      mtime = info.mtimeMs;
    } catch {
      continue;
    }
    const state = files.get(path);
    // A file untouched since the horizon cannot hold a call in any live block. Skipping it on
    // FIRST sight is what keeps the cold start cheap; once indexed, only growth is read.
    if (state === undefined && mtime < horizon) {
      files.set(path, { offset: size });
      continue;
    }
    const from = state?.offset ?? 0;
    if (size <= from) continue;
    let text: string;
    try {
      text = await Bun.file(path).slice(from, size).text();
    } catch {
      continue;
    }
    // The tail of a live transcript is a half-written line. Parse to the last newline and leave
    // the remainder for the next poll, or the row is dropped forever.
    const cut = text.lastIndexOf("\n");
    if (cut < 0) {
      files.set(path, { offset: from });
      continue;
    }
    parse(text.slice(0, cut));
    files.set(path, { offset: from + Buffer.byteLength(text.slice(0, cut + 1)) });
  }
  const keep = now - HORIZON_MS;
  if (calls.some((c) => c.ts < keep)) calls = calls.filter((c) => c.ts >= keep);
  lastIndexed = now;
}

/** The open block, or null when nothing has been drawn inside one. */
function openBlock(now: number): Block | null {
  const blocks = blocksOf(calls);
  const last = blocks[blocks.length - 1];
  if (last === undefined) return null;
  return now < last.end ? last : null;
}

/**
 * Read the meter. Re-indexes at most once every `minGapMs`, so a chatty client cannot turn the
 * poll into a scan loop.
 */
export async function readBar(now = Date.now(), minGapMs = 4000): Promise<BlockReading> {
  if (indexing !== null) await indexing;
  else if (now - lastIndexed >= minGapMs) {
    indexing = index(now).finally(() => {
      indexing = null;
    });
    await indexing;
  }
  const block = openBlock(now);
  if (block === null)
    return {
      spent: 0,
      limit: LIMIT,
      used: 0,
      // With no open block, the next call opens one — five hours from whenever that happens.
      resets: now + 5 * 60 * 60 * 1000,
      calls: 0,
      callsLeft: 0,
      context: 0,
      outputShare: 0,
      exhausts: null,
      latest: 0,
    };
  const elapsed = Math.max(now - block.start, 1);
  const rate = block.bar / elapsed;
  const remaining = LIMIT - block.bar;
  const exhausts = rate > 0 && remaining > 0 ? now + remaining / rate : null;
  const latest = calls.reduce((max, c) => (c.ts > max && c.ts < block.end ? c.ts : max), 0);
  return {
    spent: Math.round(block.bar),
    limit: LIMIT,
    used: Math.min(1, block.bar / LIMIT),
    resets: block.end,
    calls: block.calls,
    callsLeft: callsLeft(block),
    context: block.context,
    outputShare: block.bar > 0 ? block.output / block.bar : 0,
    // Never project past the block's own expiry: at that moment the allowance returns, so an
    // exhaustion predicted after it is not an exhaustion at all.
    exhausts: exhausts !== null && exhausts < block.end ? Math.round(exhausts) : null,
    latest,
  };
}

/** Per-`sessionId` weighted units drawn within `block`. Only billable calls count — the same
 *  rule `blocksOf` uses to decide what may open a block, kept here so a synthetic row (a 429
 *  record, a meta row) cannot inflate a session's share. */
function sessionUnits(block: Block, sessionId: string | null): number {
  if (sessionId === null) return 0;
  let self = 0;
  for (const c of calls) {
    if (c.ts < block.start || c.ts >= block.end) continue;
    if (billableOf(c) === 0) continue;
    if (c.sessionId === sessionId) self += barOf(c);
  }
  return self;
}

/**
 * `/api/bar`'s real answer, 2026-08-26 on — the account's own quota (`server/usage.ts`), not the
 * fitted estimate. `block`/`session` are still built from the tailed archive, because the
 * quota endpoint has no notion of "this session" at all; only their RATIO to the real percentage
 * matters, via `scale`. See the file header for why that ratio is trustworthy even though the
 * fitted absolute total was not.
 */
export interface BarReading {
  /** The last GOOD reading, or null if we have never had one. */
  quota: Quota | null;
  /** true when the most recent fetch failed; `quota` is then stale, not current. */
  stale: boolean;
  /** Window-percent that one weighted unit is worth. 0 when quota is null or the block is empty. */
  scale: number;
  block: { start: number; end: number; units: number };
  /** null when no `session` parameter was given. */
  session: { units: number; percent: number } | null;
}

/**
 * Assembles `BarReading`: re-indexes the archive (via `readBar`, same `minGapMs` gate), polls the
 * quota endpoint (via `readCurrentQuota`, its own 60s gate), and reports this session's share of
 * the open block alongside the real percentages. `sessionId` is null when the caller passed no
 * `session` query parameter — the meter itself stays account-wide (SPEC 120); this only SPLITS
 * what it already reads, it does not scope the reading itself.
 */
export async function readBarReading(
  sessionId: string | null,
  now = Date.now(),
  minGapMs = 4000,
): Promise<BarReading> {
  await readBar(now, minGapMs);
  const { quota, stale } = await readCurrentQuota(now);
  const block = openBlock(now);
  const blockUnits = block !== null ? block.bar : 0;
  const fiveHourPct = quota?.fiveHour?.percent ?? null;
  const scale = fiveHourPct !== null && blockUnits > 0 ? fiveHourPct / blockUnits : 0;
  const self = block !== null ? sessionUnits(block, sessionId) : 0;
  return {
    quota,
    stale,
    scale,
    block: {
      start: block?.start ?? now,
      end: block?.end ?? now + 5 * 60 * 60 * 1000,
      units: blockUnits,
    },
    session: sessionId !== null ? { units: self, percent: self * scale } : null,
  };
}

/** Test seam: drop the index so a spec can point HOME at a fixture archive. */
export function resetBarIndex(): void {
  files.clear();
  seenRequests.clear();
  calls = [];
  lastIndexed = 0;
}
