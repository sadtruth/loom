/**
 * The marker gutter down the right edge of the chat (SPEC 192) — experimental, and separable on
 * purpose: everything it needs lives in this file and one block of CSS, so dropping it is deleting
 * a file and three call sites rather than unpicking a feature.
 *
 * One point per turn carrying an embedded artifact — a build plan or a framed prototype — and
 * nothing else (revised 2026-08-20). The facts come from the turn's own blocks rather than from the
 * row on screen, because under a windowed transcript most turns are not on screen (SPEC 228) and a
 * gutter that could only see the window would be a map of the window.
 *
 * Prototype: `layout/mockups/shell-v8-2026-08-11.html`, the right edge of the centre.
 */

/** What a turn is, as far as a point is concerned. Everything below is decided from this and nothing else. */
export interface TurnFacts {
  /** He typed it. */
  mine: boolean;
  /** It is the answer of a turn of mine — `stop_reason`, via the `.answer` class (SPEC 190). */
  answer: boolean;
  /** The turn carries a build plan. */
  plan: boolean;
  /** The turn carries a prototype. */
  proto: boolean;
}

/**
 * Is this turn a point at all?
 *
 * ONLY a turn carrying an embedded artifact — a build plan or a framed prototype. User,
 * 2026-08-20: *"remove the dots to the right that mark the messages, leave only dots for embeded
 * artifacts"*. A point per message was a ruler, not a map: 175 points in a 179-turn session is one
 * every five pixels, and the two things worth jumping to were lost among them.
 *
 * It is also the gutter's whole cost. `drawGutter` used to walk every row on screen and take a
 * layout read per point, on EVERY redraw — twice a second while a turn is running. Marking only the
 * artifacts takes that loop from every row down to the handful that carry one, and it is what lets
 * the gutter be drawn from the data model instead of the DOM once most turns are not nodes at all
 * (SPEC 228).
 */
export function isPoint(facts: TurnFacts): boolean {
  return facts.plan || facts.proto;
}

/**
 * The classes that carry the shape. Filled green his, hollow blue mine; a square carries a
 * prototype, a gold diamond a build plan. A plan wins over a prototype when a turn has both — the
 * plan is the thing he is looking for in a long session, and two shapes cannot share one point.
 */
export function pointClass(facts: TurnFacts): string {
  const kind = facts.plan ? " plan" : facts.proto ? " proto" : "";
  return `mm${facts.mine ? " user" : ""}${kind}`;
}

/** What the hover card says above the message text. */
export function pointLabel(facts: TurnFacts): string {
  const kind = facts.plan ? " · build plan" : facts.proto ? " · prototype" : "";
  return `${facts.mine ? "user" : "claude"}${kind}`;
}

/**
 * Which point is being read, as an index into `tops` (each point's offset inside the scrolled
 * content, in the order they are drawn).
 *
 * The reading line sits a little below the top of the window, and the point being read is the last
 * one above it. At the END of the scroller that rule stops working: what is under the reading line
 * down there is the tail of the last turn, the permission cards, the spacer and the composer, so
 * the line can never reach the last point however far he scrolls. Being at the bottom IS being on
 * the last one — which is also what makes the gutter agree with `stuck`.
 *
 * Returns -1 when there is nothing to select.
 */
export function readingIndex(
  tops: readonly number[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  line = 90,
): number {
  if (tops.length === 0) return -1;
  if (scrollTop >= scrollHeight - clientHeight - 4) return tops.length - 1;
  const eye = scrollTop + line;
  let chosen = 0;
  for (let i = 0; i < tops.length; i += 1) {
    const top = tops[i];
    if (top !== undefined && top <= eye) chosen = i;
  }
  return chosen;
}
