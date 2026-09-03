/**
 * Scroller state, anchoring, marker gutter, and the transcript window.
 */

import { isToolCarrier, spokenText, turnBulk, type Message } from "./render.ts";
import {
  estimateHeight,
  planWindow,
  turnTops,
  WINDOW_FROM,
  type TurnSpan,
  type WindowPlan,
} from "./window.ts";
import { readingIndex } from "./gutter.ts";
import type { PendingEcho } from "./types.ts";
import { state, ui } from "./store.ts";

/**
 * Where WE last left the scroller, so a move nobody here made can be told from one that was.
 *
 * -1 until the first move, which is "nothing to compare against yet".
 */
export let leftAt = -1;

export function setLeftAt(v: number): void {
  leftAt = v;
}

/**
 * Are we following the live end, or reading history? The reader decides, and only the reader.
 *
 * A boolean rather than a measurement at the moment of use, because every moment the reader meets
 * the end is a moment the page is still GROWING — and a measurement taken mid-growth reads
 * "somewhere above the end" for a reader who never moved.
 */
export let stuck = true;

export function setStuck(v: boolean): void {
  stuck = v;
}

/**
 * A scroll of OURS, waiting to be told apart from his.
 *
 * This used to be a POSITION — `lastPin`, and a scroll event landing within a pixel of it was ours.
 * A position is a coincidence waiting to happen, and it happened: a reader who scrolls BACK to the
 * end lands on exactly the place our own pin left, so his gesture read as ours, `stuck` was never
 * re-armed, and the next append did not follow the end (journey12's docked case, 21px short,
 * 2026-08-12). A mark is not a guess about where he landed — only a scroll we performed raises it.
 */
export let ourScroll = false;

/**
 * Move the scroller ourselves, marked.
 *
 * Two things this must not do, both of them ways for a mark to swallow HIS next gesture:
 * it does not mark a move that did not happen — assigning the position we are already at fires no
 * event at all — and it does not let a mark outlive the frame it was made in, which is what bounds
 * two of our moves coalescing into one event. Scroll events are dispatched before animation-frame
 * callbacks, so anything our move caused has already been seen by the time the frame clears it.
 */
export function moveTranscript(top: number): void {
  const body = ui.transcript;
  const was = body.scrollTop;
  body.scrollTop = top;
  // Read BACK, not `top`: the browser clamps to the scroller's own maximum, and `syncStuck` below
  // compares against where the scroller actually ended up.
  leftAt = body.scrollTop;
  if (body.scrollTop === was) return;
  ourScroll = true;
  requestAnimationFrame(() => {
    ourScroll = false;
  });
}

/**
 * Where a scroll has to END for the reader to still count as reading the live end.
 *
 * 140 → 48 → 12, and the shrinking is the same story each time: the end used to be a fuzzy region
 * (84px of padding the auto-scroll stopped short of), and it is now an exact position that
 * `pinToEnd()` lands on to the pixel. Tolerance only has to cover sub-pixel layout and a touch
 * rubber-band now — so 12, because this is read on the reader's OWN scroll events, and anything
 * larger means a deliberate 20px nudge upwards gets undone by the next redraw a second later.
 */
export const STICK_PX = 12;

/**
 * Read the reader's position NOW, because his scroll event has not arrived yet.
 *
 * A scroll event is dispatched asynchronously, at the next rendering update — so between his
 * gesture and the event that tells us about it there is a gap, and a redraw landing in that gap
 * still read `stuck` as true and pinned him back to the end. His scroll was undone before we ever
 * heard about it. Measured 2026-08-23 on the docked-append pin: six `pinToEnd`s inside 1.3s of a
 * session opening, one of them landing on top of the gesture.
 *
 * The position is not a guess about whose scroll it was: `moveTranscript` records every move of
 * ours, so a scroller sitting somewhere else was moved by him or clamped by the browser — and
 * `atBottom()` tells those two apart, since a clamp lands exactly on the end.
 */
