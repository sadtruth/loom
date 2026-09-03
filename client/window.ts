/**
 * How much of the transcript is actually in the DOM (SPEC 228).
 *
 * A session opens at its end, and everything above the last screen is history the reader has not
 * asked for. Drawing all of it before showing any of it is what made a 228-turn session take
 * 2,784ms to put its first message on screen (measured 2026-08-20), and keeping all of it there is
 * what made the same session cost 18,400 DOM nodes for the twelve turns anybody was looking at.
 *
 * So the transcript is WINDOWED: the turns inside the viewport plus a margin are real nodes, and
 * everything above and below them is two empty elements of the right height. It is not a budget and
 * not a truncation — nothing is dropped, the scroller is exactly as tall as the whole session, and
 * scrolling mounts what it reaches. The cost of a session stops growing with its length.
 *
 * Everything here is pure arithmetic over measured or estimated heights, so it is pinned by
 * properties (`tests/props/window.props.test.ts`) rather than only by a browser.
 */

/** One turn, as far as the window is concerned. */
export interface TurnSpan {
  /** Where the turn begins in the message array — the cut is a turn boundary, always. */
  at: number;
  /** `turn:<uuid>`, the same key the reconcile uses, so a measured height survives a redraw. */
  key: string;
  /** Modelled height in px: what it measured last time it was mounted, or an estimate. */
  height: number;
}

export interface WindowPlan {
  /** Message index the mounted slice starts at, inclusive. */
  from: number;
  /** Message index the mounted slice ends at, exclusive. */
  to: number;
  /** Turn index the mounted slice starts at, inclusive. */
  first: number;
  /** Turn index the mounted slice ends at, exclusive. */
  last: number;
  /** Modelled height of the history above the slice, in px. */
  above: number;
  /** Modelled height of the history below the slice, in px. */
  below: number;
}

export interface Viewport {
  /** Where turn 0 begins inside the scrolled content — the seams and the recap sit above it. */
  base: number;
  scrollTop: number;
  /** The scroller's own height. */
  height: number;
  /**
   * Is the reader on the live end? Then the window is taken from the BOTTOM and no measurement of
   * the scroll position is consulted at all — which is what makes the opening paint exact, because
   * at that moment there is no layout to measure yet.
   */
  atEnd: boolean;
  /** How much to mount beyond the viewport, each way, so an ordinary scroll finds rows already there. */
  overscan: number;
  /**
   * What is mounted right now, if anything.
   *
   * The window GROWS before it prunes: a turn that is already on screen stays on screen while the
   * mounted set is still small, and is only dropped once keeping it would cost more than the window
   * is allowed to. Unmounting eagerly is correct arithmetic and wrong behaviour — it takes a turn
   * out from under whatever is pointing at it, and every remaining driven failure on 2026-08-23 was
   * that: scroll an element to the middle of the screen and it is gone by the time you click it.
   */
  drawn?: { first: number; last: number } | null;
}

/**
 * The fewest turns ever mounted — a guard against mounting nothing, and nothing more.
 *
 * It was 8, and 8 was wrong for a reason worth writing down: with turns of ordinary height a floor
 * that large covers the viewport BY ITSELF, so the geometry above it stops deciding anything. Two
 * mutations of the covering rule survived the property suite on 2026-08-23 purely because of it —
 * the check could not fail, which is the same as not having one (VERIFY.md, "show the check failing
 * before believing it passes"). The floor is now the smallest number that keeps a window non-empty,
 * and covering the screen is the covering rule's job.
 */
export const MIN_TURNS = 2;

/** Below this many turns a session is drawn whole: the window costs more than it saves. */
export const WINDOW_FROM = 40;

/**
 * A turn's height before it has ever been on screen.
 *
 * Wrong estimates are not a correctness problem — the mounted rows carry their real heights and the
 * scroll anchor corrects the reader's place after every redraw (SPEC 211/199) — but a wildly wrong
 * one makes the scrollbar jump under the reader's hand as history mounts. So it is derived from the
 * text the turn actually holds rather than from a constant: prose wraps at roughly 90 characters in
 * the 1440px column, a line is ~22px, a closed tool disclosure is one line of summary, and an image
 * is a thumbnail.
 */
