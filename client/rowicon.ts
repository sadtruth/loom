/**
 * What the mark left of a project's name says, as arithmetic (SPEC 256-258).
 *
 * The tree row had three marks — dot, envelope, badge — added by three different afternoons and
 * never ranked, with the order living as an `if` in `treeDot` and a second `if` two hundred lines
 * away at its call site. This module is the written order, and it is a module rather than a comment
 * so a test can pin the ladder against a TABLE instead of against the code that draws it: a
 * property asserting only "exactly one state wins" passes on any order at all.
 *
 * Pure and DOM-free on purpose — `app.ts` turns these answers into elements, and nothing here
 * fetches, polls or reads a clock it was not handed.
 */

/** The four states, in the order they beat each other. Highest wins; exactly one is drawn. */
export type RowIconState = "working" | "unread" | "new" | "status";

/** The facts a row has about itself, each already decided elsewhere. */
export interface RowIconFacts {
  /** A turn is producing output in one of this record's sessions right now (SPEC 260). */
  working: boolean;
  /** A finished reply this device has never shown (SPEC 111). */
  unread: boolean;
  /** Created in the last days with no session attached yet (SPEC 237). */
  isNew: boolean;
}

/**
 * The ladder: **working -> unread -> new -> status**.
 *
 * Working outranks unread because "wait rather than act" is the more urgent instruction, and unread
 * outranks new because a waiting reply is a fact about now while an age is a fact about the past.
 * `status` is the floor: every row has one, so the ladder is total and never returns nothing.
 */
export function rowIconState(facts: RowIconFacts): RowIconState {
  if (facts.working) return "working";
  if (facts.unread) return "unread";
  if (facts.isNew) return "new";
  return "status";
}

/**
 * Which of the four may wear the cache bar (SPEC 258).
 *
 * `new` means no session is attached, so there is no window a bar could describe — a bar there
 * could only ever be empty. `working` means the window is being pushed FORWARD by the turn in
 * flight rather than spent, so a countdown would be counting the wrong way.
 */
export function carriesBar(state: RowIconState): boolean {
  return state === "unread" || state === "status";
}

/** The two numbers a prompt-cache window is: when the call landed, and the bucket it wrote into. */
export interface CacheWindow {
  at: number;
  ttlMs: number;
}

/**
 * Pick the window a row speaks for: the one with the MOST left, because that is the session User
 * would type into (SPEC 257). A record's store holds a train of sessions, so an icon about "the sessions, so an icon about "the
 * session" has to say which one, and this is the written rule rather than "the first in the list".
 *
 * A session whose transcript stated no bucket carries no window and is skipped — never a guessed
 * hour. Ties break on nothing: two windows ending at the same instant draw the same bar.
 */
export function warmestWindow(
  sessions: readonly { cacheAt?: number | null; ttlMs?: number | null }[],
): CacheWindow | null {
  let best: CacheWindow | null = null;
  for (const session of sessions) {
    const at = session.cacheAt;
    const ttlMs = session.ttlMs;
    if (typeof at !== "number" || typeof ttlMs !== "number") continue;
    if (!Number.isFinite(at) || !Number.isFinite(ttlMs) || ttlMs <= 0) continue;
    if (best === null || at + ttlMs > best.at + best.ttlMs) best = { at, ttlMs };
  }
  return best;
}

/** Under a FIFTH of the window the fill goes amber — a fraction, not a fixed ten minutes. */
export const CACHE_LOW = 0.2;

/**
 * What is LEFT of the window, as a fraction of it.
 *
 * **Zero means nothing is drawn at all** — neither fill nor track. A cold row is exactly the row it
 * was before this feature existed, and the absence is the message (User, 2026-08-11: *"when its
 * run out it should not be visible at all"*). The amber threshold is a fifth rather than ten fixed
 * minutes because the CLI also writes a 5-minute bucket, which a fixed threshold would paint amber
 * from birth.
 */
export function cacheFraction(window: CacheWindow | null, now: number): number {
  if (window === null) return 0;
  const { at, ttlMs } = window;
  if (!Number.isFinite(at) || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now)) return 0;
  const left = at + ttlMs - now;
  if (!(left > 0)) return 0;
  return Math.min(1, left / ttlMs);
}

/** How long the window still has, in words — the tooltip on the whole icon. */
export function cacheTooltip(window: CacheWindow | null, now: number): string | null {
  if (window === null || cacheFraction(window, now) <= 0) return null;
  const left = window.at + window.ttlMs - now;
  const mins = Math.max(1, Math.round(left / 60_000));
  return `cached for another ${String(mins)} min`;
}