export function syncStuck(): void {
  const body = ui.transcript;
  if (leftAt < 0 || Math.abs(body.scrollTop - leftAt) < 1) return;
  setStuck(atBottom());
  setLeftAt(body.scrollTop);
}

export function atBottom(): boolean {
  const body = ui.transcript;
  return body.scrollHeight - body.scrollTop - body.clientHeight < STICK_PX;
}

/**
 * Go to the bottom NOW, instantly.
 *
 * Instant, not smooth: a smooth scroll animates towards the height the transcript had when it was
 * called, and during a running turn the transcript is taller by the time it lands. Every "it
 * doesn't quite reach the bottom" report has that shape. The distance is one message, so the
 * animation was never worth much anyway.
 */
export function pinToEnd(): void {
  moveTranscript(ui.transcript.scrollHeight);
}

/**
 * Called at the end of every redraw. THIS is what makes the end hold: `scrollToEnd()` alone only
 * fixes the height at the instant it runs, and the things that arrive late — the working row
 * appended by `drawStep()`, a step label rewrapping, an image decoding — each leave the reader
 * short by their own height. Measured 32px against the live instance, 2026-08-08, which is exactly
 * one working row.
 */
export function holdEnd(): void {
  syncStuck();
  if (stuck) pinToEnd();
}

/**
 * The marker gutter (SPEC 192), experimental and the first thing dropped.
 *
 * The points he can see, in the order they are drawn, each with the turn it points at and where
 * that turn sits inside the scrolled content. `gutterPoints` is rebuilt whenever the transcript is;
 * `markGutter` only ever toggles a class, because it runs on every scroll event.
 */
export let gutterPoints: { dot: HTMLElement; uuid: string; top: number }[] = [];

export function setGutterPoints(points: { dot: HTMLElement; uuid: string; top: number }[]): void {
  gutterPoints = points;
}

/** Where a row sits inside the scrolled content — rect-based, because the scroller is not the offset parent. */
export function contentTop(row: HTMLElement): number {
  return row.getBoundingClientRect().top - ui.transcript.getBoundingClientRect().top + ui.transcript.scrollTop;
}

/**
 * The smallest distance between two points that still leaves both clickable: a point's hit box is
 * 14px tall (`.mm`), so anything closer than that means the lower one covers the upper one, and the
 * click he aims at the turn above lands on the turn below it. Playwright says it plainly — `<button
 * class="mm"> intercepts pointer events` — and it is the first point of a long session, the one
 * furthest from where he is, that becomes unreachable.
 */
const POINT_GAP = 14;

/**
 * Pull overlapping points apart, in the gutter's own pixels.
 *
 * The proportional placement above is the honest one — a point sits where its turn sits — but two
 * turns 30px apart in a 20,000px transcript land 0.15% apart in a 900px gutter, which is the same
 * pixel. The lower dot is drawn last, so it wins every click aimed at the upper one.
 *
 * One forward pass pushes each point at least `POINT_GAP` below the previous, then a backward pass
 * pulls the run back inside the gutter if it overflowed the bottom. Only the crowded runs move; a
 * point with room keeps the position its turn earned. When there are more points than the gutter has
 * room for, the gap shrinks to what fits and the guarantee degrades to "as far apart as possible" —
 * a map of 200 turns in 868px cannot have 200 separately clickable points, and pretending otherwise
 * would push the last ones off the bottom.
 */