export function estimateHeight(bulk: { chars: number; tools: number; images: number }): number {
  const lines = Math.ceil(bulk.chars / 90);
  const px = 44 + lines * 22 + bulk.tools * 26 + bulk.images * 220;
  return Math.max(56, Math.min(4000, px));
}

function prefixSums(turns: readonly TurnSpan[]): number[] {
  const pre = new Array<number>(turns.length + 1);
  pre[0] = 0;
  for (let i = 0; i < turns.length; i += 1) {
    pre[i + 1] = (pre[i] as number) + Math.max(0, turns[i]?.height ?? 0);
  }
  return pre;
}

/**
 * Which turns to mount, and how tall the two spacers are.
 *
 * The one invariant everything else rests on: `above + (the mounted turns' modelled heights) +
 * below` is the whole session's modelled height, whatever the window is. That is what stops the
 * scroller changing size as the window moves, and a scroller that changes size under a reader is
 * the "jumping" this project is named for.
 */
export function planWindow(turns: readonly TurnSpan[], messageCount: number, view: Viewport): WindowPlan {
  const count = turns.length;
  if (count === 0) return { from: 0, to: messageCount, first: 0, last: 0, above: 0, below: 0 };

  const pre = prefixSums(turns);
  const total = pre[count] as number;

  let first: number;
  let last: number;
  if (view.atEnd) {
    // From the BOTTOM, so the opening paint needs no layout: the last turns are what the reader
    // came for and they are on screen before anything has been measured.
    last = count;
    const want = view.height + view.overscan;
    first = count;
    while (first > 0 && (pre[last] as number) - (pre[first - 1] as number) <= want) first -= 1;
    if (first === last) first = last - 1;
  } else {
    const top = view.scrollTop - view.base - view.overscan;
    const bottom = view.scrollTop - view.base + view.height + view.overscan;
    first = 0;
    while (first < count - 1 && (pre[first + 1] as number) <= top) first += 1;
    last = first + 1;
    while (last < count && (pre[last] as number) < bottom) last += 1;
  }

  // The floor is applied at the end and towards the end of the session, because a reader who is
  // near the bottom must never be short of the turns below them.
  if (last - first < MIN_TURNS) {
    last = Math.min(count, first + MIN_TURNS);
    first = Math.max(0, last - MIN_TURNS);
  }

  // KEEP WHAT IS ALREADY UP, while it is cheap to. The union of the wanted range and the drawn one
  // costs nothing but DOM, and the ceiling is what keeps the whole point of this file true: the
  // mounted set is still a constant multiple of the screen, never a function of the session.
  const drawn = view.drawn ?? null;
  if (drawn !== null && drawn.last > drawn.first) {
    const grownFirst = Math.max(0, Math.min(first, drawn.first));
    const grownLast = Math.min(count, Math.max(last, drawn.last));
    const ceiling = view.height + view.overscan * 4;
    if ((pre[grownLast] as number) - (pre[grownFirst] as number) <= ceiling) {
      first = grownFirst;
      last = grownLast;
    }
  }

  const from = turns[first]?.at ?? 0;
  const to = last < count ? (turns[last]?.at ?? messageCount) : messageCount;
  return {
    from,
    to,
    first,
    last,
    above: pre[first] as number,
    below: total - (pre[last] as number),
  };
}

/**
 * Where each turn sits inside the scrolled content — what the gutter places its points from once
 * most turns are not DOM nodes to measure (SPEC 192).
 */
export function turnTops(turns: readonly TurnSpan[], base: number): number[] {
  const pre = prefixSums(turns);
  return turns.map((_, i) => base + (pre[i] as number));
}

/** The whole session's modelled height, which is what the scroller must be able to reach. */
export function modelledHeight(turns: readonly TurnSpan[]): number {
  return prefixSums(turns)[turns.length] as number;
}