export function spreadGutter(): void {
  const room = ui.gutter.clientHeight;
  const count = gutterPoints.length;
  if (room <= 0 || count === 0) return;
  const gap = Math.min(POINT_GAP, room / count);
  const at = gutterPoints.map((point) => Number(point.dot.dataset["at"] ?? 0) * room);

  for (let i = 1; i < count; i += 1) {
    const previous = at[i - 1] as number;
    at[i] = Math.max(at[i] as number, previous + gap);
  }
  // The forward pass can only push DOWN, so the last point is the one that can fall off the end.
  // Clamp it, then carry the correction back up — without the clamp this pass has nothing to do,
  // since the forward pass already left every neighbour a full gap apart.
  at[count - 1] = Math.min(at[count - 1] as number, room);
  for (let i = count - 2; i >= 0; i -= 1) {
    const next = at[i + 1] as number;
    at[i] = Math.min(at[i] as number, next - gap);
  }
  gutterPoints.forEach((point, i) => {
    point.dot.style.top = `${Math.max(0, Math.min(room, at[i] as number))}px`;
  });
}

/** Ring the point being read. Runs on every scroll event, so it does nothing but toggle a class. */
export function markGutter(): void {
  const chosen = readingIndex(
    gutterPoints.map((p) => p.top),
    ui.transcript.scrollTop,
    ui.transcript.clientHeight,
    ui.transcript.scrollHeight,
  );
  gutterPoints.forEach((point, i) => point.dot.classList.toggle("on", i === chosen));
}

// ── visibility ──────────────────────────────────────────────────────

export function visible(turn: readonly Message[]): boolean {
  const first = turn[0];
  if (first === undefined) return false;
  return !(first.isMeta && !state.showMeta);
}

/**
 * The messages in the order they will be READ, each with the time it is placed by.
 *
 * That time is the transcript's, except for a user row the queue remembers accepting earlier: that
 * one is placed by its ACCEPT time (SPEC 145). The CLI writes a queued message into the transcript
 * when it picks the message up, which is after everything the turn ahead of it produced — so a
 * message answered ten minutes later was stamped ten minutes late, and moved from where it had been
 * shown to the bottom of the page the moment it was answered. Anchoring is what holds it still.
 *
 * A stable sort, so anything the queue says nothing about keeps its transcript order exactly.
 */
export function anchorOrder(messages: readonly Message[], anchors: readonly PendingEcho[]): { message: Message; at: number }[] {
  const free = [...anchors];
  let last = 0;
  const placed = messages.map((message, index) => {
    const own = Date.parse(message.ts);
    // An unparseable ts inherits its predecessor's place rather than becoming NaN and sorting first.
    const at = Number.isNaN(own) ? last : own;
    last = at;
    let place = at;
    if (message.role === "user") {
      const text = spokenText(message);
      // One anchor per row: the same text sent twice must consume two entries, oldest first.
      const hit = text.length === 0 ? -1 : free.findIndex((a) => a.text.trim() === text);
      const anchor = hit >= 0 ? free.splice(hit, 1)[0] : undefined;
      // Only ever EARLIER: an anchor explains a late stamp, it never postpones a row.
      if (anchor !== undefined && anchor.at < at) place = anchor.at;
    }
    return { message, at: place, index };
  });
  placed.sort((a, b) => a.at - b.at || a.index - b.index);
  return placed;
}

/**
 * A reader who is NOT following the live end must not be moved by anything that changes height
 * ABOVE him — a redraw, a block that finishes loading, an image decoding (SPEC 155).
 *
 * `scrollTop` alone does not survive that: it is a distance from the top, so anything above the
 * viewport growing or shrinking slides the page under his eyes. So the anchor is a ROW — the first
 * message row still on screen — and its offset from the scroller's top. After the redraw the same
 * row is put back at the same offset, and whatever happened above it is absorbed.
 *
 * User, 2026-08-10: *"the chat keeps jumping to the middle or somewhere when im not at the lowest
 * point and you are writing something"*.
 */
export interface ScrollAnchor {
  /** The first rows still on screen, each with its own offset — nearest first (SPEC 213). */
  rows: { uuid: string; offset: number }[];
  /** Where he was, for the last resort: everything he was looking at is gone. */
  top: number;
  height: number;
  /**
   * Where the MODEL put the first row on screen, and which turn that was (SPEC 228).
   *
   * This is the last resort, and it is the only one that is exact. Two earlier ones were not: the
   * distance from the END of the document moves for reasons that have nothing to do with the
   * reader, and the height of the TOP SPACER changes every time the window mounts a turn — the
   * spacer shrinks by exactly the height of the rows that replaced it, so nothing above the reader
   * has actually changed, and correcting by that difference walks them up the page. Measured
   * 2026-08-23: one 400px scroll into unmeasured history produced seven of our own corrections and
   * moved the reader 4,404px, which is the jumping this project is named for.
   *
   * A turn's modelled top is the same number the window is planned with, so it is defined whether
   * or not the turn is a DOM node, and it moves only when the model really changes.
   */
  key: string;
  modelled: number;
  offset: number;
}

/** How many rows down to keep a fallback for. Past this, the redraw deleted his whole screen. */
const ANCHOR_DEPTH = 8;

/**
 * Put the freshly drawn rows on screen, KEEPING every row that would have come out identical
 * (SPEC 211). The redraw stays full — every row is still rendered from the messages, every frame —
 * and this decides only which of those results reaches the DOM.
 *
 * It exists because `replaceChildren` destroys what it replaces, and some things cannot be rebuilt
 * without the reader seeing it happen. An `<iframe>` is the hard case and it is worth stating: a
 * frame reloads whenever it is RE-PARENTED, not merely when it is rebuilt, because removing it from
 * the document discards its browsing context. So no cache of frame nodes can fix the flashing — the
 * row it sits in has to be left alone entirely, which is what this does. A pasted image, a grid
 * tile, a plan block and an open `<details>` come along for the same ride.
 *
 * What this is NOT is an incremental patcher, and the difference is the whole reason it is safe:
 * nothing is ever patched. A row is either untouched or thrown away and replaced whole, decided by
 * `turnSignature`, which carries every input the renderer read. There is no path where half of a
 * row is old — the failure mode the full redraw was chosen to avoid (this file's header).
 */
export function reconcile(host: HTMLElement, fresh: readonly HTMLElement[]): void {
  const wanted = new Set<string>();
  for (const node of fresh) {
    const key = node.dataset["drawKey"];
    if (key !== undefined) wanted.add(key);
  }
  // The TAIL — the working row, the composer's spacer, the composer itself — is never touched here;
  // `isTail` is the same rule SPEC 203 is written against, not a second copy of it. It keeps its
  // place because everything else is inserted before it.

  // Anything not in this draw goes FIRST, so what remains is in its final relative order and the
  // walk below never has to move a survivor past a corpse.
  const kept = new Map<string, HTMLElement>();
  for (const node of [...host.children] as HTMLElement[]) {
    if (isTail(node)) continue;
    const key = node.dataset["drawKey"];
    if (key === undefined || !wanted.has(key)) {
      node.remove();
      continue;
    }
    if (kept.has(key)) node.remove();
    else kept.set(key, node);
  }

  // The cursor NEVER steps over a tail node. When it reaches one, every remaining row is inserted
  // before it — which is what keeps the composer last. Skipping past the tail instead sent the
  // cursor to null and appended the rest of the transcript UNDER the composer (2026-08-14).
  let cursor: ChildNode | null = host.firstChild;
  for (const node of fresh) {
    const key = node.dataset["drawKey"];
    const had = key === undefined ? undefined : kept.get(key);
    const reuse = had !== undefined && had.dataset["drawSig"] === node.dataset["drawSig"];
    const put = reuse ? (had as HTMLElement) : node;
    if (key !== undefined) kept.delete(key);
    if (cursor === put) {
      cursor = put.nextSibling;
    } else {
      // The stale node this one replaces may BE the cursor, and removing it would leave the cursor
      // pointing at something that is no longer a child — which `insertBefore` refuses on the next
      // turn, taking the whole redraw down with it. So step over it before it goes.
      if (had !== undefined && !reuse && cursor === had) cursor = had.nextSibling;
      // `insertBefore` MOVES a node that is already here — which for a survivor means a reload, so
      // the ordering above is what keeps this to the insert case in every ordinary frame.
      host.insertBefore(put, cursor);
      if (!reuse && had !== undefined) had.remove();
    }
  }
  while (cursor !== null) {
    const next = cursor.nextSibling;
    if (!isTail(cursor)) cursor.remove();
    cursor = next;
  }
}

/**
 * Where the window's model believes a turn begins, by its draw key — defined for every turn of the
 * live session, mounted or not, which is what makes it usable as an anchor under a window.
 */
function modelledTopOf(key: string, known?: readonly TurnSpan[]): number | null {
  const spans = known ?? liveSpans();
  const index = spans.findIndex((span) => span.key === key);
  if (index < 0) return null;
  return turnTops(spans, winBase)[index] ?? null;
}

export function takeAnchor(): ScrollAnchor | null {
  if (stuck) return null;
  const body = ui.transcript;
  const top = body.getBoundingClientRect().top;
  const rows: { uuid: string; offset: number }[] = [];
  let key = "";
  let offset = 0;
  for (const row of body.querySelectorAll<HTMLElement>("[data-uuid]")) {
    const rect = row.getBoundingClientRect();
    // Everything from the first row still on screen downwards. The first one carries a NEGATIVE
    // offset whenever he is reading inside a tall message, which is correct and is the whole point:
    // his place is measured from that row's top wherever that top happens to be.
    if (rect.bottom <= top) continue;
    if (rows.length === 0) {
      key = row.dataset["drawKey"] ?? "";
      offset = rect.top - top;
    }
    rows.push({ uuid: row.dataset["uuid"] ?? "", offset: rect.top - top });
    if (rows.length >= ANCHOR_DEPTH) break;
  }
  if (rows.length === 0) return null;
  const modelled = key === "" ? null : modelledTopOf(key);
  return {
    rows,
    top: body.scrollTop,
    height: body.scrollHeight,
    key,
    offset,
    modelled: modelled ?? Number.NaN,
  };
}

export function restoreAnchor(anchor: ScrollAnchor | null): void {
  if (anchor === null || stuck) return;
  const body = ui.transcript;
  // The first row that SURVIVED the redraw, each remembered with its own offset — so restoring
  // against a fallback is exact rather than a guess. Before 211 there was no fallback at all: the
  // anchored row being gone (he toggled the noise off, a car closed, a seam was cut) meant the
  // function returned, leaving a raw `scrollTop` standing against a document whose heights had all
  // changed. That is the "random place" he lands in.
  for (const { uuid, offset } of anchor.rows) {
    const row = body.querySelector<HTMLElement>(`[data-uuid="${CSS.escape(uuid)}"]`);
    if (row === null) continue;
    const drift = row.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
    if (Math.abs(drift) >= 1) moveTranscript(body.scrollTop + drift);
    return;
  }
  // Nothing he could see still exists as a NODE — which under a window is the ordinary case, not a
  // disaster: the turn is still perfectly real, it simply is not mounted any more. So his place is
  // put back against the MODEL, which says where that turn begins whether or not anything drew it
  // (SPEC 228). Only a real change in the model moves him, and mounting history is not one.
  if (anchor.key !== "" && Number.isFinite(anchor.modelled)) {
    const now = modelledTopOf(anchor.key);
    if (now !== null) {
      const want = now - anchor.offset;
      if (Math.abs(want - body.scrollTop) >= 1) moveTranscript(want);
      return;
    }
  }
  const from = anchor.height - anchor.top;
  moveTranscript(body.scrollHeight - from);
}

/**
 * The tail of the scroller (SPEC 199): the working row, the spacer that holds the composer's place,
 * and the composer itself. The three nodes a redraw must never DETACH — see `drawTranscript`.
 */
function isTail(node: Node): boolean {
  return (node as HTMLElement).id === "chat-working" || node === ui.composerAnchor || node === ui.composer;
}

/**
 * What each turn of the LIVE session measured the last time it was on screen, and what it is
 * estimated at until then — both keyed by the turn's draw key, which is stable across every redraw.
 *
 * They are never cleared on a redraw and always cleared on a session change (`connect`), because a
 * height belongs to a turn and a turn belongs to a session.
 */
export const turnMeasured = new Map<string, number>();
export const turnEstimated = new Map<string, number>();

/** The plan the DOM currently reflects — `null` when the whole session is drawn. */
export let liveWindow: WindowPlan | null = null;

export function setLiveWindow(plan: WindowPlan | null): void {
  liveWindow = plan;
}

/**
 * The band of scrolled content the mounted turns actually cover, in the scroller's own coordinates.
 *
 * This is the HYSTERESIS, and it is not an optimisation. Re-planning whenever the ideal window
 * differs from the drawn one means re-planning on essentially every scroll event, which churns the
 * DOM at the window's edges — and a turn that is rebuilt while something is being clicked or
 * scrolled to is a turn that moves out from under it. It cost twelve driven journeys on 2026-08-23,
 * every one of them a spec that scrolls to an element and then acts on it, plus three that measure
 * the reader's position to the pixel across an append.
 *
 * So the window is redrawn when the VIEWPORT leaves what is mounted, not when the ideal window
 * moves: inside the band nothing happens at all, and the overscan is what makes the band bigger than
 * the screen.
 */
export let mountedBand: { top: number; bottom: number } | null = null;

/**
 * Where the live session's first turn begins inside the scrolled content: the seams and the recap
 * block sit above it and are drawn in full. Measured off the top spacer after every redraw, so it
 * is a reading of the real layout rather than a second model of it.
 */
export let winBase = 0;

export function setWinBase(base: number): void {
  winBase = base;
}

/**
 * The live session as turns, cheaply.
 *
 * The cut is exactly `groupTurns`' cut — a turn ends at a real user message — expressed as an index
 * into `state.messages` so the slice keeps a tool call and its result together. Rebuilt every
 * redraw, which is a few thousand comparisons; the expensive part, a turn's height, comes out of
 * the caches above and is computed once per turn per session.
 */
export function liveSpans(): TurnSpan[] {
  const messages = state.messages;
  const spans: TurnSpan[] = [];
  const seen = new Set<string>();
  let open: { at: number; key: string; role: string; isMeta: boolean } | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message === undefined || isToolCarrier(message)) continue;
    // The same dedup `groupTurns` applies (SPEC 230), or the window would count turns the renderer
    // never draws and the spacers would be taller than the session.
    if (seen.has(message.uuid)) continue;
    seen.add(message.uuid);
    const sameTurn =
      open !== null && open.role === message.role && message.role !== "user" && open.isMeta === message.isMeta;
    if (sameTurn) continue;
    // THE SAME TURNS THE RENDERER DRAWS, and no others. `renderMessages` skips a meta turn while the
    // meta toggle is off, so counting one here gave the spacers a height for something that would
    // never be on screen — and since which meta turns are inside the window changes as the reader
    // moves, the scroller measured a different height depending on where they had been. That is the
    // 200px SPEC 182's docked-versus-in-the-flow pin reported on 2026-08-23.
    if (!visible([message])) continue;
    open = { at: i, key: `turn:${message.uuid}`, role: message.role, isMeta: message.isMeta };
    spans.push({ at: i, key: open.key, height: 0 });
  }
  // The height of each turn, from the caches. An estimate is computed once and kept, so a session
  // that is scrolled through twice does not pay for it twice.
  for (let t = 0; t < spans.length; t += 1) {
    const span = spans[t] as TurnSpan;
    const measured = turnMeasured.get(span.key);
    if (measured !== undefined) {
      span.height = measured;
      continue;
    }
    let estimate = turnEstimated.get(span.key);
    if (estimate === undefined) {
      const to = t + 1 < spans.length ? (spans[t + 1] as TurnSpan).at : messages.length;
      estimate = estimateHeight(turnBulk(messages.slice(span.at, to)));
      turnEstimated.set(span.key, estimate);
    }
    // CALIBRATED against this session's own turns. The formula is a guess about how text wraps in a
    // column it cannot see; the turns already measured say how wrong it is, and applying that ratio
    // to the rest costs one multiplication. Without it one sweep of a 180-turn session moved the
    // scroller from 14,953px to 12,334px as it went, which is a scrollbar that lies to the hand
    // holding it (measured 2026-08-23).
    span.height = estimate;
  }
  return spans;
}

/**
 * How much overscan to mount beyond the viewport, each way.
 *
 * One screen either side: enough that an ordinary wheel gesture finds its rows already built, small
 * enough that the mounted DOM stays a constant multiple of the screen however long the session is.
 */
export function overscan(): number {
  // TWO SCREENS either way, not one. The window is only allowed to cost a constant multiple of the
  // screen, and within that budget the bigger the band the better: every remount is a chance for
  // something the reader is pointing at to be rebuilt underneath them, and at one screen an ordinary
  // scroll gesture reached the edge of the band often enough to do it. At two, scrolling a page at a
  // time stays inside what is already built. Measured cost at two screens on a 2,600-turn session:
  // still a few dozen rows, still a constant.
  return Math.max(600, ui.transcript.clientHeight);
}

/**
 * Read the real height of every turn this redraw put on screen.
 *
 * One pass after the reconcile, over the mounted rows only — which is the point: it is bounded by
 * the window and not by the session. What it reads replaces that turn's estimate for good, so the
 * modelled height of the session converges on the true one as the reader moves through it.
 */
export function measureWindow(): void {
  // A hidden scroller measures zero for everything, and a band read off it comes out OPEN AT BOTH
  // ENDS — which tells `scheduleWindow` the reader can never leave it, so the window is never
  // planned again for the rest of the session. It read as a transcript stuck on four turns however
  // far it was scrolled, and a chip five hundred turns back that no sweep could reach (journey,
  // 2026-08-23). Unknown is the honest answer, and the first frame with a layout replaces it.
  if (ui.transcript.clientHeight === 0) {
    mountedBand = null;
    return;
  }
  const below = ui.transcript.querySelector<HTMLElement>(".win-below");
  const above = ui.transcript.querySelector<HTMLElement>(".win-above");
  // Read off the LAYOUT, not off the plan: the band is what the reader can actually scroll through
  // without meeting a spacer, which is the only thing the hysteresis may trust. The top of the
  // session and the bottom of it are open ends — a spacer of zero height is not a boundary.
  mountedBand =
    above === null
      ? null
      : {
          top: (above.dataset["drawSig"] ?? "") === "0.00" ? Number.NEGATIVE_INFINITY : contentTop(above) + above.offsetHeight,
          bottom:
            below === null || (below.dataset["drawSig"] ?? "") === "0.00"
              ? Number.POSITIVE_INFINITY
              : contentTop(below),
        };
  if (above !== null) {
    winBase = contentTop(above);
  } else {
    // Drawn whole, so there is no spacer to read: the base is where the live session's FIRST turn
    // starts. It is looked up by key rather than taken as the first row on screen, because an
    // earlier car of a train renders its own turns above this one and they are not part of this
    // session's height model.
    const key = liveSpans()[0]?.key;
    const row =
      key === undefined
        ? null
        : ui.transcript.querySelector<HTMLElement>(`[data-draw-key="${CSS.escape(key)}"]`);
    winBase = row === null ? 0 : contentTop(row);
  }

  // A TURN'S HEIGHT IS THE DISTANCE TO THE NEXT ONE, not its `offsetHeight`.
  //
  // `offsetHeight` is the border box and excludes the 22px margin every `.msg` carries, and a
  // spacer standing in for that turn has no margin of its own — so every turn that left the window
  // took 22px of the page with it, and the reader's position moved by 22px per turn. It read as a
  // 21px yank on a live append and a 508px one across a fullscreen toggle (2026-08-23, five driven
  // pins). Measuring the gap between consecutive rows takes the margin in whatever it happens to be,
  // including the collapsing rules, without this file having to know any of them.
  const laid: HTMLElement[] = [];
  for (const node of ui.transcript.children as HTMLCollectionOf<HTMLElement>) {
    const key = node.dataset["drawKey"];
    if (key === undefined) continue;
    if (key.startsWith("turn:") || key === "win:below") laid.push(node);
  }
  for (let i = 0; i < laid.length; i += 1) {
    const node = laid[i] as HTMLElement;
    const key = node.dataset["drawKey"] as string;
    if (!key.startsWith("turn:")) continue;
    const next = laid[i + 1];
    const height =
      next === undefined || next.hidden
        ? // The last thing before the tail: nothing to measure against, so the margin is read
          // directly. It is one turn out of the window's whole model and it is the one turn that is
          // never above the reader, so a small error here cannot move anybody.
          node.offsetHeight + (Number.parseFloat(getComputedStyle(node).marginBottom) || 0)
        : contentTop(next) - contentTop(node);
    if (height > 0) turnMeasured.set(key, height);
  }
}

/**
 * The window the next redraw should mount, or `null` for "draw the whole session".
 *
 * PLANNED FROM THE TURN THE READER IS ON, not from the pixel they are standing at. The two differ
 * whenever the model changes, and the model changes constantly while history is being mounted: a
 * turn's estimate is replaced by its measurement, everything below it shifts, the scroll anchor
 * moves the reader to keep their row still — and a plan taken from the new pixel then mounts a
 * range further back, whose estimates are wrong in the same direction, which moves them again.
 * Measured 2026-08-23: one 400px scroll produced seven of our own corrections in 200ms and left the
 * reader 4,404px away, looking at a part of the session they had never asked for. Anchored to the
 * turn, a correction above the reader changes the plan's input by nothing at all, because the
 * reader is still on the same turn — which is the only thing "where the reader is" can mean.
 */
export function planLiveWindow(anchor: ScrollAnchor | null): WindowPlan | null {
  const spans = liveSpans();
  if (spans.length < WINDOW_FROM) return null;
  // NOT WHILE THE TRANSCRIPT IS OFF SCREEN. With a file or a record in the centre the scroller has
  // no height, so every measurement a plan rests on reads zero: the window comes out as whatever
  // `MIN_TURNS` allows and both spacers come out at nothing. Keep the plan that was made when there
  // was something to measure — the reader has not moved, because the reader cannot see it.
  if (ui.transcript.clientHeight === 0 && liveWindow !== null) return liveWindow;
  const anchored =
    anchor === null || anchor.key === "" ? null : modelledTopOf(anchor.key, spans);
  return planWindow(spans, state.messages.length, {
    base: winBase,
    scrollTop: anchored === null || anchor === null ? ui.transcript.scrollTop : anchored - anchor.offset,
    height: ui.transcript.clientHeight,
    // Following the live end, the window is taken from the BOTTOM and no layout is consulted at
    // all — which is what makes the paint that OPENS a session exact, since at that moment there is
    // no layout yet to measure.
    atEnd: stuck,
    overscan: overscan(),
    drawn: liveWindow,
  });
}

/**
 * Add accept times to a session's anchors, keeping one entry per (text, at) — the same send arrives
 * in the POST answer, in every job frame while it waits, and in the attach frame forever after.
 */
export function rememberAnchors(session: string, accepts: readonly PendingEcho[]): void {
  if (accepts.length === 0) return;
  const known = state.anchors[session] ?? [];
  const seen = new Set(known.map((a) => `${a.at}\u0000${a.text}`));
  for (const accept of accepts) {
    const key = `${accept.at}\u0000${accept.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    known.push({ text: accept.text, at: accept.at });
  }
  known.sort((a, b) => a.at - b.at);
  state.anchors[session] = known;
}
