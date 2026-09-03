/**
 * State, transport, orchestration.
 *
 * Rendering is full-redraw per change. That is deliberate at this size: a 350-message session
 * redraws in a few ms, and an incremental DOM patcher is the classic place for a viewer to grow
 * subtle staleness bugs — the one class of bug a read-only tool has no excuse for.
 *
 * Since SPEC 211 the redraw still RENDERS every row every frame, and reconciles which of those
 * results reaches the DOM: a turn whose signature is unchanged is left alone, and one that changed
 * by a character is replaced WHOLE. That is not the patcher this paragraph warns about — nothing is
 * ever half-updated — and it is what lets a framed prototype survive, since re-parenting an iframe
 * reloads it. `reconcile`, below, is where that lives.
 *
 * The price is that ANYTHING held only in the DOM is deleted by work happening elsewhere, so the
 * redraw's inputs must include what the reader is in the middle of (SPEC 146): a title being typed
 * lives in `treeInput`, a reader's unfolded disclosures in `render.ts`. Adding a surface with
 * transient state means adding it there, never suppressing the redraw. The corollary of 211 is that
 * anything with its OWN clock — a block that re-reads a file — can no longer lean on the redraw to
 * wake it, because the redraw may never call it again.
 */

import {
  el,
  collectResults,
  groupTurns,
  renderTurn,
  spokenText,
  turnArtifacts,
  turnSignature,
  type Message,
} from "./render.ts";
import {
  turnTops,
  type TurnSpan,
} from "./window.ts";
import {
  anchorOrder,
  atBottom,
  contentTop,
  gutterPoints,
  holdEnd,
  liveSpans,
  liveWindow,
  markGutter,
  measureWindow,
  mountedBand,
  moveTranscript,
  ourScroll,
  overscan,
  pinToEnd,
  planLiveWindow,
  reconcile,
  rememberAnchors,
  restoreAnchor,
  setGutterPoints,
  setLeftAt,
  setLiveWindow,
  setStuck,
  setWinBase,
  spreadGutter,
  stuck,
  syncStuck,
  takeAnchor,
  turnEstimated,
  turnMeasured,
  visible,
  winBase,
} from "./scroll.ts";
import { statusClass } from "./chips.ts";
import { labelChips, renderMarkdown } from "./markdown.ts";
import {
  closePane,
  openPath as panePath,
  setEnvironment as setPaneEnvironment,
  showFile,
  type PaneHandles,
} from "./filepane.ts";
import { renderHypotheses, type Hypothesis, type Standing } from "./hypotheses.ts";
import { renderTasks, type Task, type TaskHandlers, type TaskStatus } from "./tasks.ts";
import { renderLifecycle } from "./lifecycle.ts";
import { treeView, type PanelView } from "./panel.ts";
import {
  activityById,
  drawActive,
  recordChildren,
  recordDot,
  sessionLabel,
  treeDot,
  treeFoot,
} from "./tree-marks.ts";
import type { BlockContext } from "./blocks.ts";
import { installZoom } from "./zoom.ts";
import { groupProtos } from "./protos.ts";
import {
  NATIVE_FIT,
  addAttachment,
  draftOwner,
  drawAttachments,
  firstPermitCard,
  fitComposer,
  keepDraft,
  pendingKey,
  pendingPermits,
  permitAt,
  permitCard,
  recordDir,
  renameDraft,
  scheduleFit,
  storeKey,
  switchDraft,
  syncDock,
  undrawnEchoes,
} from "./composer.ts";
import { isPoint, pointClass, pointLabel, type TurnFacts } from "./gutter.ts";
import {
  CHAT_KEY,
  add as addOpen,
  close as closeOpen,
  find as findOpen,
  fromParams as openSetFromParams,
  isOpen as isOpenMember,
  keyId,
  memberKey,
  addOne as addOnly,
  openOne as openOnly,
  pathTitle,
  select as selectOpen,
  selected as selectedOpen,
  toParams as openSetToParams,
  type OpenKind,
  type OpenMember,
  type OpenSet,
  coreFromParams,
  withCore,
} from "./opens.ts";
import { wireTouchGestures } from "./touch.ts";

import type {
  ProtoGroup,
  Artifact,
  CacheState,
  Frame,
  ModelSpec,
  PendingEcho,
  Permit,
  Pin,
  ProjectInfo,
  RecapEntry,
  RecordDoc,
  RecordInfo,
  SessionActivity,
  SessionInfo,
  Train,
  TrainCar,
  BarReading,
} from "./types.ts";
import { need, state, ui } from "./store.ts";
import { setStatus, toast } from "./status.ts";
import { abandonDecorations, decoration, getJson } from "./request.ts";
import { afterTranscript, payOwed } from "./after-transcript.ts";
import {
  drawStep,
  drawSubagents,
  placeAboveTail,
  reconcileJobFromServer,
  setJob,
} from "./working.ts";
import {
  AGED_MS,
  buildBarTooltip,
  buildBudgetsTooltip,
  compactDuration,
  currentActiveBudgetId,
  drawBarTooltip,
  percentOfWindow,
  thousands,
  tickCacheBars,
  updateMicroBars,
  type BudgetsReport,
} from "./quota-bar.ts";

function ctx(): BlockContext {
  return { cwd: state.cwd, records: state.records };
}

/**
 * The context every turn draws against, as one string, for the redraw's signature (SPEC 211).
 *
 * Only two things outside a turn change what it looks like: the session cwd, which relative paths
 * resolve against, and the record list, which decides whether a chip says `project.md` or the
 * project's title. Both are cheap to fingerprint and both arrive AFTER the first draw — the records
 * poll every four seconds — so a stamp that ignored them would leave the first paint's labels on
 * screen for the rest of the session.
 */
function drawStamp(): string {
  let records = "";
  for (const record of state.records) records += `${record.path}:${record.title ?? ""};`;
  return `${state.cwd ?? ""}|${records}`;
}

function paneHandles(): PaneHandles {
  return { layout: ui.layout, head: ui.fileHead, title: ui.fileTitle, path: ui.filePath, body: ui.fileBody };
}

/**
 * Open a file in the CENTRE (SPEC 189). The Obsidian/Finder hand-off is the ↗ button inside it.
 *
 * The file becomes a member of the open set, so it gets a row in the open list and closes the same
 * way a record does. Opening the same file twice is one row, by key — and a record and a file at
 * the same path are two, because the key carries the kind.
 */
function openInPane(path: string, place?: string): void {
  beginGesture(); // opening a file is a place: one Back press closes it again (requirement 222)
  state.filePlace = place ?? null;
  // One thing beside the chat (SPEC 196): opening a file displaces whatever else was open, and
  // that one comes back when this closes.
  openOnlyMember({ kind: "file", key: memberKey("file", path), title: pathTitle(path) });
  // The fetch starts BEFORE the centre is applied: `showFile` claims the path synchronously, so the
  // centre's own pane sync sees the file it is about to show rather than starting a second read.
  // The session's cwd rides along so a RELATIVE path resolves server-side against it AND its
  // ancestors — the cwd alone is a record directory, and prose names files in the tree around it.
  const reading = showFile(
    paneHandles(),
    path,
    ctx(),
    place,
    state.cwd ?? undefined,
    state.activeRecord ?? undefined,
  );
  applyCentre();
  void reading.then(() => renameFileMember(path)).catch((error: unknown) => toast(String(error), true));
}

/**
 * The server answers with the path it actually resolved, which for a relative or `~` chip is not the
 * one asked for. The row has to say the file that is really open, so the member is re-keyed once the
 * answer lands — the same close, the same idempotence, under the real path.
 */
function renameFileMember(asked: string): void {
  const real = panePath();
  if (real === null || real === asked) return;
  const askedKey = memberKey("file", asked);
  const realKey = memberKey("file", real);
  if (!isOpenMember(state.opens, askedKey)) return;
  const wasShowing = state.opens.selected === askedKey;
  state.opens = closeOpen(state.opens, askedKey);
  state.opens = addOpen(state.opens, { kind: "file", key: realKey, title: pathTitle(real) });
  if (wasShowing) state.opens = selectOpen(state.opens, realKey);
  applyCentre();
}

// ── scrolling ───────────────────────────────────────────────────────

/**
 * Put the newest turn on screen: the scroller's own bottom, nothing cleverer.
 *
 * It used to align `.msg:last-of-type` with the viewport floor, on the reasoning that the last 84px
 * were padding and landing on them would show a screen of nothing. That cost more than it bought —
 * from the true bottom every live append jumped the view UP by those 84px (User, 2026-08-07:
 * "when you update something in the chat it automatically pulls me up"), and anything below the
 * last message (a seam, the working line) fell off the screen, which is what `beginNewSession` had
 * to work around by hand.
 *
 * This line is what lets the clearance be padding again (style.css, `#transcript-body`): the reader
 * at rest is at the scroller's maximum, so the padding is a gap under the last message rather than
 * travel below it — and scrolling up puts text in it.
 */
function scrollToEnd(): void {
  setStuck(true);
  pinToEnd();
}

/**
 * Put the composer where the rule says it goes, and show the way back to whatever is off screen.
 *
 * Called from everything that can change either term: typing, scrolling, the box growing, a redraw,
 * a resize. The decision itself is `client/dock.ts`, pure and property-pinned (SPEC 199, 184); this
 * function is only measurement and DOM.
 *
 * The spacer is written on EVERY call, from the composer's measured height — never once at dock
 * time. `fitComposer` runs the box to 40% of the window, and a spacer that remembers the height at
 * the moment of docking diverges from it by every line typed afterwards, which is exactly the lurch
 * 182 exists to prevent.
 */
/**
 * `syncDock` again, after the browser has settled the layout this frame changed.
 *
 * The decision is measurement — the anchor's top against the viewport floor — so it is only as good
 * as the layout at the moment it runs, and three of this build's defects were the same stale read
 * (verifier, 2026-08-13): the pill painted over the send button on 7 of 11 cold loads; a `doc`
 * toggle left a draft 1475px below the fold with neither a dock nor a pill; a `meta` toggle docked
 * the composer with its own place 162px INSIDE the viewport. In all three the state was correct when
 * taken and wrong one frame later, and nothing re-took it — only a scroll event did, which is why
 * they all "fixed themselves" the moment he touched the wheel.
 */
function resyncDock(): void {
  syncDock();
  requestAnimationFrame(() => syncDock());
}


/**
 * Take the reader to a turn of the live session, mounted or not (SPEC 228).
 *
 * Two steps, because the first one cannot be exact: the modelled top is where the window BELIEVES
 * the turn is, and going there is what mounts it; once it is a real element its real position is
 * known and the landing is corrected. A turn already on screen skips straight to the second step.
 */
function jumpToTurn(uuid: string, modelled: number): void {
  // A click here is HIS navigation, so it is deliberately not marked as one of our own scrolls:
  // where he lands decides whether we follow the end, exactly as a wheel notch would.
  const land = (): boolean => {
    const row = document.getElementById(`m-${uuid}`);
    if (row === null) return false;
    ui.transcript.scrollTop = contentTop(row) - 18;
    return true;
  };
  if (land()) return;
  setStuck(false);
  ui.transcript.scrollTop = Math.max(0, modelled - 18);
  drawTranscript();
  land();
}

/**
 * The gutter, drawn from the DATA MODEL rather than from the rows on screen (SPEC 192, 228).
 *
 * It used to walk every `.msg` in the transcript and ask each one whether it contained a plan or a
 * frame. That stopped being possible the moment most turns are not in the transcript: a gutter built
 * from the window would be a map of the window, and the point of a gutter is that the artifact five
 * hundred turns back is the thing you can see and jump to. So the facts come from the turn's blocks
 * (`turnArtifacts`) and the places come from the same modelled heights the window is planned with —
 * measured for every turn that has been on screen, estimated for the rest.
 *
 * Scope: the LIVE session. An earlier car of a train opened inside this one is drawn in full and is
 * not modelled here, so its artifacts carry no point — stated rather than discovered, and the reason
 * is that a car's turns have no place in this session's height model.
 */
function drawGutter(): void {
  ui.gutter.replaceChildren();
  setGutterPoints([]);
  const height = ui.transcript.scrollHeight;
  if (height <= 0) return;
  const spans = liveSpans();
  const tops = turnTops(spans, winBase);
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i] as TurnSpan;
    const to = i + 1 < spans.length ? (spans[i + 1] as TurnSpan).at : state.messages.length;
    const turn = state.messages.slice(span.at, to);
    const first = turn[0];
    if (first === undefined) continue;
    const artifacts = turnArtifacts(turn);
    const facts: TurnFacts = {
      mine: first.role === "user",
      // `stop_reason`, the same fact the left-margin glyph is drawn from (SPEC 190) — read off the
      // message rather than off the class, because the row may not exist.
      answer: first.role === "assistant" && turn[turn.length - 1]?.endsTurn === true,
      plan: artifacts.plan,
      proto: artifacts.proto,
    };
    if (!isPoint(facts)) continue;
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = pointClass(facts);
    const top = tops[i] ?? 0;
    dot.style.top = `${(top / height) * 100}%`;
    dot.dataset["at"] = String(top / height);
    const tip = document.createElement("span");
    tip.className = "tip";
    const label = document.createElement("b");
    label.textContent = pointLabel(facts);
    // A PREVIEW, not the turn. The card is a hover hint a few lines tall, and putting the whole turn
    // in it means the text of a turn exists twice on the page — which is wrong on its own terms and
    // was caught by a pin looking for one copy of an appended row and finding two (2026-08-23).
    const said = spokenText(first).replace(/\s+/g, " ").trim().slice(0, 200);
    tip.append(label, document.createTextNode(said));
    dot.append(document.createElement("i"), tip);
    dot.addEventListener("click", () => jumpToTurn(first.uuid, top));
    ui.gutter.append(dot);
    gutterPoints.push({ dot, uuid: first.uuid, top });
  }
  spreadGutter();
  markGutter();
}


/**
 * The one place `stuck` turns off. A marked scroll is ours and says nothing about him; an unmarked
 * one is his hand, wherever it lands — including back on the end, which is the case the old
 * position test could not see. The mark is NOT cleared here: two of our moves in one frame can
 * arrive as one event or as two, and reading the second as his would let our own correction decide
 * whether we follow the end, which is the 2026-08-07 yank. The frame boundary clears it instead.
 */
ui.transcript.addEventListener(
  "scroll",
  () => {
    // The ring follows the reader whoever moved the page, so it is marked before the test that
    // decides whose scroll this was (SPEC 192).
    markGutter();
    // Whoever moved the page, the window has to cover where it landed (SPEC 228) — this is what
    // mounts history as the reader scrolls up into it.
    scheduleWindow();
    if (ourScroll) return;
    setStuck(atBottom());
    setLeftAt(ui.transcript.scrollTop);
  },
  { passive: true },
);

/**
 * An image is the one piece of a message whose height arrives AFTER the redraw that placed it, so
 * `holdEnd()`'s own list of late arrivals ends with it and nothing was firing that call. A
 * screenshot at the end of a transcript therefore pushed the last message off the bottom as it
 * decoded — the reader ends up a few hundred pixels short, having done nothing (2026-08-08).
 * Capture, because `load` does not bubble; delegated, because the transcript redraws in full.
 */
ui.transcript.addEventListener(
  "load",
  () => {
    holdEnd();
    // An image that just took its height moved every point below it (SPEC 192).
    drawGutter();
  },
  true,
);

/**
 * A rich block whose content arrives after the redraw that placed it (a `plan` reading its file, an
 * `iframe` its document) reports the height it settled at. Following the end, that is `holdEnd`'s
 * job; reading history, the row under the reader's eyes must not move (SPEC 155).
 */
ui.transcript.addEventListener("loom:block-grew", ((event: Event) => {
  // A block that settled moved every point below it, whichever way the reader is facing (SPEC 192).
  drawGutter();
  if (stuck) {
    holdEnd();
    return;
  }
  const detail = (event as CustomEvent<{ delta: number; top: number }>).detail;
  const top = ui.transcript.getBoundingClientRect().top;
  // Only growth ABOVE the reader moves what he is looking at; below him it costs nothing.
  if (detail === null || detail.delta === 0 || detail.top >= top) return;
  moveTranscript(ui.transcript.scrollTop + detail.delta);
}) as EventListener);

// ── rendering ───────────────────────────────────────────────────────

/**
 * Render one session's messages into `frag`; returns how many turns were actually drawn.
 *
 * `echoes` is the queue's undrawn echoes, oldest first, and this MERGES them into the message stream
 * by accept time — each one goes in before the first MESSAGE newer than it, splitting the turn in
 * flight if that is where it falls, and whatever is left over (a message just sent, newer than
 * everything) is the caller's to append. Both coarser rules were wrong. Appending every echo at the
 * end put a message sent third below everything the running turn produced after it (2026-08-10);
 * inserting before the first TURN newer than it did the same thing in a subtler way, because a
 * working turn is ONE group that started before the echo, so the echo still slid to the end of it
 * and drifted down all turn as output piled in above (User, same day: *"the queued message does
 * not stick to one place in chat history and keeps moving"*).
 *
 * `permits` rides the same merge, by the time the card was asked (SPEC 185). Same rule, same reason:
 * a card belongs at the point of the turn it is a question about, and the turn in flight is one
 * group that started before it, so anything coarser slides the card to the end of that turn. Both
 * lists are CONSUMED — what is left over is newer than every message, and the caller appends it.
 */
function renderMessages(
  frag: DocumentFragment,
  messages: readonly Message[],
  echoes: PendingEcho[] = [],
  anchors: readonly PendingEcho[] = [],
  permits: Permit[] = [],
): number {
  // Per message set: tool_use ids are unique inside a session, not across a train. Built over ALL
  // the messages, so splitting a turn never separates a tool call from its result.
  const results = collectResults(messages);
  const stamp = drawStamp();
  let shown = 0;

  const drawSegment = (segment: Message[]): void => {
    for (const turn of groupTurns(segment)) {
      if (!visible(turn)) continue;
      const first = turn[0];
      if (first === undefined) continue;
      const options = {
        ctx: ctx(),
        results,
        pinned: Object.hasOwn(state.pins, first.uuid),
        showThinking: state.showThinking,
        showMeta: state.showMeta,
        onPin: (uuid: string, pinned: boolean) => void togglePin(uuid, pinned),
        stamp,
        // 0 when `/api/bar` has not answered yet, or when it read no quota — `renderTurn` renders
        // nothing rather than a percentage of an unknown window (usage-bar, 2026-08-26).
        scale: state.bar?.scale ?? 0,
      };
      // Already on screen and identical: hand the reconcile a stand-in rather than rendering it
      // again (SPEC 211). Only ever taken for a key `liveRows` holds, which is the same map the
      // reconcile is built from, so the stand-in can never be what lands on screen.
      const key = `turn:${first.uuid}`;
      const sig = turnSignature(turn, options);
      if (liveRows.get(key)?.dataset["drawSig"] === sig) {
        frag.append(reuseRow(key, sig));
        shown += 1;
        continue;
      }
      const node = renderTurn(turn, options);
      if (node === null) continue;
      frag.append(node);
      shown += 1;
    }
  };

  let segment: Message[] = [];
  // Everything older than `at` goes in before it, oldest first, whichever list it came from. Two
  // separate loops would order an echo and a card by which loop ran, not by when they happened.
  const flushBefore = (at: number): void => {
    for (;;) {
      const echo = echoes[0];
      const permit = permits[0];
      const echoAt = echo === undefined ? Number.POSITIVE_INFINITY : echo.at;
      const cardAt = permit === undefined ? Number.POSITIVE_INFINITY : permitAt(permit);
      if (echoAt >= at && cardAt >= at) return;
      drawSegment(segment);
      segment = [];
      if (echoAt <= cardAt) frag.append(echoNode((echoes.shift() as PendingEcho).text));
      else frag.append(permitCard(permits.shift() as Permit));
    }
  };

  for (const { message, at } of anchorOrder(messages, anchors)) {
    flushBefore(at);
    segment.push(message);
  }
  drawSegment(segment);
  return shown;
}

function whenLabel(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime()) || at === 0) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function carLabel(car: TrainCar): string {
  return (car.title ?? car.firstPrompt ?? car.id.slice(0, 8)).replace(/\s+/g, " ").slice(0, 70);
}

/**
 * A seam — where one session ends and the next begins, drawn plainly rather than hidden.
 *
 * User asked for exactly this ("yes seam should be visible clearly"), and it is also honest: the
 * two sides of a seam do not share a context, so a viewer that stitched them silently would be
 * claiming a continuity that does not exist. An unopened car's seam is the control that opens it.
 */
function seamRow(car: TrainCar, open: boolean, current: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = `seam${current ? " current" : ""}${open ? " open" : ""}`;
  row.dataset["session"] = car.id;

  const when = whenLabel(car.startedAt || car.mtime);
  const text = `${when}${when.length > 0 ? " · " : ""}${carLabel(car)}`;

  if (open) {
    const label = document.createElement("span");
    label.className = "seam-label";
    label.textContent = current ? `${text} · this session` : text;
    row.append(label);
    return row;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "seam-label seam-open";
  button.textContent = state.carsLoading.has(car.id) ? `loading… · ${text}` : `↑ earlier session · ${text}`;
  button.title = "Read this earlier session in place";
  button.addEventListener("click", () => void openCar(car.id));
  row.append(button);
  return row;
}

/** The seam for a session that does not exist yet — the one the button just opened. */
function pendingSeam(): HTMLElement {
  const row = document.createElement("div");
  row.className = "seam current open";
  const label = document.createElement("span");
  label.className = "seam-label";
  label.textContent = "new session · nothing sent yet";
  row.append(label);
  return row;
}

/** The cars before the one being typed into. Empty outside a record, or when the train is unknown. */
function earlierCars(): TrainCar[] {
  if (state.activeRecord === null) return [];
  // A composed-but-unsent session has no id yet, so it is not IN the train — but it sits at the end
  // of one, and everything already there is behind it. User, 2026-08-07: pressing the button
  // "moved me to another session and it didnt look like the same window being a train". It did not:
  // this returned nothing the moment the id went empty, so the whole history disappeared at exactly
  // the moment he cut the seam — the one moment continuity has to be visible.
  if (state.pendingNew) return state.train;
  const here = state.train.findIndex((c) => c.id === state.sessionId);
  return here <= 0 ? [] : state.train.slice(0, here);
}

function currentCar(): TrainCar | undefined {
  return state.train.find((c) => c.id === state.sessionId);
}

/** Pull one earlier car's transcript in above the seam. History, so it is fetched flat, never tailed. */
async function openCar(id: string): Promise<void> {
  if (Object.hasOwn(state.carsOpen, id) || state.carsLoading.has(id)) return;
  state.carsLoading.add(id);
  drawTranscript();
  try {
    const body = await getJson<{ messages: Message[] }>(
      `/api/transcript?project=${encodeURIComponent(sessionStoreKey())}&session=${encodeURIComponent(id)}`,
    );
    state.carsOpen[id] = body.messages;
  } catch (error) {
    toast(`could not open that session: ${String(error)}`, true);
  } finally {
    state.carsLoading.delete(id);
  }
  // Keep the reader where they were: opening history above must not move what is under their eyes.
  // Through `moveTranscript`, because a raw write is read back by the scroll listener as HIS
  // gesture and re-decides whether we are following the live end (213).
  const body = ui.transcript;
  const from = body.scrollHeight - body.scrollTop;
  drawTranscript();
  moveTranscript(body.scrollHeight - from);
}



/**
 * The rows currently on screen, by key — read ONCE at the top of a paint and used twice: to decide
 * which turns need rendering at all, and to reconcile what was rendered. Both readers must see the
 * same DOM, or a turn skipped as unchanged could find nothing to reuse and leave a hole.
 */
let liveRows = new Map<string, HTMLElement>();

function rowIndex(host: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>();
  for (const node of host.children as HTMLCollectionOf<HTMLElement>) {
    const key = node.dataset["drawKey"];
    if (key !== undefined && !rows.has(key)) rows.set(key, node);
  }
  return rows;
}

/**
 * A turn that is already on screen unchanged, as a stand-in the reconcile will swap for the real
 * one. Rendering it again would be pure waste — and not cheap waste: building a plan block re-reads
 * its file and every prototype in it, so an unchanged turn cost two HTTP requests per redraw, twice
 * a second, for a result that was then thrown away (measured 2026-08-14, six fetches over one turn).
 */
function reuseRow(key: string, sig: string): HTMLElement {
  const stub = document.createElement("article");
  stub.dataset["drawKey"] = key;
  stub.dataset["drawSig"] = sig;
  return stub;
}


/** The two sections the block shows. The other five stay in the ledger, one click away. */
const CARRIED = ["State", "Open threads"] as const;

function sectionOf(body: string, name: string): string {
  const re = new RegExp(`^#{1,3}\\s+${name}\\s*$([\\s\\S]*?)(?=^#{1,3}\\s+|$(?![\\s\\S]))`, "m");
  return re.exec(body)?.[1]?.trim() ?? "";
}

/**
 * The block: where you left off, above your first message.
 *
 * It is drawn from `state.recap`, never from the transcript, because it is not a message — nothing
 * was said and nothing was answered. Gold, because loom already spends gold on what he chose.
 */
function recapNode(): HTMLElement | null {
  const carried = state.recap;
  if (carried === null) return null;

  const wrap = el("div", "recap");
  const head = el("div", "recap-head");
  head.append(el("span", "who", "where you left off"));

  if (carried.phase === "running") {
    wrap.classList.add("working");
    // The clock, not a spinner: he watched this line on two projects and read it as a hang —
    // *"it shows for a moment the words that recap will be here but then it never appears"* — and
    // was wrong only about the time. A minute is normal, so the line says so (requirement 181).
    head.append(el("span", "when recap-wait", waitLabel()));
    startRecapClock();
    wrap.append(head);
    return wrap;
  }

  if (carried.phase === "failed" || carried.entry === null) {
    wrap.classList.add("failed");
    head.append(el("span", "when", carried.reason ?? "the recap failed"));
    const again = el("button", "recap-x", "run it again");
    again.addEventListener("click", () => void rerunRecap());
    head.append(again);
    wrap.append(head);
    return wrap;
  }

  const entry = carried.entry;
  head.append(el("span", "when", `${entry.title} · ${whenLabel(Date.parse(entry.writtenAt))}`));
  const x = el("button", "recap-x", "×");
  x.title = "not this one — drop it";
  x.addEventListener("click", () => void dismissRecap());
  head.append(x);
  wrap.append(head);

  for (const name of CARRIED) {
    const body = sectionOf(entry.body, name);
    if (body.length === 0) continue;
    wrap.append(el("div", "recap-lbl", name));
    wrap.append(renderMarkdown(body, ctx(), { breaks: true }));
  }

  const rest = el("div", "recap-rest");
  const link = el("button", "recap-link", "the other sections, in the ledger");
  link.addEventListener("click", () => {
    // Beside the RECORD (SPEC 173/218), which is where the ledger is written. Off `state.cwd` this
    // opened the core's shared pile — the one file every project's recap used to land in.
    const dir = state.activeRecord === null ? null : dirOfRecord(state.activeRecord);
    if (dir !== null) openInPane(`${dir}/recap-ledger.md`);
  });
  rest.append(link);
  // Where this copy came from, when it is not the one that was delivered (requirement 180). His
  // call, 2026-08-13: a block re-read after a restart says so rather than posing as the live one.
  if (carried.from === "ledger") rest.append(el("span", "recap-from", "re-read from the ledger"));
  wrap.append(rest);
  return wrap;
}

/** m:ss since the run started, and the fact that a minute of it is normal (requirement 181). */
function waitLabel(): string {
  const started = state.recapStarted;
  if (started === null) return "recapping the last session…";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return `recapping the last session… ${mmss} · usually about a minute`;
}

/**
 * One second at a time, on the LINE rather than through `drawTranscript()`.
 *
 * A redraw per second would rebuild every message in the car and fight his scroll for the whole
 * minute the recap takes — the block is the only thing that changed, so the block is all that is
 * rewritten. The interval stops itself the moment the phase is no longer running.
 */
let recapTimer: number | null = null;

function startRecapClock(): void {
  if (recapTimer !== null) return;
  recapTimer = window.setInterval(() => {
    if (state.recap?.phase !== "running") {
      window.clearInterval(recapTimer ?? 0);
      recapTimer = null;
      return;
    }
    const line = document.querySelector(".recap.working .recap-wait");
    if (line !== null) line.textContent = waitLabel();
  }, 1000);
}

async function dismissRecap(): Promise<void> {
  state.recap = null;
  drawTranscript();
  try {
    // Before the first send there is no session to refuse it against, so the record goes too: the
    // server drops what it warmed and nothing is ever carried (scenario 2).
    await fetch("/api/recap/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: state.sessionId === "" ? null : state.sessionId,
        record: state.activeRecord,
      }),
    });
  } catch {
    toast("the dismiss did not reach the server", true);
  }
}

async function rerunRecap(): Promise<void> {
  state.recap = { phase: "running", entry: null, reason: null };
  state.recapStarted = Date.now();
  drawTranscript();
  try {
    await fetch("/api/recap/rerun", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.sessionId, record: state.activeRecord }),
    });
  } catch {
    toast("could not start the recap", true);
  }
}



/** A redraw asked for by the window itself, so two of them cannot queue up. */
let windowFrame = 0;


/** An empty element standing in for the history that is not mounted. */
function spacerRow(which: "above" | "below", px: number): HTMLElement {
  const node = document.createElement("div");
  node.className = `win-space win-${which}`;
  node.dataset["drawKey"] = `win:${which}`;
  // The height IS the signature: a spacer whose height has not changed is reused untouched, and one
  // that has is replaced — which for an empty div costs nothing and keeps the reconcile's one rule.
  // SUB-PIXEL, deliberately. Rounding a spacer to whole pixels leaves the page up to a pixel out of
  // place every time the window moves, and the pins that measure the reader's position measure it to
  // the pixel — a 1px yank is still a yank, and it is the kind that accumulates. The signature is
  // the same string, so a spacer whose height has not really changed is still reused untouched.
  const height = Math.max(0, px).toFixed(2);
  node.dataset["drawSig"] = height;
  node.style.height = `${height}px`;
  // A spacer standing for NOTHING is hidden, not merely zero-tall: `#transcript-body`'s
  // `:nth-last-child(1 of :not([hidden]))` rule decides the resting gap above the composer, and an
  // empty element that still counts as a child would move it (SPEC 182/199).
  if (height === "0.00") node.hidden = true;
  return node;
}


/**
 * Ask whether the window still covers what the reader is looking at, and redraw if it does not.
 *
 * Throttled to one animation frame, and it only redraws when the mounted RANGE would actually
 * change — otherwise a scroll gesture would redraw the transcript sixty times a second to produce
 * the same DOM, and the measured heights feeding the plan would make it a loop that never settles.
 */
function scheduleWindow(): void {
  if (windowFrame !== 0) return;
  windowFrame = requestAnimationFrame(() => {
    windowFrame = 0;
    if (liveWindow === null) return;
    // No layout to read: whatever is on screen, it is not this.
    if (ui.transcript.clientHeight === 0) return;
    // The band is unknown — the last redraw ran with the transcript off screen. Plan it again now
    // that there is something to measure.
    if (mountedBand === null) {
      drawTranscript();
      return;
    }
    // A margin inside the band rather than at its edge, so the redraw happens while there is still
    // mounted content to scroll into and never as a gap the reader can see.
    const margin = Math.min(overscan() / 2, 400);
    const top = ui.transcript.scrollTop;
    const bottom = top + ui.transcript.clientHeight;
    const covered = top - margin >= mountedBand.top && bottom + margin <= mountedBand.bottom;
    if (covered) return;
    drawTranscript();
  });
}

/**
 * Put a turn of the live session on screen even if it is not mounted (SPEC 228).
 *
 * The modelled top is where the window believes the turn is; scrolling there mounts it, and the
 * caller then finds a real element to land on exactly. Returns false when the uuid is not a turn of
 * the live session, which is the case every caller has to handle anyway.
 */
function mountTurn(uuid: string): boolean {
  const spans = liveSpans();
  const index = spans.findIndex((span) => span.key === `turn:${uuid}`);
  if (index < 0) return false;
  const top = turnTops(spans, winBase)[index] ?? 0;
  setStuck(false);
  moveTranscript(Math.max(0, top - 18));
  drawTranscript();
  return true;
}

function drawTranscript(): void {
  // Before ANYTHING is read off `stuck` — the anchor, the window's `atEnd`, the pin at the tail.
  syncStuck();
  const anchor = takeAnchor();
  // Read before anything is rendered, and not read again until the next paint: `renderMessages`
  // consults it to skip unchanged turns and `reconcile` consults it to place them (SPEC 211).
  liveRows = rowIndex(ui.transcript);
  const frag = document.createDocumentFragment();
  let shown = 0;

  const earlier = earlierCars();
  for (const car of earlier) {
    const messages = state.carsOpen[car.id];
    frag.append(seamRow(car, messages !== undefined, false));
    if (messages !== undefined) shown += renderMessages(frag, messages);
  }
  // The seam above the live session is drawn whenever there is anything behind it — that line is
  // what says "you are in the newest car", and without it the last seam would read as the end.
  const here = currentCar();
  if (earlier.length > 0) {
    if (here !== undefined) frag.append(seamRow(here, true, true));
    else if (state.pendingNew) frag.append(pendingSeam());
  }

  // Below the seam and above his FIRST message — which is where "where you left off" means anything.
  // It was prepended to the whole fragment until 2026-08-13, so cutting a seam from inside an open
  // session put it above that car's entire history: measured 5,965px above the top of the viewport
  // on a real project, present in the DOM, `toBeVisible()` green, and unseeable. Every report of
  // "the recap doesn't work" that day was this.
  const carried = recapNode();
  if (carried !== null) frag.append(carried);

  // The queue's echoes are merged into the live session's stream by accept time; only the ones newer
  // than every message on screen come back here, and those genuinely do belong at the end.
  const echoes = undrawnEchoes();
  // The cards belong to the LIVE session, so they are merged into this stream and not into an
  // earlier car's (SPEC 185).
  const permits = pendingPermits();
  // THE WINDOW (SPEC 228). Only the turns the reader can reach are real nodes; the rest of the
  // session is two empty elements of exactly the height it would have taken, so the scroller is as
  // tall as the whole session and nothing below the reader moves when the window does. The slice is
  // cut at turn boundaries, which is what keeps a tool call and its result in the same draw — and
  // the echoes and the permit cards are always newer than every message here, so they fall through
  // to the tail below rather than being placed inside a slice they do not belong to.
  const plan = planLiveWindow(anchor);
  setLiveWindow(plan);
  if (plan === null) {
    shown += renderMessages(frag, state.messages, echoes, state.anchors[pendingKey()] ?? [], permits);
  } else {
    frag.append(spacerRow("above", plan.above));
    shown += renderMessages(
      frag,
      state.messages.slice(plan.from, plan.to),
      echoes,
      state.anchors[pendingKey()] ?? [],
      permits,
    );
    frag.append(spacerRow("below", plan.below));
  }

  // The tail STAYS ATTACHED (SPEC 203) and every row this redraw built goes above it — and now a
  // row that would come out identical is not replaced either (SPEC 211). Both rules are the same
  // rule at two scales: taking a node out of the document destroys something the reader owns. For
  // the composer it is the caret; for a framed prototype it is the whole document, because
  // re-parenting an iframe discards its browsing context and reloads it.
  reconcile(ui.transcript, [...frag.children] as HTMLElement[]);
  if (shown === 0 && earlier.length === 0) {
    const empty = document.createElement("p");
    empty.className = "rail-empty";
    empty.textContent = state.messages.length === 0 ? "no messages yet — say something below" : "nothing to show";
    placeAboveTail(empty);
  }
  // What is left of both lists is newer than every message on screen — a message just sent, and a
  // card asked about the turn in flight before that turn has written anything. The end IS their
  // place in message order, but they still have to go in the order they happened: a card asked
  // before a follow-up was queued belongs above that follow-up, not under it.
  for (;;) {
    const echo = echoes[0];
    const permit = permits[0];
    if (echo === undefined && permit === undefined) break;
    const echoAt = echo === undefined ? Number.POSITIVE_INFINITY : echo.at;
    const cardAt = permit === undefined ? Number.POSITIVE_INFINITY : permitAt(permit);
    if (echoAt <= cardAt) placeAboveTail(echoNode((echoes.shift() as PendingEcho).text));
    else placeAboveTail(permitCard(permits.shift() as Permit));
  }
  // The tail of the scroller, in order (SPEC 199): the working row, the spacer that holds the
  // composer's place, and the composer itself as the last element of the chat. Each is appended
  // only when it is not already here — an append of an attached node is a MOVE, which detaches it
  // first, which is the bug above by another name.
  drawStep();
  // The spacer always belongs here. The COMPOSER only does while the centre is the chat: under a
  // record it hangs off the centre column instead, and a redraw that dragged it back in would put
  // it inside a hidden #chat-area — the box on screen would vanish mid-sentence.
  if (ui.composerAnchor.parentElement !== ui.transcript) ui.transcript.append(ui.composerAnchor);
  if (!ui.composer.classList.contains("under-record") && ui.composer.parentElement !== ui.transcript) {
    ui.transcript.append(ui.composer);
  }
  // BEFORE the anchor is restored: the anchor's drift is measured against the layout this redraw
  // produced, and the spacer heights are part of that layout.
  measureWindow();
  restoreAnchor(anchor);
  resyncDock();
  // Last, because every point's place is read off the layout this redraw just settled (SPEC 192).
  drawGutter();
  // The heights this redraw measured can change the answer the plan gives — most often on the very
  // first paint of a session, where every height was still an estimate. One more frame settles it;
  // `scheduleWindow` redraws only when the mounted range actually differs, so this terminates.
  scheduleWindow();
}

/**
 * A message sent while a turn is running is queued by the session's child and does not reach the
 * transcript until it is answered — so it was invisible, and the only sign it existed was a counter
 * going up (User, 2026-08-06: "i dont see the messages i send in chat if i send them while you're
 * working"). These are drawn from the SERVER's queue (SPEC 138), and disappear the moment the real
 * one arrives.
 */
function echoNode(text: string): HTMLElement {
  const node = document.createElement("article");
  node.className = "msg user pending";
  const head = document.createElement("div");
  head.className = "msg-head";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = "you";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = "queued";
  head.append(who, when);
  const body = document.createElement("div");
  body.className = "body";
  const p = document.createElement("p");
  p.textContent = text;
  body.append(p);
  node.append(head, body);
  return node;
}




async function loadSeen(): Promise<void> {
  let legacySeen: Record<string, number> | undefined;
  let rawSince = 0;
  let hasLegacySeen = false;
  let hasLegacySince = false;

  try {
    const rawSeen = localStorage.getItem("loom-seen");
    rawSince = Number(localStorage.getItem("loom-since") ?? "");
    hasLegacySeen = rawSeen !== null;
    hasLegacySince = Number.isFinite(rawSince) && rawSince > 0;

    if (hasLegacySeen) {
      try {
        const parsed = JSON.parse(rawSeen!);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          legacySeen = parsed as Record<string, number>;
        }
      } catch {
        // corrupted legacy storage ignored
      }
    }

    let data: { watermark?: number; seen?: Record<string, number> } | null = null;

    if (hasLegacySeen || hasLegacySince) {
      const patch: { watermark?: number; seen?: Record<string, number> } = {};
      if (hasLegacySince) patch.watermark = rawSince;
      if (legacySeen !== undefined) patch.seen = legacySeen;

      try {
        const res = await fetch("/api/seen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          data = (await res.json()) as { watermark?: number; seen?: Record<string, number> };
          localStorage.removeItem("loom-seen");
          localStorage.removeItem("loom-since");
        }
      } catch {
        // failed post swallowed
      }
    }

    if (data === null) {
      if (hasLegacySeen || hasLegacySince) {
        // Migration failed. Leave keys in localStorage for next boot, fall back to legacy values
        // in memory so the letters are not all lit.
        state.seen = typeof legacySeen === "object" && legacySeen !== null ? legacySeen : {};
        state.watermark = hasLegacySince ? rawSince : Date.now();
        return;
      }

      const res = await fetch("/api/seen");
      if (!res.ok) throw new Error(`${res.status} /api/seen`);
      data = (await res.json()) as { watermark?: number; seen?: Record<string, number> };
    }

    state.seen = typeof data.seen === "object" && data.seen !== null ? data.seen : {};
    const wm = typeof data.watermark === "number" && Number.isFinite(data.watermark) ? data.watermark : 0;

    if (wm > 0) {
      state.watermark = wm;
    } else {
      // First run anywhere. Without a floor EVERY reply ever written is unread, which lights up
      // the whole tree permanently — the opposite of a signal.
      state.watermark = Date.now();
      void fetch("/api/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watermark: state.watermark }),
      }).catch(() => {
        // failed post swallowed
      });
    }
  } catch {
    // If the fetch fails, fall back to { seen: {}, watermark: Date.now() } in memory only (or legacy
    // values if present), and do not persist a watermark — a server blip must not write a floor that
    // hides real replies.
    state.seen = typeof legacySeen === "object" && legacySeen !== null ? legacySeen : {};
    state.watermark = hasLegacySince ? rawSince : Date.now();
  }
}


/** The newest timestamp currently ON SCREEN — what "I have read up to here" means. */
function newestShown(): number {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const ts = state.messages[i]?.ts;
    if (typeof ts !== "string" || ts.length === 0) continue;
    const at = Date.parse(ts);
    if (!Number.isNaN(at)) return at;
  }
  return 0;
}

/**
 * Mark the open session read — but only while it is actually being LOOKED at. A reply that lands
 * while the reader is on the record tab, or with the tab in the background, is exactly the reply the
 * letter exists to announce.
 */
function markSeen(): void {
  if (state.sessionId.length === 0 || state.centre !== "session") return;
  if (document.visibilityState !== "visible") return;
  const newest = newestShown();
  if (newest <= (state.seen[state.sessionId] ?? 0)) return;
  state.seen[state.sessionId] = newest;
  // Bounded: the 300 most recently read sessions are plenty to remember.
  const entries = Object.entries(state.seen).sort((a, b) => b[1] - a[1]).slice(0, 300);
  state.seen = Object.fromEntries(entries);
  void fetch("/api/seen", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seen: { [state.sessionId]: newest } }),
  }).catch(() => {
    // A failed POST is swallowed.
  });
  drawTree();
  drawOpens();
}

/** Poll the stores the tree is drawing. Bounded by what is on screen, cached server-side by mtime. */
async function loadActivity(): Promise<void> {
  // A record asks by RECORD, not by its escaped directory (SPEC 217). Its sessions have not lived in
  // its own directory since 2026-08-16, so the old key matched nothing and every row's marks came
  // back empty — which is why "new" never cleared and the unread letter never lit. The pool still
  // asks by key: it is a store with no record behind it.
  const keys = new Set<string>();
  if (state.projectKey.length > 0) keys.add(state.projectKey);
  const records = state.records.map((r) => r.path);
  if (keys.size === 0 && records.length === 0) return;
  // POSTED, not asked in the URL — SPEC 233. The rail holds 185 records, which is a 25,804-
  // character query string, and Bun answers that `431 Request Header Fields Too Large` in 1ms. The
  // `catch` below then swallowed it, so this poll has been failing for every record: the unread
  // marks never lit, and `enterRecord` never once had the activity it needs to open a socket in the
  // click's own tick. Found 2026-08-23, while measuring why a click cost a second.
  try {
    const activityPromise = fetch("/api/activity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [...keys], records }),
    });
    const seenPromise = fetch("/api/seen")
      .then(async (r) => (r.ok ? (r.json() as Promise<{ watermark?: number; seen?: Record<string, number> }>) : null))
      .catch(() => null);

    const [response, seenData] = await Promise.all([activityPromise, seenPromise]);
    if (!response.ok) throw new Error(`${String(response.status)} /api/activity`);
    // `answered` rides alongside the per-path map, not nested (SPEC requirement 237) — pulled out
    // before assigning to `state.activity`, or it would be walked below as if it were a session
    // list and answer every OTHER lookup from `undefined`.
    const { answered, ...data } = (await response.json()) as Record<string, SessionActivity[] | string[]> & {
      answered?: string[];
    };
    state.activity = data as Record<string, SessionActivity[]>;
    // A record only counts as answered on a SUCCESSFUL fetch — a failed or not-yet-run one leaves
    // the set exactly as it was, so `recordIsNew` keeps reading the last answer it actually got
    // rather than reverting to "unknown" on every transient failure.
    if (Array.isArray(answered)) state.activityAnswered = new Set(answered);

    if (seenData !== null && typeof seenData === "object") {
      if (typeof seenData.watermark === "number" && seenData.watermark > 0) {
        state.watermark = state.watermark > 0 ? Math.min(state.watermark, seenData.watermark) : seenData.watermark;
      }
      if (typeof seenData.seen === "object" && seenData.seen !== null) {
        for (const [id, ts] of Object.entries(seenData.seen)) {
          if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
            state.seen[id] = Math.max(state.seen[id] ?? 0, ts);
          }
        }
      }
    }
  } catch {
    return; // the marks degrade to absent; nothing else depends on them
  }
  activityById.clear();
  for (const list of Object.values(state.activity)) {
    for (const session of list) activityById.set(session.id, session);
  }
  drawTree();
  drawOpens();
}

/**
 * Which surface the always-on right column shows (SPEC 75–78).
 *
 * The default follows the centre. With the record tab up the work items are already on screen, and
 * the same list twice is a waste of the one column that is always there; with the session up they
 * are nowhere else, which is the whole complaint. An explicit pick overrides and persists — "rarely
 * what he wants while working" is not never.
 */
function drawerMode(): "tasks" | "protos" | "files" {
  if (state.activeRecord === null) return "files";
  if (state.drawerPick !== null) return state.drawerPick;
  return state.centre === "session" ? "tasks" : "files";
}

/** What `/api/prototypes` returns: subtree order, the entered record's group first. */
const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "dropped", "promoted"]);
const DRAWER_PICK_KEY = "loom-drawer";
const DRAWER_DONE_KEY = "loom-drawer-done";
let drawerShowDone = localStorage.getItem(DRAWER_DONE_KEY) === "1";

let drawerSig = "";

/**
 * Redraw only when what the column is showing actually changed.
 *
 * `drawAll` fires on every streamed frame. Redrawing task rows at that rate would tear an OPEN
 * RESULT FORM out from under the hands typing into it — the verdict gate is the one thing in here
 * that must survive a busy session, so the signature is a correctness measure, not a speed one.
 */
function drawDrawer(): void {
  const mode = drawerMode();
  ui.drawerTasks.disabled = state.activeRecord === null;
  ui.drawerTasks.title =
    state.activeRecord === null
      ? "Enter a project to see its work items"
      : "This project's work items — tickable without leaving the session";
  ui.drawerTasks.classList.toggle("on", mode === "tasks");
  ui.drawerProtos.disabled = state.activeRecord === null;
  ui.drawerProtos.classList.toggle("on", mode === "protos");
  ui.drawerFiles.classList.toggle("on", mode === "files");

  const sig =
    mode === "tasks"
      ? JSON.stringify(["t", state.activeRecord, state.recordDoc?.tasks ?? null, drawerShowDone])
      : mode === "protos"
        ? JSON.stringify(["p", state.activeRecord, state.protos])
        : JSON.stringify(["f", state.artifacts]);
  if (sig === drawerSig) return;
  drawerSig = sig;

  if (mode === "tasks") drawDrawerTasks();
  else if (mode === "protos") drawDrawerProtos();
  else drawDrawerFiles();
}

/**
 * The record's OWN task rows, in the right column — the same `renderTasks`, the same handlers, the
 * same confined write. A second renderer here would be a sync problem bought for a column of pixels
 * (project record: "what would make this wrong").
 *
 * The one host-level decision: finished items fold behind a `+ N finished` row, the same shape the
 * tree uses for older records. At 300px a list that is half done is a list you stop reading.
 */
function drawDrawerTasks(): void {
  const path = state.activeRecord;
  const doc = state.recordDoc;
  if (path === null || doc === null) {
    ui.drawerCount.textContent = "0";
    const note = document.createElement("p");
    note.className = "art-empty";
    note.textContent = path === null ? "no project entered" : "reading the record…";
    ui.drawer.replaceChildren(note);
    return;
  }

  const live = doc.tasks.filter((t) => t.status === null || !FINISHED.has(t.status));
  const finished = doc.tasks.filter((t) => t.status !== null && FINISHED.has(t.status));
  ui.drawerCount.textContent = String(live.length);

  const handlers = taskHandlers(path);
  const frag = document.createDocumentFragment();
  // An empty `live` next to five finished items is not "no work items yet", so the component's own
  // empty note is only right when the record really has nothing.
  if (live.length > 0 || finished.length === 0) frag.append(renderTasks(live, handlers));
  else frag.append(Object.assign(document.createElement("p"), {
    className: "art-empty",
    textContent: "every item is finished",
  }));

  if (finished.length > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "drawer-more";
    more.textContent = `${drawerShowDone ? "−" : "+"} ${finished.length} finished`;
    more.addEventListener("click", () => {
      drawerShowDone = !drawerShowDone;
      localStorage.setItem(DRAWER_DONE_KEY, drawerShowDone ? "1" : "0");
      drawDrawer();
    });
    frag.append(more);
    if (drawerShowDone) frag.append(renderTasks(finished, handlers));
  }
  ui.drawer.replaceChildren(frag);
}

function drawDrawerFiles(): void {
  const groups: Array<{ kind: Artifact["kind"]; title: string }> = [
    { kind: "write", title: "written" },
    { kind: "edit", title: "edited" },
    { kind: "read", title: "read" },
  ];
  const frag = document.createDocumentFragment();

  for (const group of groups) {
    const items = state.artifacts.filter((a) => a.kind === group.kind);
    if (items.length === 0) continue;
    const section = document.createElement("div");
    section.className = "art-group";
    const heading = document.createElement("h4");
    heading.textContent = `${group.title} · ${items.length}`;
    section.append(heading);

    for (const artifact of items) {
      const row = document.createElement("div");
      row.className = `art ${artifact.kind}`;
      row.dataset["path"] = artifact.path;
      row.title = artifact.path;
      const name = document.createElement("div");
      name.className = "n";
      name.textContent = artifact.name;
      const detail = document.createElement("div");
      detail.className = "d";
      detail.textContent = `${artifact.ops.join("+")} ×${artifact.count} · ${dirLabel(artifact.path)}`;
      row.append(name, detail);
      section.append(row);
    }
    frag.append(section);
  }

  ui.drawer.replaceChildren(frag);
  ui.drawerCount.textContent = String(state.artifacts.length);
  if (state.artifacts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "art-empty";
    empty.textContent = "no files touched";
    ui.drawer.append(empty);
  }
}

/**
 * The prototypes surface (SPEC 134–137): the entered record's mockups plus its children's,
 * version chains folded under their latest. A row jumps to the message that INTRODUCED the file —
 * the design conversation is the artifact's context — and ↗ opens the file itself in a browser tab.
 */
function drawDrawerProtos(): void {
  const path = state.activeRecord;
  if (path === null) {
    ui.drawerCount.textContent = "0";
    ui.drawer.replaceChildren(
      Object.assign(document.createElement("p"), { className: "art-empty", textContent: "no project entered" }),
    );
    return;
  }
  if (state.protos === null || state.protos.record !== path) {
    ui.drawer.replaceChildren(
      Object.assign(document.createElement("p"), { className: "art-empty", textContent: "looking for prototypes…" }),
    );
    void loadProtos(path);
    return;
  }

  const groups = state.protos.groups;
  ui.drawerCount.textContent = String(groups.reduce((n, g) => n + g.files.length, 0));
  const frag = document.createDocumentFragment();
  for (const group of groups) {
    const section = document.createElement("div");
    section.className = "art-group";
    const heading = document.createElement("h4");
    heading.textContent = group.record === path ? `${group.title} — this record` : group.title;
    section.append(heading);

    for (const chain of groupProtos(group.files)) {
      section.append(protoRow(group.record, chain.latest, { head: true }));
      if (chain.older.length > 0) {
        const fold = document.createElement("div");
        fold.className = "proto-chain";
        for (const version of chain.older) fold.append(protoRow(group.record, version, { head: false }));
        section.append(fold);
      }
    }
    frag.append(section);
  }
  ui.drawer.replaceChildren(frag);
  if (groups.length === 0) {
    ui.drawer.append(
      Object.assign(document.createElement("p"), { className: "art-empty", textContent: "no prototypes yet" }),
    );
  }
}

function protoRow(
  recordPath: string,
  version: ReturnType<typeof groupProtos>[number]["latest"],
  options: { head: boolean },
): HTMLElement {
  const row = document.createElement("div");
  row.className = options.head ? "proto" : "proto proto-old";
  row.title = `${version.name} — jump to where it entered the conversation`;

  const name = document.createElement("span");
  name.className = "n";
  name.textContent = options.head
    ? version.name.replace(/\.html?$/i, "")
    : [`v${version.version}`, version.change].filter((p) => p !== null).join(" · ");
  row.append(name);

  if (options.head && version.version > 1) {
    const badge = document.createElement("span");
    badge.className = "proto-v";
    badge.textContent = `v${version.version}`;
    row.append(badge);
  }
  if (version.date !== null) {
    const date = document.createElement("span");
    date.className = "d";
    date.textContent = version.date.slice(5);
    row.append(date);
  }

  const open = document.createElement("button");
  open.type = "button";
  open.className = "proto-open";
  open.textContent = "↗";
  open.title = "Open the prototype itself in a new browser tab";
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    window.open(`/api/file?path=${encodeURIComponent(version.path)}&raw=1`, "_blank");
  });
  row.append(open);

  row.addEventListener("click", () => void jumpToProto(recordPath, version.name));
  return row;
}

async function loadProtos(path: string): Promise<void> {
  try {
    const groups = await getJson<ProtoGroup[]>(`/api/prototypes?record=${encodeURIComponent(path)}`);
    if (state.activeRecord !== path) return; // he walked on while this was in flight
    state.protos = { record: path, groups };
    drawDrawer();
  } catch {
    state.protos = { record: path, groups: [] };
    drawDrawer();
  }
}

/** Open the conversation where the prototype was introduced: its record, its session, its message. */
async function jumpToProto(recordPath: string, name: string): Promise<void> {
  let where: { key: string; session: string; uuid: string };
  try {
    where = await getJson(`/api/prototypes/where?record=${encodeURIComponent(recordPath)}&name=${encodeURIComponent(name)}`);
  } catch {
    toast("no session embeds this prototype yet", true);
    return;
  }
  if (state.activeRecord !== recordPath) await enterRecord(recordPath);
  if (state.sessionId !== where.session) {
    if (!state.sessions.some((s) => s.id === where.session)) {
      toast("its session is not in this project's store", true);
      return;
    }
    pickSession(where.session);
  }
  await scrollToMessage(where.uuid);
}

/** The transcript arrives over the socket after a pick, so the anchor is awaited, not assumed. */
async function scrollToMessage(uuid: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // WINDOWED (SPEC 228): a turn can be perfectly real and simply not mounted, and polling
    // `getElementById` for it would then time out on a message that is right there in the session.
    // `mountTurn` is a no-op for a uuid this session does not hold, which is the case this loop is
    // actually waiting on — the transcript arriving over the socket after a pick.
    if (document.getElementById(`m-${uuid}`) === null) mountTurn(uuid);
    const anchor = document.getElementById(`m-${uuid}`);
    if (anchor !== null) {
      anchor.scrollIntoView({ block: "center" });
      anchor.classList.remove("jumped");
      void anchor.offsetWidth; // restart the flash when jumping twice to the same message
      anchor.classList.add("jumped");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  toast("could not find the message that introduced it", true);
}

function dirLabel(path: string): string {
  const dir = path.split("/").slice(0, -1).join("/");
  if (state.cwd !== null && dir.startsWith(state.cwd)) {
    const rel = dir.slice(state.cwd.length).replace(/^\//, "");
    return rel.length > 0 ? rel : ".";
  }
  return dir.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function drawAll(): void {
  drawTranscript();
  drawDrawer();
  drawBadge();
}

// ── project tree + centre tabs (SPEC §Records) ──────────────────────


function activeRecordInfo(): RecordInfo | undefined {
  return state.records.find((r) => r.path === state.activeRecord);
}


/**
 * Where the OPEN SESSION's transcript actually lives.
 *
 * Not the same thing as the context, and conflating them is what broke. Until cores, a record's
 * children ran in its directory so its store and its context were one key. Now a session created
 * under a record lives in its CORE's store, while the socket and `/api/transcript` were still
 * asking for the record's — which is empty. User, 2026-08-16, on a session made in the photos
 * project: *"it keeps telling me its disconnected when i open it there, though i can access that
 * session in the 'general' view"*. Right file, wrong store asked for.
 *
 * The session's own `file` is absolute, so it says which store it is in and nothing has to be
 * derived. The context key remains the fallback for a session not in the list yet — a pending new
 * one, which has no transcript to connect to anyway.
 */
function sessionStoreKey(): string {
  // Every step below is written against a value that may be ABSENT at runtime, not just against
  // its type. `store` was added to the activity row on 2026-08-23 and an entry reaching
  // `activityById` without one threw here — inside `connect`, so the socket never opened and the
  // error was only ever a line in the pin harness's log (2026-08-31).
  const open = state.sessions.find((x) => x.id === state.sessionId);
  const file = open?.file;
  const parent = typeof file === "string" ? file.split("/").slice(-2)[0] : undefined;
  if (parent !== undefined && parent.length > 0) return parent;
  // THEN THE ACTIVITY, before the record's own directory (SPEC 234). `enterRecord` opens the
  // socket in the click's own tick from `state.activity` alone, and at that moment `state.sessions`
  // still describes the project being left — so the line above misses and the fallback below names
  // the record's directory, which since cores is not where the session lives. Measured 2026-08-23:
  // that socket never opened and the reader sat through a 1,000ms reconnect backoff before the
  // corrected one did, which is the whole of what the fast path was supposed to save.
  const marked = activityById.get(state.sessionId);
  const store = marked?.store;
  if (typeof store === "string" && store.length > 0) return store;
  return storeKey();
}

/**
 * Where a record's sessions come from.
 *
 * The store key used to be enough, because a record's directory WAS its sessions' cwd. Cores ended
 * that (2026-08-16): many records share one store now, so a record asks by NAME and the server
 * resolves it through the stored links, falling back to the record's own directory for every
 * session it did not spawn — see `server/links.ts`. With no record in context there is nothing to
 * ask by name, so the project picker keeps the store-key route.
 */
function sessionsUrl(): string {
  return state.activeRecord !== null
    ? `/api/records/sessions?record=${encodeURIComponent(state.activeRecord)}`
    : `/api/projects/${state.projectKey}/sessions`;
}

/**
 * URL is the state: the whole OPEN SET, as far as the parameters can carry it (SPEC 201).
 *
 * Not one record and one session any more. Every record member rides as a `record`, every file as a
 * `file`, and the session as `session` — `toParams` decides the shape, and `fromParams` at boot
 * reads it back. What the URL cannot carry is the two kinds interleaved, the titles, or which member
 * was selected, which is why a restored set groups the kinds and lands on the chat.
 */
/**
 * True while a browser Back/Forward is being applied. Every URL write during that is a REPLACE:
 * re-entering a record in order to restore it must not push the place you just came back from.
 */
let restoring = false;

/**
 * Set by a navigation GESTURE, cleared by the first address write that follows it.
 *
 * A gesture — entering a project, going to general, opening a file, picking a session or a core —
 * is one new place; everything it then triggers is the same place being finished. The latch is what
 * tells them apart, and it has to be a latch rather than an argument to `pushUrl` because the write
 * that lands FIRST is not the gesture's own: `enterRecord` redraws the centre before it states the
 * address, `applyCentre` writes the URL, and by the time the gesture's own line ran the address had
 * already been replaced with the destination — so the push found nothing left to say and history
 * gained no entry at all. Back then walked out of loom entirely, to `about:blank`, which is the
 * literal shape of *"going back in browser history often doesnt work"* (driven 2026-08-19).
 */
let gestureOpen = false;

/** Declare the next address write a new place. Called at the TOP of a gesture, before any redraw. */
function beginGesture(): void {
  gestureOpen = true;
  // The previous destination's decorations are answers to a question nobody is asking any more, and
  // on a one-process server they are what the next transcript is queued behind.
  abandonDecorations();
}

/**
 * Write the address: a push for the gesture's first write, a replace for every write derived from it
 * (requirement 222).
 *
 * This used to push from all nine of its call sites, `applyCentre` among them, so one project click
 * left three or four entries and Back walked into the middle of a move rather than out of it.
 * User: *"going back in browser history often doesnt work and leaves me on a broken page with just
 * the input field"* — that broken page is a half-applied state the history had recorded as if it
 * were a place.
 */
function pushUrl(): void {
  const params = withCore(openSetToParams(state.opens, state.sessionId), state.core);
  // `activeRecord` is the CONTEXT — the project the chat is talking to — and it is not a member of
  // the set. It has to stay in the URL even after its own record tab is closed, or a reload would
  // land on a different project's sessions. First, because boot reads the first `record` as the
  // context and the rest as members.
  if (state.activeRecord !== null) {
    const rest = params.getAll("record").filter((path) => path !== state.activeRecord);
    params.delete("record");
    params.append("record", state.activeRecord);
    for (const path of rest) params.append("record", path);
  } else if (state.projectKey.length > 0) {
    params.set("project", state.projectKey);
  }
  // The place rides as its own parameter and only while a file is the thing on screen — glued to
  // the filename it was a 400 on reload, and carried without a file it would be a fragment of an
  // address naming nothing (link kind 6).
  if (state.filePlace !== null && selectedOpen(state.opens).kind === "file") {
    params.set("place", state.filePlace);
  }
  const next = `/?${params.toString()}`;
  // Consumed whether or not the address changed: a gesture that lands where it already was is not a
  // new place, and leaving the latch set would make the NEXT derived write push instead.
  const gesture = gestureOpen && !restoring;
  gestureOpen = false;
  if (location.pathname + location.search === next) return;
  if (gesture) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

/**
 * Put the open set back from the URL (SPEC 201, scenario 4).
 *
 * The records and the files both come back as members; a file is re-opened from its PATH, and its
 * content is read when the centre lands on it — `syncPaneToSelection` is what does that, so a
 * restored file costs nothing until it is looked at. The chat is selected, which is where a deep
 * link has always landed, and `pushUrl` writes the set back so the next reload sees the same URL.
 */
function restoreOpens(params: URLSearchParams): void {
  if (params.getAll("record").length === 0 && params.getAll("file").length === 0) return;
  // The URL cannot carry titles, and the chat's is the one already on screen — keep it rather than
  // letting a rebuilt set rename the chat row back to its default.
  const chatTitle = findOpen(state.opens, CHAT_KEY)?.title;
  state.opens = openSetFromParams(params, (kind, path) =>
    kind === "record" ? (state.records.find((r) => r.path === path)?.title ?? pathTitle(path)) : pathTitle(path),
  );
  if (chatTitle !== undefined) {
    state.opens = addOpen(state.opens, { kind: "session", key: CHAT_KEY, title: chatTitle });
  }
  // A `place` in the address is a statement ABOUT A FILE, so the file is what the address is about
  // (link kind 6, scenario "a link to a place inside a file, reopened"). A rebuilt set otherwise
  // lands on the chat with the file merely open behind it, which puts the place nowhere — and a link
  // to a line is exactly the link User sends himself across devices.
  if (state.filePlace !== null) {
    const file = [...state.opens.members].reverse().find((m) => m.kind === "file");
    if (file !== undefined) state.opens = selectOpen(state.opens, file.key);
  }
  applyCentre();
  pushUrl();
}



/**
 * The panel's view state, per DEVICE and never in the record: a project does not know it is
 * focused. The parent project's own rule — only what cannot be recomputed goes in the file —
 * decides this without a discussion.
 */
let showOlder = localStorage.getItem("loom-tree-all") === "1";
let showFinished = localStorage.getItem("loom-tree-finished") === "1";
let focusPath = localStorage.getItem("loom-tree-focus");

/** Rows whose subprojects are folded away — per-device view state, like focus. */
const COLLAPSED_STORE = "loom-tree-collapsed";
let collapsedRows = new Set<string>();
try {
  collapsedRows = new Set<string>(JSON.parse(localStorage.getItem(COLLAPSED_STORE) ?? "[]") as string[]);
} catch {
  // view state only — garbage in storage means starting expanded, not failing
}

function toggleCollapsed(path: string): void {
  if (collapsedRows.has(path)) collapsedRows.delete(path);
  else collapsedRows.add(path);
  localStorage.setItem(COLLAPSED_STORE, JSON.stringify([...collapsedRows]));
  drawTree();
}

/**
 * The collapse control on a row with subprojects. Collapsed, it stays visible and carries the
 * count — hiding without saying so is the panel's one forbidden move.
 */
function twistButton(path: string, hiddenCount: number): HTMLButtonElement {
  const on = collapsedRows.has(path);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-twist${on ? " on" : ""}`;
  button.dataset["twist"] = path;
  button.textContent = on ? `▸ ${hiddenCount}` : "▾";
  button.title = on ? `${hiddenCount} folded — click to show them` : "fold this project's subprojects";
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", (event) => {
    event.stopPropagation(); // the row underneath ENTERS the project; the twist only folds
    toggleCollapsed(path);
  });
  return button;
}

/**
 * Which records the tree shows. Scanning the vault's `Projects/` returns every record User has
 * ever written, and he called that wrong: "it should have only the recent projects that we
 * specifically added in loom or that we started recently" (2026-08-06). Recency alone did not
 * finish the job — a finished project keeps moving its mtime — so the panel now filters on three
 * axes (SPEC 88–93). The rules live in `panel.ts`, pure, where they can be property-pinned.
 */
function panelView(): PanelView {
  const view = treeView(state.records, {
    now: Date.now(),
    focus: focusPath,
    showOlder,
    showFinished,
    active: state.activeRecord,
    core: state.core,
  });
  // A focus naming a record the scan no longer returns would narrow the panel to nothing and offer
  // no honest way to say why. Drop it — but only once the scan has actually answered.
  if (view.focus === null && focusPath !== null && state.records.length > 0) {
    focusPath = null;
    localStorage.removeItem("loom-tree-focus");
  }
  return view;
}

/** Narrow the panel to one project, or hand it back. View state only — nothing reaches disk. */
function setFocus(path: string | null): void {
  focusPath = path;
  if (path === null) localStorage.removeItem("loom-tree-focus");
  else localStorage.setItem("loom-tree-focus", path);
  drawTree();
}

/**
 * The focus control on a row: a crosshair, invisible until the row is hovered, GOLD and permanently
 * visible once it is the one in force — a narrowed panel that does not say so is a panel lying
 * about what exists.
 */
function focusButton(record: RecordInfo, on: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-focus${on ? " on" : ""}`;
  button.dataset["focus"] = record.path;
  button.title = on ? "showing only this project — click for all of them" : "show only this project";
  button.setAttribute("aria-label", button.title);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  const ring = document.createElementNS(ns, "circle");
  ring.setAttribute("cx", "7");
  ring.setAttribute("cy", "7");
  ring.setAttribute("r", "3.4");
  const ticks = document.createElementNS(ns, "path");
  ticks.setAttribute("d", "M7 0.6V2.4M7 11.6V13.4M0.6 7H2.4M11.6 7H13.4");
  const pupil = document.createElementNS(ns, "circle");
  pupil.setAttribute("class", "pupil");
  pupil.setAttribute("cx", "7");
  pupil.setAttribute("cy", "7");
  pupil.setAttribute("r", "1.3");
  svg.append(ring, ticks, pupil);
  button.append(svg);
  button.addEventListener("click", (event) => {
    event.stopPropagation(); // the row underneath ENTERS the project; the crosshair only filters
    setFocus(on ? null : record.path);
  });
  return button;
}


/**
 * The selector where the panel's title used to be.
 *
 * It reads as a heading and behaves as a choice. A core with no vault is still LISTED — hiding it
 * would say nothing about why Spouse is missing — but it is disabled, because choosing it could only
 * offer an empty tree and a session that cannot be started.
 */
function drawCoreSelect(): void {
  const chosen = state.core;
  ui.coreSelect.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All projects";
  ui.coreSelect.append(all);
  for (const core of state.cores) {
    const option = document.createElement("option");
    option.value = core.id;
    option.textContent = core.usable ? core.label : `${core.label} — no vault yet`;
    option.disabled = !core.usable;
    ui.coreSelect.append(option);
  }
  ui.coreSelect.value = chosen ?? "";
  // The count belongs to `drawTree`, which is the only thing that knows what actually landed.
}

/** Picking a core is a per-TAB act: it moves this address bar and nothing else on the device. */
function pickCore(core: string | null): void {
  if (state.core === core) return;
  beginGesture();
  state.core = core;
  pushUrl();
  drawCoreSelect();
  drawTree();
}


function drawTree(): void {
  // Drawn from here rather than beside every caller: everything that redraws the tree — the activity
  // poll, a core change, a record entered, a rename — is exactly the set of moments this list can go
  // stale, and one call site cannot forget half of them.
  drawActive();
  const children = recordChildren();
  const view = panelView();
  const visible = view.visible;
  // The input about to be detached must not read its own removal as "he clicked away".
  dropTreeInput?.();
  dropTreeInput = null;
  ui.tree.replaceChildren();
  // Set once the title being typed has found its place; anything still false at the end is an input
  // whose anchor row is gone (filtered away, or renamed out from under it), and it is appended
  // rather than dropped — losing typed text is the defect, and a stranded row is not worth it.
  let inputDrawn = false;

  // The way OUT of a project context: the general (repo-wide) session pool.
  const general = document.createElement("div");
  general.className = `tree-item general${state.activeRecord === null ? " current" : ""}`;
  general.dataset["general"] = "1";
  const gdot = treeDot(state.projectKey);
  const glabel = document.createElement("span");
  glabel.className = "tree-label";
  glabel.textContent = "general";
  general.append(gdot, glabel);
  ui.tree.append(general);

  // How many visible records a collapsed row is hiding — the count its twist must show.
  const visibleDescendants = (path: string): number => {
    let n = 0;
    for (const kid of children.get(path) ?? []) {
      if (!visible.has(kid.path)) continue;
      n += 1 + visibleDescendants(kid.path);
    }
    return n;
  };
  // A deep link must never land on a hidden record, so a collapse that would swallow where he is
  // standing simply does not run — same rule the filters follow, one level up.
  const holdsActive = (path: string): boolean =>
    (children.get(path) ?? []).some((kid) => kid.path === state.activeRecord || holdsActive(kid.path));

  const render = (parent: string | null, depth: number): void => {
    for (const record of children.get(parent) ?? []) {
      if (!visible.has(record.path)) continue;
      // A rename in flight stands IN the row's place — same gesture as before, now redraw-proof.
      if (treeInput !== null && treeInput.kind === "rename" && treeInput.record === record.path) {
        ui.tree.append(titleInput(treeInput));
        inputDrawn = true;
        render(record.path, depth + 1);
        continue;
      }
      const folded = collapsedRows.has(record.path) && !holdsActive(record.path);
      const row = document.createElement("div");
      row.className = `tree-item status-${statusClass(record.status)}${state.activeRecord === record.path ? " current" : ""}`;
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.dataset["record"] = record.path;
      const dot = recordDot(record);
      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = record.title;
      label.title = `${record.status} · ${record.path}`;
      // The twist sits LEFT of the dot (User, 2026-08-09: too close to the crosshair on the
      // right). Every row gets the slot so labels line up whether or not there is anything to fold.
      const slot = document.createElement("span");
      slot.className = "tree-twist-slot";
      const kids = visibleDescendants(record.path);
      if (kids > 0) slot.append(twistButton(record.path, folded ? kids : 0));
      row.append(slot, dot, label, focusButton(record, view.focus === record.path));
      // The writes live one deliberate step away (SPEC §Create-and-rename): right-click, or a long
      // press on the phone. The row itself stays pure navigation — a view toggle and a data write
      // must not share a surface (User, 2026-08-09).
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openTreeMenu(event.clientX, event.clientY, record, depth);
      });
      let press: ReturnType<typeof setTimeout> | null = null;
      row.addEventListener(
        "touchstart",
        (event) => {
          const touch = event.touches[0];
          if (touch === undefined) return;
          const { clientX, clientY } = touch;
          press = setTimeout(() => openTreeMenu(clientX, clientY, record, depth), 450);
        },
        { passive: true },
      );
      for (const type of ["touchend", "touchmove", "touchcancel"]) {
        row.addEventListener(type, () => {
          if (press !== null) clearTimeout(press);
        });
      }
      ui.tree.append(row);
      // A new subproject's title sits directly under its parent, above the children it joins.
      if (treeInput !== null && treeInput.kind === "create" && treeInput.record === record.path) {
        ui.tree.append(titleInput(treeInput));
        inputDrawn = true;
      }
      if (!folded) render(record.path, depth + 1);
    }
  };
  // Hiding without saying so is the same defect as showing everything, one step quieter — so every
  // filter that took something away owns a row that names the count and hands it back. The rows sit
  // ABOVE the list (User, 2026-08-09): what shaped the view is read before the view, not found
  // after scrolling past it.
  // WHICH project is focused is already said by the gold crosshair on its own row, so this row owes
  // only the count and the way out — and it leads with the count, because a title long enough to be
  // ellipsized would otherwise swallow the one number worth reading.
  if (view.focus !== null) {
    const label = view.hiddenUnfocused > 0 ? `+ ${view.hiddenUnfocused} outside the focus` : "clear the focus";
    ui.tree.append(treeFoot("focused", label, () => setFocus(null)));
  }
  if (view.hiddenFinished > 0 || showFinished) {
    ui.tree.append(
      treeFoot("finished", showFinished ? "fold the finished ones" : `+ ${view.hiddenFinished} finished`, () => {
        showFinished = !showFinished;
        localStorage.setItem("loom-tree-finished", showFinished ? "1" : "0");
        drawTree();
      }),
    );
  }
  // Suppressed while focused: recency is not running, so a count from it would be a fiction.
  if (view.focus === null && (view.hiddenOlder > 0 || showOlder)) {
    ui.tree.append(
      treeFoot("older", showOlder ? "show only recent" : `+ ${view.hiddenOlder} older`, () => {
        showOlder = !showOlder;
        localStorage.setItem("loom-tree-all", showOlder ? "1" : "0");
        drawTree();
      }),
    );
  }
  render(null, 0);

  if (view.focus !== null) {
    const focused = state.records.find((r) => r.path === view.focus);
    if (focused !== undefined && focused.references.length > 0) {
      const dir = dirOfRecord(focused.path);
      for (const ref of focused.references) {
        const refPath = dir !== null ? resolvePathClient(dir, ref.path) : ref.path;
        const target = state.records.find((r) => r.path === refPath);

        const row = document.createElement("div");
        row.className = `tree-item reference${target === undefined ? " status-missing" : ""}`;
        row.dataset["record"] = refPath;

        const label = document.createElement("span");
        label.className = "tree-label";
        const title = target !== undefined ? target.title : ref.path;
        label.textContent = `→ ${title}${ref.why !== null ? ` — ${ref.why}` : ""}`;

        if (target !== undefined) {
          row.addEventListener("click", () => {
            void enterRecord(target.path);
          });
        }
        row.append(label);
        ui.tree.append(row);
      }
    }
  }
  // The one create affordance that owns pixels: a quiet row at the bottom. It creates a ROOT
  // record (vault Projects/), so it sits outside every row rather than on one.
  const create = document.createElement("button");
  create.type = "button";
  create.className = "tree-more create";
  create.textContent = "+ new project";
  create.addEventListener("click", (event) => {
    event.stopPropagation();
    openCreateInput(null, 0);
  });
  ui.tree.append(create);
  if (state.records.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "no project records";
    ui.tree.append(empty);
  }
  if (treeInput !== null && !inputDrawn) ui.tree.append(titleInput(treeInput));

  // Focus LAST, over the finished tree: the node was only just built, so without this the caret is
  // on `document.body` and the next keystroke goes nowhere.
  const live = ui.tree.querySelector<HTMLInputElement>(".tree-input input");
  if (treeInput !== null && live !== null) {
    live.focus();
    live.setSelectionRange(treeInput.sel[0], treeInput.sel[1]);
  }
  // The count is drawn HERE, off the rows that actually landed, because two attempts to compute it
  // beside the selector both disagreed with the tree — first by filtering records (6 against 7,
  // ancestors come back unconditionally), then by reading the view (6 against 5, not every visible
  // record becomes a row). One traversal, one number, and it cannot drift from what he can see.
  ui.coreCount.textContent = String(ui.tree.querySelectorAll(".tree-item").length);
}

// ── hand creation and rename (SPEC §Create-and-rename) ─────────────────────────────────────────

let treeMenu: HTMLDivElement | null = null;
function closeTreeMenu(): void {
  treeMenu?.remove();
  treeMenu = null;
}
document.addEventListener("click", closeTreeMenu);

/** The row's context menu: the writes (+ subproject, rename) above, the utilities below. */
function openTreeMenu(x: number, y: number, record: RecordInfo, depth: number): void {
  closeTreeMenu();
  const menu = document.createElement("div");
  menu.className = "tree-menu";
  const entry = (text: string, act: () => void): void => {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = text;
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTreeMenu();
      act();
    });
    menu.append(item);
  };
  entry("+ subproject", () => openCreateInput(record.path, depth + 1));
  entry("rename", () => openRenameInput(record, depth));
  const sep = document.createElement("div");
  sep.className = "sep";
  menu.append(sep);
  entry("copy link", () => copyRecordLink(record.path));
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  treeMenu = menu;
}

/**
 * The title being typed in the tree, held as STATE rather than as DOM (SPEC 146).
 *
 * The input used to be a node appended beside the tree, and the tree is a full redraw — so the
 * records poll (4s), the activity poll (15s) and every mark that moved while another session worked
 * simply deleted what was being typed. User, 2026-08-10: *"i start entering the title of the new
 * subproject — the input disapears and i have to start anew if there was some other session doing
 * some work."*
 *
 * Suppressing the redraw would have been the smaller change and the wrong one: the poll exists
 * because a record written elsewhere must appear without a reload. So the input became part of what
 * the tree DRAWS — every redraw rebuilds it from here, text, place and caret intact, and the row
 * the other session just created appears in the same frame.
 */
interface TreeInput {
  kind: "create" | "rename";
  /** create: the parent record, null for a root. rename: the record being renamed. */
  record: string | null;
  /** rename: the title held when the input opened — the `expect` the save is checked against. */
  initial: string;
  depth: number;
  value: string;
  /** Selection, so a redraw mid-word puts the caret back where the fingers left it. */
  sel: [number, number];
}
let treeInput: TreeInput | null = null;
/**
 * Neutralises the LIVE input's handlers before a redraw detaches it. Removing a focused element
 * fires `blur`, and a create's blur cancels — without this the fix would delete the record instead
 * of the input.
 */
let dropTreeInput: (() => void) | null = null;

function closeTreeInput(): void {
  dropTreeInput?.();
  dropTreeInput = null;
  treeInput = null;
}

/** One inline title input in the tree. Enter commits; Esc cancels; blur commits only on a rename. */
function titleInput(state: TreeInput): HTMLDivElement {
  const holder = document.createElement("div");
  holder.className = "tree-input";
  holder.style.paddingLeft = `${10 + state.depth * 14}px`;
  const input = document.createElement("input");
  input.type = "text";
  if (state.kind === "create") input.placeholder = state.record === null ? "new project title" : "subproject title";
  input.value = state.value;
  holder.append(input);

  let settled = false;
  dropTreeInput = (): void => {
    settled = true; // a redraw is not an answer
  };
  const done = (value: string | null): void => {
    if (settled) return;
    const title = value?.trim() ?? "";
    closeTreeInput();
    if (title.length === 0 || title === state.initial) drawTree();
    else if (state.kind === "create") void submitCreate(title, state.record);
    else if (state.record !== null) void submitRename(state.record, title, state.initial);
  };
  const track = (): void => {
    state.value = input.value;
    state.sel = [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length];
  };
  input.addEventListener("input", track);
  input.addEventListener("select", track);
  input.addEventListener("keyup", track);
  input.addEventListener("click", track);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") done(null);
    if (event.key === "Enter") done(input.value);
  });
  // A rename's blur commits (same latch as task titles); a create's blur cancels — an accidental
  // click away must not mint a record.
  input.addEventListener("blur", () => done(state.kind === "rename" ? input.value : null));
  return holder;
}

function openCreateInput(parent: string | null, depth: number): void {
  closeTreeInput();
  treeInput = { kind: "create", record: parent, initial: "", depth, value: "", sel: [0, 0] };
  drawTree();
}

function openRenameInput(record: RecordInfo, depth: number): void {
  closeTreeInput();
  treeInput = {
    kind: "rename",
    record: record.path,
    initial: record.title,
    depth,
    value: record.title,
    // Opened selected, so the first keystroke replaces the old title — the ordinary rename gesture.
    sel: [0, record.title.length],
  };
  drawTree();
}

async function submitCreate(title: string, parent: string | null): Promise<void> {
  try {
    const response = await fetch("/api/record/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A top-level record belongs to the core being looked at; a SUBproject belongs beside its
      // parent, so the core is only sent when there is no parent to inherit a home from.
      body: JSON.stringify({ title, parent, ...(parent === null ? { core: state.core } : {}) }),
    });
    const body = (await response.json()) as { child?: string; error?: string };
    if (!response.ok || typeof body.child !== "string") {
      toast(body.error ?? `could not create the project (${response.status})`, true);
      drawTree();
      return;
    }
    await loadRecords();
    await enterRecord(body.child);
    toast("created — write the frame when you enter");
  } catch (error) {
    toast(`could not create the project: ${String(error)}`, true);
    drawTree();
  }
}

async function submitRename(path: string, title: string, expect: string): Promise<void> {
  try {
    const response = await fetch("/api/record/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: path, title, expect }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      toast(body.error ?? `could not rename (${response.status})`, true);
    }
    await loadRecords();
    // Whatever record is on screen gets redrawn — the rename may have rippled into it (the open
    // tab is often the PARENT whose `[>]` line just changed).
    if (state.activeRecord !== null) await showRecord(state.activeRecord);
  } catch (error) {
    toast(`could not rename: ${String(error)}`, true);
    drawTree();
  }
}

/** Click the record tab's title to retype it; Enter saves, Esc restores, blur commits. */
function wireTitleRename(heading: HTMLHeadingElement, path: string): void {
  heading.classList.add("record-title");
  heading.title = "click to rename";
  heading.addEventListener("click", () => {
    const current = heading.textContent ?? "";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "record-title-input";
    input.value = current;
    heading.replaceWith(input);
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      const title = value?.trim() ?? "";
      input.replaceWith(heading);
      if (title.length > 0 && title !== current) void submitRename(path, title, current);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") done(null);
      if (event.key === "Enter") done(input.value);
    });
    input.addEventListener("blur", () => done(input.value));
    input.focus();
    input.select();
  });
}

/** The absolute record path — the form that opens in loom when pasted into a chat. */
function copyRecordLink(path: string): void {
  const fallback = (): void => {
    const scratch = document.createElement("textarea");
    scratch.value = path;
    document.body.append(scratch);
    scratch.select();
    document.execCommand("copy");
    scratch.remove();
    toast("link copied");
  };
  if (navigator.clipboard === undefined) {
    fallback();
    return;
  }
  navigator.clipboard.writeText(path).then(
    () => toast("link copied"),
    () => fallback(),
  );
}



/**
 * Sessions are a PICK, not a panel (SPEC 60): the newest one is where you land, older ones are one
 * dropdown away, and a new session is the last option rather than a button holding rail width.
 *
 * It rides UNDER the chat row of the open list (SPEC 198) — it is that row's parameter, not a
 * fourth kind of open thing. SPEC 60's rule survives the move for the same reason it was written:
 * the ROW switches the centre, the select does not, or a redraw closes the dropdown the click just
 * opened. Here the select is a sibling of the row rather than a child, so a click on it cannot
 * reach the row at all.
 */
function buildModelPicker(): void {
  const select = ui.pickModel;
  select.replaceChildren();

  const groups = new Map<string, { family: "claude" | "google"; specs: ModelSpec[] }>();
  for (const spec of state.models) {
    let grp = groups.get(spec.group);
    if (!grp) {
      grp = { family: spec.family, specs: [] };
      groups.set(spec.group, grp);
    }
    grp.specs.push(spec);
  }

  for (const [groupName, grp] of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = groupName;
    optgroup.dataset.family = grp.family;
    for (const spec of grp.specs) {
      const opt = document.createElement("option");
      opt.value = spec.id;
      opt.textContent = spec.label;
      optgroup.append(opt);
    }
    select.append(optgroup);
  }

  syncModelForSession();
}

function syncModelForSession(): void {
  if (state.models.length === 0) return;

  if (state.pendingNew) {
    // Keep state.activeFamily
  } else if (state.sessionId.length > 0) {
    const cur = state.sessions.find((s) => s.id === state.sessionId);
    if (cur !== undefined) {
      state.activeFamily = cur.family;
    }
  } else if (state.sessions.length > 0) {
    state.activeFamily = state.sessions[0]!.family;
  } else {
    state.activeFamily = "claude";
  }

  const family = state.activeFamily;

  for (const optgroup of ui.pickModel.querySelectorAll("optgroup")) {
    optgroup.disabled = optgroup.dataset.family !== family;
  }

  const cur = state.sessions.find((s) => s.id === state.sessionId);
  if (!state.pendingNew && cur !== undefined && cur.pick !== null) {
    ui.pickModel.value = cur.pick.model;
    ui.pickEffort.value = cur.pick.effort;
  } else {
    const devModel = localStorage.getItem("loom-model") ?? "default";
    const devSpec = state.models.find((m) => m.id === devModel);
    if (devSpec !== undefined && devSpec.family === family) {
      ui.pickModel.value = devModel;
    } else {
      const firstSpec = state.models.find((m) => m.family === family);
      if (firstSpec !== undefined) ui.pickModel.value = firstSpec.id;
      else ui.pickModel.value = "default";
    }
    const devEffort = localStorage.getItem("loom-effort") ?? "default";
    ui.pickEffort.value = devEffort;
  }

  if (ui.pickModel.value === "default") ui.pickModel.removeAttribute("data-picked");
  else ui.pickModel.setAttribute("data-picked", ui.pickModel.value);

  if (ui.pickEffort.value === "default") ui.pickEffort.removeAttribute("data-picked");
  else ui.pickEffort.setAttribute("data-picked", ui.pickEffort.value);
}

/**
 * Two session streams (SPEC google-pro-models): one row per engine family (Claude, Google).
 * Exactly one row is active: the one whose session is on screen.
 */
function sessionStreams(): HTMLElement {
  const container = document.createElement("div");
  container.id = "session-streams";
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "Session streams");

  const claudeSessions = state.sessions.filter((s) => s.family === "claude");
  const googleSessions = state.sessions.filter((s) => s.family === "google");

  const curSession = state.sessions.find((s) => s.id === state.sessionId);
  let activeStream: "claude" | "google" | "none" = "none";
  if (state.centre === "session") {
    if (state.pendingNew) {
      activeStream = state.activeFamily;
    } else if (curSession !== undefined) {
      activeStream = curSession.family;
    } else if (state.sessions.length > 0) {
      activeStream = state.sessions[0]!.family;
    } else {
      activeStream = "none";
    }
  }

  // 1. Claude stream row
  const rowClaude = document.createElement("div");
  rowClaude.className = `stream-row stream-claude${activeStream === "claude" ? " active" : ""}`;
  rowClaude.id = "row-claude";
  rowClaude.dataset.stream = "claude";
  rowClaude.title = "Claude session stream";

  const glyphClaude = document.createElement("span");
  glyphClaude.className = "stream-glyph";
  glyphClaude.textContent = "◆";
  glyphClaude.title = "claude";
  glyphClaude.setAttribute("aria-label", "claude");

  const selectClaude = document.createElement("select");
  selectClaude.className = "stream-select";
  selectClaude.id = "select-claude";
  selectClaude.setAttribute("aria-label", "Claude session picker");

  if (state.pendingNew && state.activeFamily === "claude") {
    const opt = document.createElement("option");
    opt.value = "__pending__";
    opt.textContent = "new session — type to begin";
    selectClaude.append(opt);
  }
  for (const s of claudeSessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = sessionLabel(s);
    selectClaude.append(opt);
  }
  if (claudeSessions.length === 0 && !(state.pendingNew && state.activeFamily === "claude")) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no sessions";
    selectClaude.append(opt);
    selectClaude.disabled = true;
  } else {
    selectClaude.disabled = false;
  }

  if (activeStream === "claude") {
    selectClaude.value = state.pendingNew ? "__pending__" : state.sessionId;
    if (selectClaude.selectedIndex < 0) selectClaude.selectedIndex = 0;
  } else {
    if (claudeSessions.length > 0) selectClaude.value = claudeSessions[0]!.id;
  }

  const addClaude = document.createElement("button");
  addClaude.className = "stream-add";
  addClaude.id = "add-claude";
  addClaude.type = "button";
  addClaude.title = "Start new Claude session in this project";
  addClaude.textContent = "+";

  rowClaude.append(glyphClaude, selectClaude, addClaude);

  // 2. Google stream row
  const rowGoogle = document.createElement("div");
  rowGoogle.className = `stream-row stream-google${activeStream === "google" ? " active" : ""}`;
  rowGoogle.id = "row-google";
  rowGoogle.dataset.stream = "google";
  rowGoogle.title = "Google session stream";

  const glyphGoogle = document.createElement("span");
  glyphGoogle.className = "stream-glyph";
  glyphGoogle.textContent = "✦";
  glyphGoogle.title = "google";
  glyphGoogle.setAttribute("aria-label", "google");

  const selectGoogle = document.createElement("select");
  selectGoogle.className = "stream-select";
  selectGoogle.id = "select-google";
  selectGoogle.setAttribute("aria-label", "Google session picker");

  if (state.pendingNew && state.activeFamily === "google") {
    const opt = document.createElement("option");
    opt.value = "__pending__";
    opt.textContent = "new session — type to begin";
    selectGoogle.append(opt);
  }
  for (const s of googleSessions) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = sessionLabel(s);
    selectGoogle.append(opt);
  }
  if (googleSessions.length === 0 && !(state.pendingNew && state.activeFamily === "google")) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "no sessions";
    selectGoogle.append(opt);
    selectGoogle.disabled = true;
  } else {
    selectGoogle.disabled = false;
  }

  if (activeStream === "google") {
    selectGoogle.value = state.pendingNew ? "__pending__" : state.sessionId;
    if (selectGoogle.selectedIndex < 0) selectGoogle.selectedIndex = 0;
  } else {
    if (googleSessions.length > 0) selectGoogle.value = googleSessions[0]!.id;
  }

  const addGoogle = document.createElement("button");
  addGoogle.className = "stream-add";
  addGoogle.id = "add-google";
  addGoogle.type = "button";
  addGoogle.title = "Start new Google session in this project";
  addGoogle.textContent = "+";

  rowGoogle.append(glyphGoogle, selectGoogle, addGoogle);

  // Event handlers
  selectClaude.addEventListener("change", (e) => {
    e.stopPropagation();
    pickSession(selectClaude.value);
  });
  selectGoogle.addEventListener("change", (e) => {
    e.stopPropagation();
    pickSession(selectGoogle.value);
  });

  addClaude.addEventListener("click", (e) => {
    e.stopPropagation();
    beginNewSession("claude");
  });
  addGoogle.addEventListener("click", (e) => {
    e.stopPropagation();
    beginNewSession("google");
  });

  rowClaude.addEventListener("click", (e) => {
    if (e.target === selectClaude || e.target === addClaude) return;
    if (activeStream !== "claude") {
      if (claudeSessions.length > 0) {
        state.activeFamily = "claude";
        if (state.sessionId === claudeSessions[0]!.id) {
          setCentre("session");
          pushUrl();
        } else {
          pickSession(claudeSessions[0]!.id);
        }
      } else {
        beginNewSession("claude");
      }
    } else {
      setCentre("session");
    }
  });

  rowGoogle.addEventListener("click", (e) => {
    if (e.target === selectGoogle || e.target === addGoogle) return;
    if (activeStream !== "google") {
      if (googleSessions.length > 0) {
        state.activeFamily = "google";
        if (state.sessionId === googleSessions[0]!.id) {
          setCentre("session");
          pushUrl();
        } else {
          pickSession(googleSessions[0]!.id);
        }
      } else {
        beginNewSession("google");
      }
    } else {
      setCentre("session");
    }
  });

  container.append(rowClaude, rowGoogle);
  return container;
}

function pickSession(value: string): void {
  if (value === "__new__") {
    beginNewSession();
    return;
  }
  if (value === "__pending__" || value === "__none__" || value === "") return;
  if (value === state.sessionId) {
    if (state.centre !== "session") {
      setCentre("session");
      pushUrl();
    }
    return;
  }
  beginGesture();
  // What is in the box belongs to the session he is LEAVING (scenario 6).
  keepDraft();
  state.pendingNew = false;
  // The block belongs to the car it was written for. Picking another one must not carry it along —
  // whatever that car should show arrives with its own frame or its own restore, and "where you
  // left off" above a session he left three cars ago is a lie about which seam it describes.
  // Deliberately not in `connect()`: adopting the session a seam just created keeps its block.
  state.recap = null;
  state.recapStarted = null;
  state.sessionId = value;
  const cur = state.sessions.find((s) => s.id === value);
  if (cur !== undefined) state.activeFamily = cur.family;
  switchDraft();
  setCentre("session"); // redraws the list: the signature carries the id that just changed
  syncModelForSession();
  connect();
  pushUrl();
}

/** One glyph per kind, so a row says what it is before it says which one. */
const OPEN_GLYPH: Record<OpenKind, string> = { session: "💬", record: "▤", file: "📄" };

/**
 * Redraw guard: the list is rebuilt from several paths and on every activity poll, and replacing a
 * <select> mid-interaction would close a dropdown under the reader's cursor.
 */
let opensSig = "";

/** A record's title changes on disk; the row that names it must follow, without re-opening it. */
function refreshOpenTitles(): void {
  for (const member of state.opens.members) {
    if (member.kind !== "record") continue;
    const record = state.records.find((r) => r.path === keyId(member.key));
    if (record !== undefined && record.title !== member.title) {
      state.opens = addOpen(state.opens, { ...member, title: record.title });
    }
  }
}

function openRow(member: OpenMember): HTMLElement {
  const row = document.createElement("div");
  row.className = `open-row${state.opens.selected === member.key ? " on" : ""}`;
  row.setAttribute("role", "tab");
  row.tabIndex = 0;
  row.dataset.kind = member.kind;
  row.dataset.key = member.key;

  if (member.kind !== "session") {
    const glyph = document.createElement("span");
    glyph.className = "open-kind";
    glyph.textContent = OPEN_GLYPH[member.kind];
    row.append(glyph);

    const label = document.createElement("span");
    label.className = "open-label";
    label.textContent = member.title;
    label.title = member.title;
    row.append(label);

    const shut = document.createElement("button");
    shut.type = "button";
    shut.className = "open-close";
    shut.textContent = "×";
    shut.title = `Close ${member.title}`;
    shut.setAttribute("aria-label", `Close ${member.title}`);
    shut.addEventListener("click", (event) => {
      event.stopPropagation();
      closeMember(member.key);
    });
    row.append(shut);
  }

  row.addEventListener("click", () => showMember(member));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      showMember(member);
    }
  });
  return row;
}

/** The open list (SPEC 202): one row per member, the chat first, the picker under it. */
function drawOpens(force = false): void {
  switchDraft(); // the session under the box may have changed with the context (scenario 6)
  refreshOpenTitles();
  const sig = JSON.stringify([
    state.opens.members.map((m) => [m.kind, m.key, m.title]),
    state.opens.selected,
    state.sessionId,
    state.pendingNew,
    state.activeFamily,
    state.sessions.map((s) => [s.id, s.mtime, sessionLabel(s), s.family, s.pick?.model]),
  ]);
  if (!force && sig === opensSig) return;
  opensSig = sig;

  const frag = document.createDocumentFragment();
  for (const member of state.opens.members) {
    const row = openRow(member);
    if (member.kind === "session") {
      row.append(sessionStreams());
    }
    frag.append(row);
  }
  ui.opens.replaceChildren(frag);
  syncModelForSession();
}

/** Clicking a row switches the centre — the one job the tab strip had. */
function showMember(member: OpenMember): void {
  if (member.kind === "session") {
    setCentre("session");
    return;
  }
  if (member.kind === "record") {
    const path = keyId(member.key);
    // A record of a project he is not in: entering it is what makes its sessions and its work items
    // the ones on screen, so the row does that rather than showing a record out of its context.
    if (path !== state.activeRecord) {
      void enterRecord(path).then(() => setCentre("record"));
      return;
    }
    setCentre("record");
    return;
  }
  // A file row: show it, and re-read it if the pane is holding a different one (SPEC 189).
  state.opens = selectOpen(state.opens, member.key);
  applyCentre();
}

/**
 * The pane holds ONE file, the set holds many: whenever the centre lands on a file row, the pane
 * has to be showing that file. This is the step a close makes necessary — closing the file on
 * screen selects a NEIGHBOUR, and the neighbour is often another file.
 */
function syncPaneToSelection(): void {
  const member = selectedOpen(state.opens);
  if (member.kind !== "file") return;
  const path = keyId(member.key);
  if (panePath() === path) return;
  // The place comes from the address, which is what makes a link to a LINE survive being reloaded or
  // sent to another device (link kind 6).
  void showFile(paneHandles(), path, ctx(), state.filePlace ?? undefined, state.cwd ?? undefined)
    .catch((error: unknown) => toast(String(error), true));
}

/** Closing a row (SPEC 202). The selection moves to a neighbour, so the centre always shows one. */
/**
 * What the one open row was showing before the current thing displaced it (SPEC 196).
 *
 * One slot, not a stack. With the set holding a single non-chat member, opening a file from a
 * record would otherwise throw the record away and close would land on the chat — and reading a
 * record, opening one of its artifacts and coming back is an ordinary move, pinned since
 * `journey5`. Depth one is enough for that move and is the whole of what it buys: it is not a
 * history, and it is dropped the moment it is spent.
 */
let displaced: OpenMember | null = null;

/** Open ONE thing, remembering what it pushed out so closing it can put that back. */
function openOnlyMember(member: OpenMember): void {
  state.opens = openOnly(rememberDisplaced(state.opens, member), member);
}

/** The same displacement, but the centre stays where it is — the row appears, nothing is shown. */
function addOnlyMember(member: OpenMember): void {
  state.opens = addOnly(rememberDisplaced(state.opens, member), member);
}

function rememberDisplaced(set: OpenSet, member: OpenMember): OpenSet {
  const current = set.members.find((m) => m.kind !== "session");
  if (current !== undefined && current.key !== member.key) displaced = current;
  else if (current === undefined) displaced = null;
  return set;
}

function closeMember(key: string): void {
  const wasFile = findOpen(state.opens, key)?.kind === "file";
  const back = displaced !== null && displaced.key !== key ? displaced : null;
  displaced = null;
  state.opens = closeOpen(state.opens, key);
  // Closing the thing that displaced another puts that one back, rather than dropping to the chat.
  if (back !== null) state.opens = openOnly(state.opens, back);
  // The pane keeps the path it is holding, so a closed file must let go of it or re-opening the
  // same file would be a no-op against a pane that is no longer on screen.
  if (wasFile && panePath() === keyId(key)) closePane(paneHandles());
  applyCentre();
}

/** The path the centre is showing, when what it shows is a record. */
function centreRecord(): string | null {
  const member = selectedOpen(state.opens);
  return member.kind === "record" ? keyId(member.key) : null;
}

/**
 * The DOM follows the selection. One place reads the open set and shows what it names, so a row
 * click, a close and `setCentre` cannot drift apart.
 */
function applyCentre(): void {
  const member = selectedOpen(state.opens);
  const onSession = member.kind === "session";
  const record = centreRecord();
  // A file is content, so it takes the whole centre and the transcript stands down (SPEC 189).
  ui.layout.classList.toggle("file-open", member.kind === "file");
  // The chat AREA hides, not just the transcript: everything that floats over the chat — the pill,
  // the badge — belongs to the chat and has no business floating over a record.
  ui.chatArea.hidden = !onSession;
  // The composer follows the centre instead of being hidden with the chat.
  //
  // 2026-08-06: "reading the record and talking to the project are one activity", so the composer
  // stayed visible under a record. SPEC 199 put it inside the chat's scroller and this function
  // hides that scroller wholesale, so the combination was lost — and User's ruling on 2026-08-12
  // was "no loss". It is the SAME element either way, moved rather than duplicated: one composer,
  // one draft, one session. A second box under the record would be a second draft to lose.
  //
  // Under a record it sits at the foot of the centre column, which is where it lived before this
  // build — a direct child of #transcript, under #record-body. It is not new furniture on the
  // record surface; it is the furniture that was already there.
  const underRecord = record !== null;
  if (underRecord) {
    if (ui.composer.parentElement !== ui.transcriptPane) ui.transcriptPane.append(ui.composer);
  } else if (ui.composer.parentElement !== ui.transcript) {
    // Back into the flow, after the spacer that holds its place — drawTranscript's own order.
    ui.transcript.append(ui.composer);
  }
  ui.composer.classList.toggle("under-record", underRecord);
  ui.composer.hidden = !onSession && !underRecord;
  // The permission cards do NOT follow it, exactly as before the build: a card is a question about
  // a turn in the transcript, and it is answered where it was asked. Nothing to hide here any more —
  // they are inside the transcript, and `ui.chatArea.hidden` above takes them with it.
  ui.recordBody.hidden = record === null;
  if (record !== null) void showRecord(record);
  // The default surface follows the centre, so moving between rows moves the column with it.
  drawDrawer();
  drawOpens();
  // Walking back INTO the session is reading it: the letter must clear without waiting for a frame.
  if (onSession) markSeen();
  // The transcript had no layout while it was standing down, so its window was planned against
  // nothing (SPEC 228). Plan it again the moment it is back on screen, rather than leaving the
  // reader on whatever four turns happened to survive until they scroll.
  if (onSession && !underRecord) drawTranscript();
  syncPaneToSelection();
  // The URL follows the SET, and this is the one place the set is applied — so opening a file,
  // closing a record and walking to general all write it, rather than only the two paths that
  // remembered to call `pushUrl` themselves (SPEC 201). It writes only when the string changes, so
  // a selection move, which the URL cannot carry, adds no history entry.
  pushUrl();
}

function setCentre(centre: "record" | "session"): void {
  if (centre === "session") {
    state.opens = selectOpen(state.opens, CHAT_KEY);
  } else if (state.activeRecord !== null) {
    // Opening is idempotent by key, so re-entering a record shows the row it already has rather
    // than growing a second one (SPEC 201) — and since 196 it displaces the other one instead of
    // joining it, so navigating never leaves a mark behind.
    openOnlyMember({
      kind: "record",
      key: memberKey("record", state.activeRecord),
      title: activeRecordInfo()?.title ?? pathTitle(state.activeRecord),
    });
  }
  applyCentre();
}

/** ENTER a project: its sessions, its record, its URL (workspace v1). */
/**
 * Enter a project. Lands on its live session when it has one, on the record when it does not —
 * User, 2026-08-06: "when moving around projects... if i have an active session in them it would
 * be more useful to open the session instead of opening the project page since im already doing the
 * interactive work in the session." The record is one tab away either way.
 */
/**
 * A task a link asked for, held across the redraw that `enterRecord` triggers. The record tab is
 * rebuilt asynchronously, so the row cannot be focused in the same tick the click happens in.
 */
let wantTask: string | null = null;

/** Scroll the task a link named into view and flash it, once it exists. */
function focusTask(n: string, tries = 20): void {
  const row = document.querySelector<HTMLElement>(`.task[data-task="${CSS.escape(n)}"]`);
  if (row === null) {
    if (tries > 0) setTimeout(() => focusTask(n, tries - 1), 60);
    return;
  }
  row.scrollIntoView({ block: "center" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1600);
}

/** A record's working directory: the folder its `project.md` sits in, which is the cwd the server
 *  gives that record's sessions. Known from the tree alone, before any session exists. */
function dirOfRecord(path: string): string | null {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? null : path.slice(0, cut);
}

function resolvePathClient(dir: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const parts = dir.split("/").filter((p) => p.length > 0);
  for (const part of rel.split("/")) {
    if (part === ".") continue;
    if (part === "..") parts.pop();
    else if (part.length > 0) parts.push(part);
  }
  return "/" + parts.join("/");
}

function enterRecord(path: string): Promise<void> {
  beginGesture();
  const moved = state.activeRecord !== path;
  state.activeRecord = path;
  // Never show the previous project's work items under this one's name, even for a frame.
  if (moved) state.recordDoc = null;
  // Nor the previous train's history: a car opened over there is not a car over here.
  if (moved) {
    state.train = [];
    state.carsOpen = {};
  }
  // Nor the previous project's block (requirement 206). It carries neither a session id nor a
  // record, so this line is the only thing keeping "where you left off" out of a project it says
  // nothing about — he found it above a record created minutes earlier, describing another build.
  //
  // `cwd` moves with it. It is otherwise written ONLY by a session's `full` frame, so a record with
  // no session yet kept the previous project's directory, and every recap call made from this
  // screen — the warm POST, its poll, the restore GET — named the project he had walked out of.
  if (moved) {
    state.recap = null;
    state.recapStarted = null;
    state.cwd = dirOfRecord(path);
    // A record with no session never reaches `connect`'s redraw, so without this the block would
    // stay on screen with nothing behind it.
    drawTranscript();
    // The work items belong to the PROJECT, not to whichever centre it lands on.
    //
    // They used to arrive as a side effect of drawing the record — which every entry did, for the
    // frame User was complaining about. Requirement 221 removed that frame, and with it the only
    // thing that loaded the document: entering a project with a live session left the right column
    // and the record tab holding the previous project's items (`journey8-drawer-tasks` and
    // `journey4-records`, both failing, 2026-08-19). The pane is emptied in the same breath, so a
    // hidden surface never holds another project's text waiting to be revealed.
    ui.recordBody.replaceChildren();
    afterTranscript(() => void loadRecordDoc(path));
  }
  state.pendingNew = false;
  drawTree();

  // Requirement 221: the centre is decided BEFORE any fetch, from what the rail already knows.
  //
  // `/api/activity` has been polling every record's sessions since boot and its answers are cached
  // server-side by (mtime, size), so by the time a row is clickable the answer is normally already
  // here. This is what removes the flash: the old shape rendered the record, waited on a request
  // that re-walked the whole vault, and only then swapped to the session — a fully drawn WRONG
  // destination, not a loading state.
  //
  // The session id is set optimistically too, so the transcript starts arriving in this same tick.
  // `loadSessions` may still correct it below; what it can no longer do is change the KIND of
  // centre, and the kind is what he was watching change.
  // The record is a ROW whichever centre this lands on: entering a project leaves its page one click
  // away, and `setCentre` decides only whether that row is the one SELECTED. Adding it here rather
  // than inside `setCentre("record")` is what survived the flash fix — with the record centre no
  // longer drawn on the way past, a project with a live session had no row for its record at all and
  // the page became unreachable from inside the session (`journey8-drawer-tasks`, 2026-08-19).
  //
  // ADDED, NOT OPENED. `openOnlyMember` selects what it adds, and selecting the record IS drawing the
  // record page — so with the destination not yet known (the rail has no activity for this project
  // yet), the first version of this line put the record on screen until the fetch settled. That is
  // the flash, back again, in the one case the fixture cannot produce: User, 2026-08-20, *"i can
  // still see the project page loading first before the chat when i navigate between projects"*.
  addOnlyMember({
    kind: "record",
    key: memberKey("record", path),
    title: state.records.find((r) => r.path === path)?.title ?? pathTitle(path),
  });

  // ONLY A POSITIVE ANSWER DECIDES THE CENTRE.
  //
  // A newest session is a fact: the rail read it off disk and `loadSessions` can only refine which
  // session, never whether there is one. An EMPTY list is not the same kind of fact — it is what the
  // poll says for a record the scan does not currently know, for a session whose link has not been
  // read yet, and for a store that has just moved, and `/api/records/sessions` routinely finds
  // sessions behind all three. Treating it as "this project has no sessions" drew the record page
  // and then replaced it with the chat a fetch later, which is the flash exactly as reported:
  // User, 2026-08-20, *"i can still see the project page loading first before the chat when i
  // navigate between projects"*.
  //
  // So an empty answer is handled like no answer at all: the centre stays where it is until
  // `loadSessions` settles it. A stale centre for the length of one fetch is honest; a confidently
  // wrong one is the defect, and an empty activity list is not evidence enough to be confident.
  const newest = state.activity[path]?.[0];
  if (newest !== undefined) {
    if (state.sessionId !== newest.id) {
      state.sessionId = newest.id;
      connect();
    }
    setCentre("session");
  }
  pushUrl();
  // Returned, not fired and forgotten: promotion opens a session in the child the moment it lands,
  // and that must not race the load of the sessions it is about to add to.
  return loadSessions().then((settled) => {
    // An ABANDONED load decides nothing. The gesture that aborted it is already loading its own
    // list, and `state.sessions` still describes the project being left — so choosing a centre from
    // it here would put the wrong one on screen for the length of one fetch.
    if (!settled) return;
    // Two-sided, where this used to have only the first half: a record with NO sessions must land on
    // the record, or the centre keeps whatever the previous project left there — which is how the
    // chat could end up on screen with an empty session behind it (requirement 222).
    setCentre(state.sessions.length > 0 ? "session" : "record");
    // Nothing will paint a transcript here, so the record's own document must not keep waiting.
    if (state.sessions.length === 0) payOwed();
    if (wantTask !== null) {
      const n = wantTask;
      wantTask = null;
      setCentre("record"); // the task list lives in the record tab; a link to a task opens it there
      focusTask(n);
    }
  });
}

function enterGeneral(): void {
  beginGesture();
  const moved = state.activeRecord !== null;
  state.activeRecord = null;
  state.recordDoc = null;
  // Leaving a record for the pool is leaving the project the block was written about (206). The
  // pool's directory cannot be read off the tree, so `cwd` goes back to unknown until the next
  // `full` frame brings it — unknown is right, the abandoned project's directory is not.
  if (moved) {
    state.recap = null;
    state.recapStarted = null;
    state.cwd = null;
    drawTranscript();
  }
  state.pendingNew = false;
  drawTree();
  setCentre("session");
  void loadSessions();
  pushUrl();
}

/**
 * The record tab: a facts line from the scan, the prose before the work items, the items themselves
 * as live task rows (SPEC §Tasks), and the prose after them.
 */
async function showRecord(path: string): Promise<void> {
  const record = state.records.find((r) => r.path === path);
  ui.recordBody.replaceChildren();

  const facts = document.createElement("div");
  facts.className = "record-facts";
  if (record !== undefined) {
    const status = document.createElement("span");
    status.className = `record-status status-${statusClass(record.status)}`;
    status.textContent = record.status;
    facts.append(status);
    // The project's own close, next to the status it moves (SPEC 65).
    facts.append(
      renderLifecycle({
        status: record.status,
        onDone: (verdict) => void writeRecordStatus(path, record.status, "done", verdict),
        onReopen: () => void writeRecordStatus(path, record.status, "active"),
      }),
    );
    if (record.created !== null) {
      const created = document.createElement("span");
      created.textContent = `opened ${record.created}`;
      facts.append(created);
    }
    if (record.parent !== null) {
      const parent = state.records.find((r) => r.path === record.parent);
      const up = document.createElement("button");
      up.className = "record-up";
      up.textContent = `↑ ${parent?.title ?? "parent"}`;
      if (parent !== undefined) up.addEventListener("click", () => void enterRecord(parent.path));
      facts.append(up);
    }
    for (const ref of record.references) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.dataset["path"] = ref.path;
      chip.textContent = `→ ${ref.path.split("/").slice(-1)[0] ?? ref.path}`;
      if (ref.why !== null) chip.title = ref.why;
      facts.append(chip);
    }

    const wrap = document.createElement("div");
    wrap.className = "open-sub";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Add reference");
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "+ add reference";
    select.append(opt);

    const used = new Set(record.references.map((r) => resolvePathClient(dirOfRecord(record.path) ?? "", r.path)));
    for (const other of state.records) {
      if (other.path === record.path || used.has(other.path)) continue;
      const opt = document.createElement("option");
      opt.value = other.path;
      opt.textContent = other.title;
      select.append(opt);
    }

    select.addEventListener("change", () => {
      if (select.value === "") return;
      const why = window.prompt("Why is this connected? (optional)") ?? "";
      const expect = record.title;
      void fetch("/api/record/reference", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record: record.path, target: select.value, why, expect }),
      }).then(async (response) => {
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          toast(body.error ?? "could not add reference", true);
        } else {
          toast("reference added");
          await loadRecords();
          await showRecord(record.path);
        }
      });
      select.value = "";
    });
    wrap.append(select);
    facts.append(wrap);
  }
  ui.recordBody.append(facts);

  const body = document.createElement("div");
  body.className = "record-md";
  ui.recordBody.append(body);
  try {
    // The server splits the record for us; the frontmatter is the scanner's food, not the reader's.
    const doc = await getJson<RecordDoc>(`/api/record?path=${encodeURIComponent(path)}`, decoration());
    if (state.activeRecord !== path) return; // he walked to another project while this was in flight
    setRecordDoc(path, doc);
    drawRecordDoc(body, path, doc);
  } catch (error) {
    body.textContent = `could not read the record: ${String(error)}`;
  }
}

/** The doc is state, not a local: the right column draws the same tasks the centre tab does. */
function setRecordDoc(path: string, doc: RecordDoc): void {
  if (state.activeRecord !== path) return;
  state.recordDoc = doc;
  drawDrawer();
}

/**
 * Fetch the entered record's doc for the RIGHT COLUMN's sake, when the centre never asked for it —
 * entering a project with a live session lands on the session (SPEC 113), and the work items must
 * still be there beside it.
 */
async function loadRecordDoc(path: string): Promise<void> {
  try {
    setRecordDoc(path, await getJson<RecordDoc>(`/api/record?path=${encodeURIComponent(path)}`, decoration()));
  } catch {
    // The column degrades to its note; the tree and the transcript owe it nothing.
  }
}

function drawRecordDoc(body: HTMLElement, path: string, doc: RecordDoc): void {
  const dir = recordDir(path);
  body.replaceChildren();
  body.append(renderMarkdown(doc.head, { cwd: dir, records: state.records }));
  // The second door to rename (SPEC §Create-and-rename): the title itself. Same endpoint as the
  // tree menu; the directory name stays.
  const heading = body.querySelector("h1");
  if (heading !== null) wireTitleRename(heading, path);
  // The two operable sections render as rows where they sit in the file; `middle` is whatever the
  // record put between them (Where it stands, Inputs) and the `## Next` heading itself.
  if (doc.hypotheses.length > 0) {
    body.append(
      renderHypotheses(doc.hypotheses, {
        onStanding: (hypothesis, standing) => void writeStanding(path, hypothesis, standing),
      }),
    );
  }
  if (doc.middle.trim().length > 0) body.append(renderMarkdown(doc.middle, { cwd: dir, records: state.records }));
  body.append(renderTasks(doc.tasks, taskHandlers(path)));
  if (doc.tail.trim().length > 0) body.append(renderMarkdown(doc.tail, { cwd: dir, records: state.records }));
}

/**
 * One set of handlers for one component, wherever it is hosted — the centre tab or the right column
 * (SPEC 75). A tick from either place is the same confined POST, and the doc that comes back
 * redraws both, so the two surfaces cannot drift.
 */
function taskHandlers(path: string): TaskHandlers {
  return {
    dir: recordDir(path),
    // The change-object side of a result: what this session actually touched, products first.
    candidates: () =>
      state.artifacts
        .filter((a) => a.kind !== "read")
        .concat(state.artifacts.filter((a) => a.kind === "read"))
        .map((a) => ({ path: a.path, name: a.name, kind: a.kind })),
    onStatus: (task, status) => void writeTask(path, task, { status }),
    onResult: (task, result, artifacts, status) =>
      void writeTask(path, task, { status, result, artifacts }),
    onPromote: (task) => void promoteTask(path, task),
    onOpenSubproject: (child) => openSubproject(child),
    onAdd: (title) => void addTask(path, title),
    onTitle: (task, title) => void writeTask(path, task, { title }),
  };
}

/** Restate a claim's standing (SPEC 73). Same echo rule as a task: the line the reader was shown. */
async function writeStanding(path: string, hypothesis: Hypothesis, standing: Standing): Promise<void> {
  try {
    const response = await fetch("/api/record/hypothesis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: path, n: hypothesis.n, standing, expect: hypothesis.head }),
    });
    const doc = (await response.json()) as RecordDoc & { error?: string };
    if (!response.ok) {
      toast(doc.error ?? `could not write the standing (${response.status})`, true);
      if (response.status === 409) void showRecord(path);
      return;
    }
    setRecordDoc(path, doc);
    const host = ui.recordBody.querySelector<HTMLElement>(".record-md");
    if (host !== null) drawRecordDoc(host, path, doc);
  } catch (error) {
    toast(`could not write the standing: ${String(error)}`, true);
  }
}

/**
 * Add a work item. The echo is the item COUNT the reader saw, not a line — there is no line yet,
 * and appending blind would give a second session's task a twin (SPEC 72).
 */
async function addTask(path: string, title: string): Promise<void> {
  try {
    const response = await fetch("/api/record/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        record: path,
        section: "next",
        title,
        expect: state.recordDoc?.tasks.length ?? null,
      }),
    });
    const doc = (await response.json()) as RecordDoc & { error?: string };
    if (!response.ok) {
      toast(doc.error ?? `could not add the task (${response.status})`, true);
      if (response.status === 409) void showRecord(path);
      return;
    }
    setRecordDoc(path, doc);
    const host = ui.recordBody.querySelector<HTMLElement>(".record-md");
    if (host !== null) drawRecordDoc(host, path, doc);
  } catch (error) {
    toast(`could not add the task: ${String(error)}`, true);
  }
}

/**
 * The project's own status write (SPEC 65). The record is re-scanned rather than patched in place:
 * the frontmatter is what the scan reads, so the chip, the tree colour and the tab all follow from
 * one re-read instead of three hand-updated copies.
 */
async function writeRecordStatus(
  path: string,
  expect: string,
  status: string,
  verdict?: string,
): Promise<void> {
  try {
    const response = await fetch("/api/record/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: path, status, expect, verdict }),
    });
    const body = (await response.json()) as { status?: string; error?: string };
    if (!response.ok) {
      toast(body.error ?? `could not write the status (${response.status})`, true);
      if (response.status === 409) await loadRecords();
      return;
    }
    await loadRecords();
    await showRecord(path);
    toast(status === "done" ? "project marked done" : `project reopened — ${status}`);
  } catch (error) {
    toast(`could not write the status: ${String(error)}`, true);
  }
}

/** Every task write is one structured POST and a redraw from what the server read back. */
async function writeTask(
  path: string,
  task: Task,
  change: { status?: TaskStatus; result?: string; artifacts?: string[]; title?: string },
): Promise<void> {
  try {
    const response = await fetch("/api/record/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: path, n: task.n, expect: task.head, ...change }),
    });
    const doc = (await response.json()) as RecordDoc & { error?: string };
    if (!response.ok) {
      toast(doc.error ?? `could not write the task (${response.status})`, true);
      if (response.status === 409) void showRecord(path);
      return;
    }
    setRecordDoc(path, doc);
    const host = ui.recordBody.querySelector<HTMLElement>(".record-md");
    if (host !== null) drawRecordDoc(host, path, doc);
  } catch (error) {
    toast(`could not write the task: ${String(error)}`, true);
  }
}

/**
 * Promote a task: the child record and its brief are written by the server, then loom ENTERS the
 * new project and opens a fresh composer LOADED with the seed — "dig into it further" means being
 * inside it, not being told it exists.
 *
 * The seed used to send itself. User: *"i dont like how when i turn a task into a subproject you
 * immediately get an automatic prompt and start working trying to guess what to do … usually when i
 * turn a task into a subproject it means that there are more details to be told."* Splitting a task
 * out is exactly the moment he knows something the task's one line never held, so the send is his:
 * the cursor lands under "What I meant by it:" and nothing spawns until he presses it.
 */
async function promoteTask(path: string, task: Task): Promise<void> {
  try {
    const response = await fetch("/api/record/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: path, n: task.n, expect: task.head }),
    });
    const body = (await response.json()) as { child?: string; seed?: string; error?: string };
    if (!response.ok || typeof body.child !== "string") {
      toast(body.error ?? `could not split this task out (${response.status})`, true);
      return;
    }
    await loadRecords();
    await enterRecord(body.child);
    toast(`split out — ${body.child.split("/").slice(-2)[0] ?? "subproject"}; add what you meant, then send`);
    beginNewSession();
    // The seed is a message to the new session, and the composer lives in the chat (SPEC 199), so
    // the centre goes there — a draft written into a box that is not on screen is a lost draft.
    setCentre("session");
    ui.composerText.value = body.seed ?? "";
    // The seed is registered as this session's draft the moment it is written. `switchDraft` would
    // catch it anyway when he walks away — removing this line does not turn journey5 red, measured —
    // so it is here to keep the box and the draft map in step, not because a check depends on it.
    keepDraft();
    fitComposer(); // grow to fit the draft
    ui.composerText.focus();
    ui.composerText.setSelectionRange(ui.composerText.value.length, ui.composerText.value.length);
  } catch (error) {
    toast(`could not split this task out: ${String(error)}`, true);
  }
}

/** A promoted task's door. The child is in the scan, so entering it is the ordinary tree move. */
function openSubproject(child: string): void {
  if (state.records.some((r) => r.path === child)) {
    void enterRecord(child);
    return;
  }
  void loadRecords().then(() => {
    if (state.records.some((r) => r.path === child)) void enterRecord(child);
    else openInPane(child);
  });
}

async function loadRecords(): Promise<void> {
  try {
    state.records = await getJson<RecordInfo[]>("/api/records");
  } catch {
    state.records = []; // the tree degrades to empty; the transcript view owes it nothing
  }
  drawTree();
  drawOpens();
  relabel();
}

/**
 * Re-label every chip on the page against the current record list.
 *
 * A chip is rendered the moment its message arrives, which is routinely BEFORE the record scan that
 * knows the project's title — and a record can also be created or renamed mid-session. Both leave a
 * chip saying "project.md" for a project loom can name, so the label is re-derived here rather than
 * being frozen at render time. `labelChips` reads `data-raw`, so this is idempotent.
 */
function relabel(): void {
  labelChips(document, state.records);
}

/**
 * Keep the tree honest about what is on disk (SPEC 109).
 *
 * Records used to be fetched once at boot and after a split, which was fine while a human with a
 * text editor was the only thing that wrote them. A session writes them now — that is the normal
 * way a project gets framed — so a record could exist for minutes while the tree denied it, and
 * the only cure was a reload. User: *"you said you added the subprojects but they didn't appear
 * until i reloaded the page which is unintuitive."*
 *
 * A re-fetch is cheap (a scan of a few dozen frontmatters) but a redraw is not free while reading,
 * so it only redraws when the shape actually changed — path, title, status or parent. Anything
 * finer would repaint the tree every time an mtime moved.
 */
function recordShape(records: readonly RecordInfo[]): string {
  return records
    .map((r) => `${r.path}|${r.title}|${r.status}|${r.parent ?? ""}`)
    .sort()
    .join("\n");
}

const RECORDS_POLL_MS = 4000;

function watchRecords(): void {
  setInterval(() => {
    void (async () => {
      let fresh: RecordInfo[];
      try {
        fresh = await getJson<RecordInfo[]>("/api/records");
      } catch {
        return; // a transient failure keeps the tree we already have
      }
      // Two different questions of the same scan. The TREE only cares about shape — a mtime bump
      // must not redraw what someone is reading. The right column's work items care about exactly
      // that bump: the session in front of him is what edits this record, and the items beside it
      // have to move when it does.
      const active = state.activeRecord;
      const touched =
        active !== null &&
        (fresh.find((r) => r.path === active)?.mtime ?? 0) !==
          (state.records.find((r) => r.path === active)?.mtime ?? 0);
      const reshaped = recordShape(fresh) !== recordShape(state.records);
      if (!touched && !reshaped) return;
      state.records = fresh;
      if (reshaped) {
        drawTree();
        drawOpens();
        relabel(); // a project renamed or framed mid-session renames its chips too
      }
      // Never while a result is being written: re-fetching would replace the form mid-sentence, and
      // a lost verdict is worse than a stale list.
      if (touched && active !== null && document.querySelector(".task-form") === null) {
        await loadRecordDoc(active);
      }
    })();
  }, RECORDS_POLL_MS);
}


// ── what typing here costs, and what the account itself says (SPEC §Train, §Bar) ────────────────

/**
 * Everything the badge does NOT show at rest, grouped the way the prototype's hover card grouped it
 * (mockups/usage-bar-2026-08-26-v3.html, section 3): the 5-hour window's own detail, the weekly
 * window and its scoped rows, and the prompt cache's detail. Built as one `title` string — the same
 * convention the old two badges used, not a new tooltip surface.
 */
/**
 * The cache clock for the session ON SCREEN, read from its own messages.
 *
 * It used to come only from the record's train car (`currentCar()?.cache`), so the countdown and
 * the context size disappeared whenever the open session was not inside a project record — which
 * is most of the time (User, 2026-08-29: *"where is remaining time of cache"*). Every call now
 * carries `write` and `ttlMs` from `server/transcript.ts`, so the last call in the rendered
 * transcript answers it directly, for any session loom can show.
 */
function cacheFromMessages(): CacheState | null {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if (m === undefined) continue;
    const u = m.usage;
    if (u === undefined || u.ctx === 0) continue;
    const at = Date.parse(m.ts);
    return {
      at: Number.isNaN(at) ? 0 : at,
      context: u.ctx,
      reuse: u.read + u.write > 0 ? u.read / (u.read + u.write) : 0,
      ttlMs: u.ttlMs,
    };
  }
  return null;
}

/**
 * Which session `state.bar` was read for, so `drawBadge` can notice the car changed underneath.
 * Declared ABOVE `drawBadge`, not beside the poll that writes it: module top-level runs in source
 * order and `drawBadge` is called during the first render, so a `let` below it is in its temporal
 * dead zone and the whole badge throws instead of drawing.
 */
let barSession: string | null = null;

/**
 * The one foot badge (SPEC §Bar): a severity-coloured dot, the active pool percent, the
 * prompt-cache countdown, the time to reset, and the 6-budget micro-meter strip, resting on one
 * 11px mono line. Everything else is in the detail panel `buildBudgetsTooltip` builds alongside it.
 */
function drawBadge(): void {
  const inProject = state.activeRecord !== null && !state.pendingNew;
  ui.composerNew.hidden = !inProject;

  const bar = state.bar;
  const budgets = state.budgets;
  const cache = cacheFromMessages() ?? (inProject ? (currentCar()?.cache ?? null) : null);

  if (budgets !== null) {
    const activeBudgetId = currentActiveBudgetId();
    const activeBudget = budgets.budgets[activeBudgetId];
    const isUnavailable = !activeBudget || activeBudget.status === "unavailable";
    const isStale = activeBudget?.status === "stale";
    const isAged = isStale && activeBudget.at !== null && Date.now() - activeBudget.at >= AGED_MS;
    const pct = isUnavailable ? null : (activeBudget.percent ?? 0);

    if (isUnavailable) {
      ui.barDot.hidden = false;
      ui.barDot.style.background = "var(--ink-faint)";
      ui.barPct.hidden = false;
      ui.barPct.textContent = "—";
      ui.barReset.hidden = true;
      ui.barMeter.classList.remove("warm", "hot");
      ui.barMeter.classList.add("stale");
    } else {
      ui.barDot.hidden = false;
      ui.barPct.hidden = false;
      ui.barPct.textContent = percentOfWindow(pct ?? 0);
      const isWarm = !isStale && (activeBudget.severity ? activeBudget.severity === "warning" : (pct ?? 0) >= 75 && (pct ?? 0) < 90);
      const isHot = !isStale && (activeBudget.severity ? activeBudget.severity === "critical" : (pct ?? 0) >= 90);
      ui.barMeter.classList.toggle("warm", isWarm);
      ui.barMeter.classList.toggle("hot", isHot);
      ui.barMeter.classList.toggle("stale", isAged);
      if (isAged) {
        ui.barDot.style.background = "var(--ink-faint)";
      } else if (isWarm) {
        ui.barDot.style.background = "var(--warn)";
      } else if (isHot) {
        ui.barDot.style.background = "var(--error)";
      } else {
        ui.barDot.style.background = activeBudgetId.startsWith("g") ? "var(--gold)" : "var(--accent)";
      }
      if (activeBudget.resetsAt !== null) {
        ui.barReset.hidden = false;
        ui.barReset.textContent = compactDuration(activeBudget.resetsAt - Date.now());
      } else {
        ui.barReset.hidden = true;
      }
    }

    ui.microStrip.hidden = false;
    updateMicroBars(budgets, activeBudgetId);
    drawBarTooltip(buildBudgetsTooltip(budgets, activeBudgetId, cache));
  } else {
    // Fallback to legacy /api/bar quota (when /api/budgets 404s)
    ui.microStrip.hidden = true;
    const quota = bar?.quota ?? null;
    const stale = bar?.stale === true;

    if (quota === null || quota.fiveHour === null) {
      ui.barDot.hidden = true;
      ui.barPct.hidden = true;
      ui.barReset.hidden = true;
      ui.barMeter.classList.remove("warm", "hot");
    } else {
      const fh = quota.fiveHour;
      ui.barDot.hidden = false;
      ui.barPct.hidden = false;
      ui.barPct.textContent = `${String(Math.round(fh.percent))}%`;
      ui.barMeter.classList.toggle("warm", !stale && fh.severity === "warning");
      ui.barMeter.classList.toggle("hot", !stale && fh.severity === "critical");
      if (fh.resetsAt === null) {
        ui.barReset.hidden = true;
      } else {
        ui.barReset.hidden = false;
        ui.barReset.textContent = compactDuration(fh.resetsAt - Date.now());
      }
    }
    ui.barMeter.classList.toggle(
      "stale",
      stale && quota !== null && quota.fiveHour !== null && Date.now() - quota.at >= AGED_MS,
    );
    drawBarTooltip(buildBarTooltip(bar, cache));
  }

  // ── prompt cache countdown ──
  let cacheText = "";
  let cacheClass = "";
  if (cache !== null && cache.ttlMs !== null) {
    const left = cache.at + cache.ttlMs - Date.now();
    if (left <= 0) {
      cacheText = "cache cold";
      cacheClass = "cold";
    } else {
      cacheText = `cache ${compactDuration(left)}`;
      cacheClass = left < 10 * 60_000 ? "cwarn" : "";
    }
  }
  ui.barCache.hidden = cacheText.length === 0;
  ui.barCache.textContent = cacheText;
  ui.barCache.className = cacheClass.length > 0 ? `cache ${cacheClass}` : "cache";

  // ── context size ──
  const ctxText = cache === null ? "" : thousands(cache.context);
  ui.barCtx.hidden = ctxText.length === 0;
  ui.barCtx.textContent = ctxText;
  ui.barSep0.hidden = ui.barPct.hidden || ui.barCtx.hidden;
  ui.barSep.hidden = (ui.barPct.hidden && ui.barCtx.hidden) || ui.barCache.hidden;

  ui.barMeter.hidden = ui.barPct.hidden && ui.barCache.hidden && ui.barCtx.hidden;

  if (barSession !== pendingKey()) void loadBar();
}

/** The train, and the mark that rides on it. Reloaded whenever the set of sessions can have moved. */
async function loadTrain(): Promise<void> {
  if (state.activeRecord === null) {
    state.train = [];
    state.carsOpen = {};
    drawBadge();
    return;
  }
  try {
    const train = await getJson<Train>(
      `/api/train?record=${encodeURIComponent(state.activeRecord)}`,
      decoration(),
    );
    if (train.record !== state.activeRecord) return; // the reader walked on while this was in flight
    state.train = train.cars;
  } catch {
    state.train = []; // a record with no store yet has no train — that is not an error
  }
  drawBadge();
  drawTranscript();
}

/** Stop the turn in flight. Anything queued behind it still runs — this is "stop THIS". */
async function interruptTurn(): Promise<void> {
  if (state.job !== "running" || state.sessionId.length === 0) return;
  ui.composerStop.disabled = true;
  try {
    const response = await fetch("/api/interrupt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: state.sessionId }),
    });
    const body = (await response.json()) as { error?: string };
    toast(response.ok ? "stopped" : (body.error ?? `stop failed (${response.status})`), !response.ok);
  } catch (error) {
    toast(`stop failed: ${String(error)}`, true);
  } finally {
    ui.composerStop.disabled = false;
  }
}


async function sendMessage(): Promise<void> {
  const text = ui.composerText.value.trim();
  if (text.length === 0 && state.attachments.length === 0) return;
  const startingNew = state.pendingNew;
  try {
    const response = await fetch("/api/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(state.activeRecord !== null ? { record: state.activeRecord } : { project: state.projectKey }),
        ...(startingNew ? {} : { session: state.sessionId }),
        text,
        mode: ui.modeCards.checked ? "cards" : "auto",
        model: ui.pickModel.value,
        effort: ui.pickEffort.value,
        browser: ui.useBrowser.checked,
        images: state.attachments,
      }),
    });
    const body = (await response.json()) as {
      error?: string;
      session?: string;
      queued?: number;
      pending?: PendingEcho[];
    };
    if (!response.ok) {
      toast(body.error ?? `send failed (${response.status})`, true);
      return;
    }
    ui.composerText.value = "";
    delete state.drafts[draftOwner];
    fitComposer();
    syncDock(); // the draft is gone, so the bar goes back into the flow before the view moves
    state.attachments = [];
    drawAttachments();
    if (startingNew && typeof body.session === "string") {
      const named = `new:${storeKey()}`;
      state.pendingNewId = body.session;
      renameDraft(named, body.session); // the placeholder key becomes the session's own
    }
    const key = pendingKey();
    // The queue comes back with the answer, carrying the server's own accept time — which is what
    // places the echo. A send that creates a session has no socket yet, so this response is the only
    // frame it will get until adoption attaches one (SPEC 138).
    state.pending[key] = body.pending ?? [{ text, at: Date.now() }];
    rememberAnchors(key, state.pending[key] ?? []);
    drawTranscript();
    scrollToEnd();
    // Carrying the step this client ALREADY knows, never `null`. On a warm child the server's job and
    // step frames arrive over the socket before this POST resolves, so a null here overwrote a live
    // act with the `working` placeholder: the label read `working · thinking · 30 · working`, which
    // is the strobe SPEC 96 exists to prevent. journey11's "the placeholder shows at most once"
    // catches it, and did — on the third repeat, where the child is warm (2026-08-10).
    setJob(
      "running",
      typeof body.queued === "number" ? body.queued : 1,
      state.step,
      state.step === null ? 0 : Date.now() - state.stepAt,
    );
    if (startingNew && typeof body.session === "string") void adoptNewSession(body.session);
  } catch (error) {
    toast(`send failed: ${String(error)}`, true);
  }
}


// ── actions ─────────────────────────────────────────────────────────

/** Hand the path to Obsidian or the file manager — now an explicit choice, not the default. */
async function handOff(path: string): Promise<void> {
  try {
    const result = await (
      await fetch("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      })
    ).json() as { ok: boolean; how: string; target: string; navigate?: boolean; host?: string; error?: string };
    const name = path.split("/").slice(-1)[0] ?? path;
    // A vault note comes back as a URI for THIS browser to navigate, so it opens on the device at
    // the keyboard (requirement 224). An anchor rather than `location.href`: a custom scheme handed
    // to the address bar can leave the page sitting on a failed navigation, and loom must not move.
    if (result.ok && result.navigate === true) {
      const jump = document.createElement("a");
      jump.href = result.target;
      jump.rel = "noopener";
      jump.style.display = "none";
      document.body.append(jump);
      jump.click();
      jump.remove();
      toast(`Obsidian: ${name}`);
    } else if (result.ok) {
      // Everything else ran where the SERVER is, and away from home that is not where he is looking.
      // Naming the machine is the whole fix: a reveal on the box used to read as one on this desk.
      toast(`${result.how} on ${result.host ?? "the server"}: ${name}`);
    } else toast(`could not open: ${result.error ?? "unknown"}`, true);
  } catch (error) {
    toast(`open failed: ${String(error)}`, true);
  }
}

async function togglePin(uuid: string, pinned: boolean): Promise<void> {
  try {
    const pins = await (
      await fetch("/api/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: state.sessionId, uuid, pinned }),
      })
    ).json() as Record<string, Pin>;
    state.pins = pins;
    drawAll();
  } catch (error) {
    toast(`pin failed: ${String(error)}`, true);
  }
}


// ── transport ───────────────────────────────────────────────────────

// A lost socket (laptop sleep, network drop) reconnects by itself — the server sends a fresh
// `full` on every attach, so recovery is just re-attaching. Backoff doubles to a ceiling;
// wake/online events short-circuit the wait.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1_000;
const RECONNECT_MAX = 15_000;

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(true);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

let staleReloadArmed = true;

/**
 * A tab that outlives a server restart goes on running the bundle it was served, which can be days
 * old and predate fixes the server shipped long ago. User's work-Mac tab ran two-day-old JS and
 * kept reporting a chip crash fixed on 2026-08-28 — the reports reached this server's journal from
 * a bundle whose hash it no longer even serves, so the bug looked alive when only the tab was
 * (2026-08-31, item 78). Nothing else tells a long-lived tab that its own code is out of date.
 *
 * Checked on RECONNECT, because a restart is the only thing that changes the bundle and it always
 * drops the socket. A failed fetch means the server is still coming back up — say nothing and let
 * the next backoff tick ask again.
 *
 * A DRAFT IS NEVER THROWN AWAY. An unsent composer means the reader is mid-sentence, so the stale
 * tab says so and waits for him instead of reloading under his hands. `staleReloadArmed` makes the
 * automatic reload once-only, so a server caught mid-rebuild cannot put the tab in a reload loop.
 */
async function reloadIfBundleStale(): Promise<void> {
  if (!staleReloadArmed) return;
  const tag = document.querySelector<HTMLScriptElement>('script[src*="_bun/client/"]');
  if (tag === null) return; // served unbundled — there is no hash to compare
  const mine = new URL(tag.src, location.href).pathname;

  let html: string;
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return;
    html = await res.text();
  } catch {
    return;
  }
  const theirs = /\/_bun\/client\/[A-Za-z0-9._-]+\.js/u.exec(html)?.[0] ?? null;
  if (theirs === null || theirs === mine) return;

  staleReloadArmed = false;
  const draft = document.querySelector<HTMLTextAreaElement>("#composer-text")?.value ?? "";
  if (draft.trim() !== "") {
    setStatus("this page is out of date — reload when you have sent that", "error");
    return;
  }
  setStatus("new version — reloading…");
  location.reload();
}

/** Reconnect now if the session's socket is not open (after sleep/offline). */
function reconnectNow(): void {
  if (state.socket !== null && state.socket.readyState === WebSocket.OPEN) return;
  if (storeKey().length === 0 || state.sessionId.length === 0) return;
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = 1_000;
  connect(true);
}

/**
 * The socket address the CURRENT state wants — one definition, so "am I already on it?" and "open
 * it" can never disagree about which session is meant. Returned as the string `WebSocket.url` gives
 * back, because that is what the test in `connect()` compares against.
 */
function wantedSocketUrl(): string | null {
  if (storeKey().length === 0 || state.sessionId.length === 0) return null;
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("project", sessionStoreKey());
  url.searchParams.set("session", state.sessionId);
  return url.toString();
}

function sameMessages(a: readonly Message[], b: readonly Message[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  return lastA?.uuid === lastB?.uuid && lastA?.ts === lastB?.ts;
}
function connect(rejoin = false): void {
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // ALREADY ON IT. Boot opens the socket from the address before the rail is loaded (SPEC 227), and
  // `applyLocation` then asks for the same session again a few hundred milliseconds later. Without
  // this the second call would close a socket that had already been served its `full` frame and
  // start the whole attach over — the transcript would blink out and be re-parsed, which is slower
  // than never having connected early at all. A rejoin is a deliberate re-attach and skips the test.
  if (!rejoin && state.socket !== null && wantedSocketUrl() === state.socket.url) {
    const live = state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING;
    if (live) return;
  }
  if (!rejoin) reconnectDelay = 1_000;
  state.socket?.close();
  state.socket = null; // a stale socket's close event must not overwrite the status below
  // On a rejoin the view stays up — the same session's `full` frame replaces it wholesale, and
  // blanking here would flash an empty transcript on every recovered sleep.
  if (!rejoin) {
    // A height belongs to a turn and a turn belongs to a session (SPEC 228): carrying the model
    // into a blank view would size the next session's spacers from the previous one's turns.
    turnMeasured.clear();
    turnEstimated.clear();
    setLiveWindow(null);
    setWinBase(0);
    state.messages = [];
    state.artifacts = [];
    // Permits and job state belong to the session being left; the new session's arrive on attach.
    state.permits = [];
    setJob("idle");
    drawAll();
  }
  const wanted = wantedSocketUrl();
  if (wanted === null) return;

  // A REJOIN's own socket already reconciles `state.job` on attach — `server/main.ts`'s WS `open`
  // handler sends a fresh `job` frame built from `runner.running(id)` on every reattach, not only
  // the first connect. This is the DEFENSIVE layer session-truth step 6 adds on top of that: the
  // terminal event a retire now emits (step 5) can fire while the socket is down and so never
  // arrive, and this asks the Runner directly rather than trusting a push that may have been missed
  // — cheap insurance for whatever reconnect path gets here without going through a fresh attach.
  if (rejoin) void reconcileJobFromServer(state.sessionId);
  // A rejoin is the one moment a restart is visible from here, so it is where the tab asks whether
  // the code it is running is still the code being served (item 78).
  if (rejoin) void reloadIfBundleStale();

  const socket = new WebSocket(wanted);
  state.socket = socket;
  setStatus("connecting…");

  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    if (frame.type === "error") {
      setStatus(frame.message, "error");
      return;
    }
    if (frame.type === "recap") {
      // "none" is not a state worth drawing: a first session, or one with nothing said in it, has
      // nothing to carry and should look exactly like a session that was never recapped.
      state.recap = frame.phase === "none" ? null : { phase: frame.phase, entry: frame.entry, reason: frame.reason };
      // A socket that attaches mid-run is handed the run's OWN start time, so the clock does not
      // restart at zero on every reload (requirement 181).
      if (frame.phase === "running") {
        const at = Date.parse(frame.startedAt ?? "");
        state.recapStarted = Number.isFinite(at) ? at : Date.now();
      }
      drawTranscript();
      return;
    }
    if (frame.type === "subagent") {
      state.subagents.set(frame.agentId, frame);
      drawSubagents();
      return;
    }
    if (frame.type === "permits") {
      state.permits = frame.permits;
      // A whole redraw, because the cards are part of the message flow now (SPEC 185) — there is no
      // container to refresh on its own. `drawTranscript` ends in `syncDock`, which decides the
      // badge, so a card that arrives while he is reading history is announced the moment it lands.
      drawTranscript();
      return;
    }
    if (frame.type === "job") {
      // The frame's queue REPLACES this session's bucket — the server owns it (SPEC 138). Every
      // attach sends one, so a reload restores the echoes and an idle attach clears any left over.
      state.pending[pendingKey()] = frame.pending ?? [];
      // The queue is replaced; the accept times it carried are KEPT. They are what places the real
      // row once the echo is gone (SPEC 145), and the server only re-sends them on attach.
      rememberAnchors(pendingKey(), frame.pending ?? []);
      setJob(frame.state === "running" ? "running" : "idle", frame.queued ?? 0, frame.step ?? null, frame.stepMs ?? 0);
      drawTranscript();
      holdEnd();
      // Only a frame that actually reports something toasts: the attach frame of an IDLE session
      // says "nothing is running" with no detail, and announcing that as a finished turn would
      // fire a toast on every reload.
      if (frame.detail !== null) toast(frame.detail, frame.state === "error");
      return;
    }
    const fresh = frame.type === "full";

    if (frame.type === "full") {
      reconnectDelay = 1_000; // attached and served — the link is good again
      const unchanged =
        rejoin &&
        state.cwd === frame.meta.cwd &&
        sameMessages(state.messages, frame.messages) &&
        state.artifacts.length === frame.artifacts.length;

      state.cwd = frame.meta.cwd;
      state.messages = frame.messages;
      state.artifacts = frame.artifacts;
      state.pins = frame.pins;
      state.subagents.clear();
      // The session's whole send history, accept times included — a reload or a second device places
      // every message exactly where the first one did (SPEC 145).
      rememberAnchors(pendingKey(), frame.accepts ?? []);
      setStatus(`${frame.messages.length} msg · live`, "live");
      // Here, and not in `loadSessions`: the record's directory is not known until this frame — the
      // first version asked with `cwd` still null and restored nothing, on every project (found by
      // the spec, 2026-08-13). A reconnect asks again, which is harmless: it is guarded on having
      // no block, so a frame that arrived first always wins.
      void restoreRecap(state.sessionId);

      if (unchanged) {
        // Reconnected after backgrounding/sleep, but messages are identical: skip tearing down DOM
        payOwed();
        markSeen();
        holdEnd();
        return;
      }
    } else if (frame.type === "append") {
      state.messages = [...state.messages, ...frame.messages];
      state.artifacts = frame.artifacts;
      setStatus(`${state.messages.length} msg · live`, "live");
    }
    drawAll();
    // The destination is on screen: everything that was told to wait for it may go now.
    payOwed();
    // Rendered IS read, for the session actually on screen (SPEC 64).
    markSeen();

    // Opening a session lands at its END — the newest turn is what you came for, and a 188-message
    // session opened at the top means scrolling for a full second before seeing anything current.
    // An append only follows if he was already reading the end; otherwise it would yank the page
    // out from under someone reading history. That is `stuck`, decided by his last scroll and not
    // by a measurement taken here — `drawAll()` above has already grown the container, and the old
    // measure-before-redraw dance was only ever a way of asking the same question a frame earlier.
    // A rejoin's `full` is the SAME session coming back after a drop — treat it like an append
    // (hold the end only if he was already there), not like opening a session.
    if (fresh && !rejoin) scrollToEnd();
    else holdEnd();
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return; // replaced on purpose — not a loss
    setStatus("disconnected — reconnecting…", "error");
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (state.socket === socket) setStatus("socket error", "error");
  });
}


async function loadSessions(): Promise<boolean> {
  // ABANDONED WHEN THE READER WALKS ON. This walks the store, and on User's own it takes a second;
  // on a one-process server that second is spent in front of the NEXT project's socket, which is
  // where the click he is waiting on actually goes. Measured 2026-08-23: the previous project's
  // answer landed at 1,012ms and the socket opened at 1,037ms, in that order and for that reason.
  const gesture = decoration();
  try {
    state.sessions = await getJson<SessionInfo[]>(sessionsUrl(), gesture);
  } catch {
    // An abandoned load says nothing about the project that abandoned it — and the gesture that
    // aborted it is already loading its own. Writing an empty list here would blank the rail for
    // the destination rather than for the place being left.
    if (gesture.aborted) return false;
    state.sessions = []; // a record with no sessions yet has no store dir — that is not an error
  }
  if (gesture.aborted) return false;
  // THE ADDRESS WINS, when it names a session this store actually holds (SPEC 201, 227). Landing on
  // the newest was right for a click into a project and wrong for a deep link: `applyLocation` sets
  // the named session immediately afterwards, so the newest one was attached, parsed and shipped in
  // full — 4.3MB on a real session, measured 2026-08-20 — purely to be thrown away a frame later.
  // A switch INTO another project carries an address still naming the session being left, which
  // this store does not hold, so the fallback is what runs there and nothing changes.
  const named = new URLSearchParams(location.search).get("session");
  const first = state.sessions.find((session) => session.id === named) ?? state.sessions[0];
  if (first !== undefined) {
    // `connect` closes the socket and blanks the transcript, so reconnecting to the session already
    // on screen would flash it empty — which is exactly what `enterRecord`'s optimistic connect
    // would have caused, twice per click, had this not checked.
    const already = state.sessionId === first.id && state.socket !== null;
    state.sessionId = first.id;
    state.activeFamily = first.family;
    if (!already) connect();
  } else {
    // Nothing to open: the first message will create the session (SPEC 44).
    state.sessionId = "";
    state.pendingNew = true;
    state.pendingNewId = null;
    state.activeFamily = "claude";
    connect();
    setStatus(state.activeRecord !== null ? "no sessions here yet — type to start one" : "no sessions");
  }
  syncModelForSession();
  drawOpens();
  void loadTrain();
  // The URL is the state, so it must be re-stated once the session IS one. `enterRecord` pushes
  // before this resolves, which left the new record paired with the PREVIOUS project's session id;
  // a reload or a shared link then asked this store for a session living in another one, and the
  // socket came back 404 with a blank transcript behind it. Found by driving a reload mid-flow —
  // no pin had reloaded inside a project before journey8.
  pushUrl();
  return true;
}

/** Start composing a fresh session: nothing exists until the first send creates it. */
function beginNewSession(family?: "claude" | "google"): void {
  const targetFamily = family ?? state.activeFamily ?? "claude";
  state.activeFamily = targetFamily;

  // Keep the car he was JUST reading open above the new seam. He was looking at it a second ago,
  // so collapsing it behind a door he has to click is the opposite of continuity — and the messages
  // are already in hand, so this costs no fetch. `connect()` below blanks `state.messages`, hence
  // the capture first.
  const leaving = state.sessionId;
  if (leaving.length > 0 && state.messages.length > 0 && state.train.some((c) => c.id === leaving)) {
    state.carsOpen[leaving] = state.messages;
  }
  keepDraft(); // the draft stays with the session it was typed for, not with the new blank one
  state.pendingNew = true;
  state.pendingNewId = null; // a fresh composition owns no bucket until the server names its session
  state.sessionId = "";
  connect(); // clears the view and closes the old socket; empty id means no reconnect
  switchDraft(); // an empty box for a session that does not exist yet — or the seed, put back below
  setCentre("session");
  syncModelForSession();
  drawOpens();
  setStatus("new session — type to begin");
  // The new seam sits below every message, and it is the cut he just made — so it has to be the
  // thing on screen. This was a hand-written true-bottom scroll while `scrollToEnd()` still aligned
  // the last MESSAGE instead; now that it goes to the bottom, the workaround is the rule.
  scrollToEnd();
  ui.composerText.focus();
  // Start the recap HERE, not on the first send. It takes about a minute and he types in seconds, so
  // firing it on the send meant his first message — the one that most needs the context — went out
  // without it, and it landed on his second instead. The button creates no session, but it does not
  // need to: the car being left is already known, and he is about to spend that minute typing.
  void warmRecap();
}

/**
 * Ask the server to recap the car just left, keyed by the RECORD rather than by a session that does
 * not exist yet. Whichever session is created next collects it.
 */
async function warmRecap(): Promise<void> {
  // The RECORD, not `state.cwd` (SPEC 217). `cwd` is overwritten by every session's `full` frame
  // with the child's own working directory, and since 2026-08-16 that is the CORE — one directory
  // shared by every project under it. Keyed on it, a seam cut here warmed a recap the next project
  // to send collected: he was handed a tablet-shopping recap in a loom session (2026-08-17).
  const record = state.activeRecord;
  if (record === null) return;
  state.recap = { phase: "running", entry: null, reason: null };
  state.recapStarted = Date.now();
  drawTranscript();
  try {
    await fetch("/api/recap/warm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record, leaving: state.train.at(-1)?.id ?? null }),
    });
  } catch {
    state.recap = null;
    drawTranscript();
    return;
  }
  void followWarm(record);
}

/**
 * Watch a recap that belongs to no session yet.
 *
 * Everything else about the block arrives on the socket, but the socket is attached to a session id
 * and there is none until he sends — so between the button and the first message the screen has no
 * way to hear that the recap landed, and the block sat spinning for anyone who cut a seam and then
 * did not type. It stops the moment a session exists: from there the frames take over.
 */
async function followWarm(record: string): Promise<void> {
  for (let tries = 0; tries < 240; tries += 1) {
    await new Promise((done) => setTimeout(done, 1000));
    // Leaving the RECORD stops the poll. It used to watch `state.cwd`, which a `full` frame rewrites
    // without him going anywhere — so the poll could keep running against a directory he had not
    // left, or stop because a session elsewhere had landed.
    if (state.sessionId !== "" || state.activeRecord !== record) return;
    if (state.recap === null) return; // dismissed
    let seen: { phase?: string; entry?: RecapEntry; reason?: string; at?: string } | null = null;
    try {
      const res = await fetch(`/api/recap/warm?record=${encodeURIComponent(record)}`);
      if (!res.ok) continue;
      seen = (await res.json()) as { phase?: string; entry?: RecapEntry; reason?: string; at?: string };
    } catch {
      continue;
    }
    if (seen.phase === "running") {
      // The server's zero, not this screen's: a tab opened halfway through must not show 0:00.
      const at = Date.parse(seen.at ?? "");
      if (Number.isFinite(at)) state.recapStarted = at;
      continue;
    }
    if (seen.phase === "ready" && seen.entry !== undefined) {
      state.recap = { phase: "ready", entry: seen.entry, reason: null };
    } else if (seen.phase === "failed") {
      state.recap = { phase: "failed", entry: null, reason: seen.reason ?? null };
    } else {
      // "none" — nothing was worth recapping — and "absent", which after a POST means the server
      // restarted. Neither is a failure, and a block that says nothing is worse than no block.
      state.recap = null;
    }
    drawTranscript();
    return;
  }
}

/**
 * The block after loom itself restarted (requirement 180, item 10 of the record).
 *
 * Everything else about the block lives in server memory — the warm recap, and the frame replayed
 * to a socket that attaches late. A RESTART loses both, and the entry is sitting in the ledger the
 * whole time: found in his hands on 2026-08-13, on a block whose text was already on disk.
 *
 * The server decides whether there is one (it knows the train, the refusals and the file); this only
 * asks, and only for a screen that has nothing — a frame that arrives first is newer than the file
 * and must not be overwritten by an answer that was in flight when it landed.
 */
async function restoreRecap(forSession: string): Promise<void> {
  const record = state.activeRecord;
  if (record === null || forSession === "") return;
  if (state.recap !== null) return;
  let seen: { phase?: string; entry?: RecapEntry; from?: string } | null = null;
  try {
    const res = await fetch(
      `/api/recap?record=${encodeURIComponent(record)}&session=${encodeURIComponent(forSession)}`,
      { signal: decoration() },
    );
    if (!res.ok) return;
    seen = (await res.json()) as { phase?: string; entry?: RecapEntry; from?: string };
  } catch {
    return; // no block is the honest answer when the ask itself failed
  }
  if (seen.phase !== "ready" || seen.entry === undefined) return;
  // He may have moved on, or been answered, while this was in flight.
  if (state.sessionId !== forSession || state.recap !== null) return;
  state.recap = { phase: "ready", entry: seen.entry, reason: null, from: "ledger" };
  drawTranscript();
}

/** After the first send, the transcript file appears when the child writes its first row. */
async function adoptNewSession(id: string): Promise<void> {
  // Adoption lands seconds after the send, by which time the reader may have walked into the
  // record tab or another project. It still adopts — the socket and the session list are wanted —
  // but it never YANKS the centre back: the sender may have walked on, and the reader keeps reading.
  const context = state.activeRecord;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      state.sessions = await getJson<SessionInfo[]>(sessionsUrl());
    } catch {
      continue;
    }
    if (state.sessions.some((s) => s.id === id)) {
      if (state.activeRecord !== context) return;
      state.pendingNew = false;
      state.sessionId = id;
      const s = state.sessions.find((x) => x.id === id);
      if (s !== undefined) state.activeFamily = s.family;
      syncModelForSession();
      drawOpens();
      if (state.centre === "session") setCentre("session");
      connect();
      // The car that was just added is behind the seam now: the train has to say so.
      void loadTrain();
      pushUrl();
      return;
    }
  }
  setStatus("the new session never appeared — check the server log", "error");
}

async function boot(): Promise<void> {
  await loadSeen();
  const params = new URLSearchParams(location.search);

  // ── the transcript is asked for FIRST, and everything else beside it (SPEC 227) ──────────────
  //
  // Measured 2026-08-20 on a 228-turn session: the first message reached the screen at 2,784ms, and
  // the socket that carries it did not open until 523ms — behind `/api/projects`, `/api/cores`,
  // `/api/records`, `/api/roots`, `/api/activity`, `/api/build` and the session LIST, each awaited
  // before the next was asked for. Only the last of those is an input to attaching, so only the last
  // of those is waited for: the list says which STORE the session is in, and the store is the half
  // of the socket's address the URL cannot be trusted about (since cores, a session started under a
  // record lives in its core's store while the address names the record's directory).
  //
  // Asking the server to find the session instead was tried and reverted — see the note in
  // `server/main.ts`. A 404 on a stale pair is information; resolving it away shows a reader one
  // session under another's name.
  //
  // Only for the `project` shape of the address. A `record` deep link needs the records themselves
  // to resolve its store, and `applyLocation` still owns that path; the guard in `connect()` is what
  // stops it opening a second socket to the session this one already has.
  const deepProject = params.get("project");
  const deepSession = params.get("session");
  if (deepProject !== null && deepSession !== null && params.get("record") === null) {
    state.projectKey = deepProject;
    void getJson<SessionInfo[]>(`/api/projects/${encodeURIComponent(deepProject)}/sessions`)
      .then((list) => {
        // The normal path may have got here first on a fast machine; it is the authority, not this.
        if (state.socket !== null || state.sessions.length > 0) return;
        // A pair the store does not hold is a STALE address — leave it to `loadSessions`, which
        // knows how to fall back to the newest session. Guessing here is what showed the wrong one.
        if (!list.some((session) => session.id === deepSession)) return;
        state.sessions = list;
        state.sessionId = deepSession;
        const s = list.find((session) => session.id === deepSession);
        if (s !== undefined) state.activeFamily = s.family;
        syncModelForSession();
        connect();
      })
      .catch(() => {
        /* no such store, or the server is not up yet — the ordinary boot below still runs */
      });
  }

  // Fired TOGETHER, awaited where each is first needed. `loadRecords` is the long pole (160ms on the
  // box) and nothing before it depends on it, so starting it here is most of what this buys.
  const projectsPromise = getJson<ProjectInfo[]>("/api/projects");
  const coresPromise = getJson<{ id: string; label: string; usable: boolean }[]>("/api/cores").catch(() => []);
  const recordsPromise = loadRecords();
  const modelsPromise = getJson<{ models: ModelSpec[] }>("/api/models")
    .then((res) => {
      state.models = res.models;
      buildModelPicker();
    })
    .catch(() => {
      state.models = [];
    });

  const projects = await projectsPromise;
  const wanted = params.get("project");
  const first = projects.find((p) => p.key === wanted) ?? projects[0];
  if (first === undefined) {
    setStatus("no sessions found", "error");
    return;
  }
  state.projectKey = first.key;

  state.core = coreFromParams(params);
  // An older server has no cores; the selector then offers only "All projects".
  state.cores = await coresPromise;
  ui.coreSelect.addEventListener("change", () => {
    pickCore(ui.coreSelect.value.length > 0 ? ui.coreSelect.value : null);
  });

  await recordsPromise;
  await modelsPromise;
  // What loom may read and where it runs — both only the server knows, and the file pane needs them
  // the moment a path is refused (link kind 12, requirement 224). Not awaited: a refusal that arrives
  // before this does simply omits the list, and the pane is not worth delaying the boot for.
  void getJson<{ roots: string[]; host: string }>("/api/roots")
    .then((env) => setPaneEnvironment(env))
    .catch(() => {
      /* an older server has no roots route; the refusal degrades to its status line */
    });
  drawCoreSelect();
  drawTree();
  // Started once, here. It used to be started inside `promoteTask`, so the tree only began watching
  // disk after a split — and started a second interval on the next one.
  watchRecords();
  void loadActivity();
  void watchBuild();
  // The marks answer "where is a reply for me", so they must keep answering while loom sits open on
  // a session that is not the one being written to.
  setInterval(() => void loadActivity(), 15_000);
  // The hour runs on its OWN clock, not the poll's: the bar has to keep shortening whether or not
  // anything is fetched, and nothing is (SPEC 258). 20 s is well under the ~4.6 minutes the 13px
  // track takes to lose one pixel over an hour.
  setInterval(tickCacheBars, 20_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Waking from sleep is the one moment every bar on screen is wildly stale — an interval that
    // did not fire for an hour leaves a full bar under a window that is long spent.
    tickCacheBars();
    markSeen();
    void loadActivity();
    // Waking from sleep is the disconnect case that started this project — don't sit out the
    // backoff timer when the eyes are already on the page.
    reconnectNow();
  });
  window.addEventListener("online", () => reconnectNow());

  // The URL is the state: a deep link restores the whole open set, not one record (SPEC 201).
  // The FIRST `record` is the context — the project whose sessions the chat lists — and everything
  // else in the URL is a member `restoreOpens` puts back. Order matters: `enterRecord` opens its own
  // record member and rewrites the URL, so the set is rebuilt from the parameters captured here.
  //
  // `project` is what tells the two apart. `pushUrl` writes it only when there is NO context record
  // — the repo-wide pool — so a URL carrying both a project and records means those records are
  // members he left open, not the project he was in. Without this test, walking to general with two
  // records open and reloading would land back inside the first of them.
  await applyLocation(params);
}

/**
 * Put the screen where an address says it should be — used by boot AND by browser Back.
 *
 * One implementation, because two would drift and the drifting half would be the one nobody drives:
 * every deep-link ordering trap below was paid for once already (see the comments), and a second
 * copy in the popstate handler would have to re-learn each of them.
 */
async function applyLocation(params: URLSearchParams): Promise<void> {
  // Read BEFORE anything applies the set: `restoreOpens` selects the file member, and the pane sync
  // it triggers is what consumes this.
  state.filePlace = params.get("place");
  const record = params.get("project") === null ? params.get("record") : null;
  const session = params.get("session");
  if (record !== null && state.records.some((r) => r.path === record)) {
    // AWAITED. `enterRecord` loads the record's sessions and lands on the newest, writing that id
    // into the URL; unawaited, it did that AFTER the `?session=` below had been applied, so the URL
    // ended up naming a different session than the screen and a reload dropped him into it — out of
    // a 452-message session into a 9-message one (verifier, 2026-08-13).
    await enterRecord(record);
    restoreOpens(params);
    // GUARDED on the store actually holding it, exactly as the third branch below has always been.
    // An address can name a session that lives in ANOTHER store: `enterRecord` states the address
    // before `loadSessions` settles, so a click whose load is abandoned leaves a history entry
    // pairing the new record with the previous project's session id. Restoring that entry used to
    // set the id and open a socket against it, and no transcript can ever arrive — the blank page
    // reached through history rather than through a click.
    if (session !== null && state.sessions.some((s) => s.id === session)) {
      state.sessionId = session;
      const s = state.sessions.find((x) => x.id === session);
      if (s !== undefined) state.activeFamily = s.family;
      syncModelForSession();
      // The session is still CONNECTED — it is the context the composer talks to — but it is not
      // what the address is about when the address names a place inside a file.
      if (state.filePlace === null) setCentre("session");
      connect();
    }
    landOnSomething();
    return;
  }
  // Coming back OUT of a project. Without this the context stays set, so `sessionsUrl` keeps asking
  // the record's store and the tree keeps a row highlighted that the address no longer names —
  // which is a screen that agrees with nothing. `enterGeneral` clears all of it and loads the pool;
  // its own push is a replace while `restoring` is true.
  if (record === null && state.activeRecord !== null) {
    enterGeneral();
    restoreOpens(params);
    return;
  }
  // No record, but a file can still be open over a project — the set survives either way.
  restoreOpens(params);
  await loadSessions();
  if (session !== null && state.sessions.some((s) => s.id === session)) {
    state.sessionId = session;
    const s = state.sessions.find((x) => x.id === session);
    if (s !== undefined) state.activeFamily = s.family;
    syncModelForSession();
    drawOpens();
    connect();
    if (state.filePlace !== null) {
      pushUrl();
      return;
    }
    // And WRITE IT BACK. `restoreOpens` above pushed a URL built from the session loom had picked by
    // default, so honouring the deep link here without re-pushing left the address naming one
    // session while the transcript, the picker and the status line showed another — and a reload
    // then obeyed the address, dropping him out of a 452-message session into a 9-message one
    // (verifier, 2026-08-13).
    pushUrl();
    return;
  }
  landOnSomething();
}

/**
 * The last thing every restored address does: never leave the chat up with nothing behind it.
 *
 * That empty composer over an empty transcript IS the "broken page" (requirement 222), and it is
 * what `restoreOpens` produces on its own — rebuilding the set from an address, it selects the chat,
 * because that is where a deep link has always landed. For a project whose store holds no session
 * that selection is a composer over nothing, and it overrides the two-sided decision `enterRecord`
 * had already taken from the real session list one line earlier.
 *
 * User, 2026-08-29, on a loom link followed into such a project: *"browser going back when moving
 * between links in loom is still not working"*. The tree-row path never showed it because it does
 * not go through `restoreOpens`; every link and every Back press does.
 *
 * The record page is the fallback because it is the only other thing a project always has. In the
 * general pool there is no record to fall back to, so an empty chat there is honest and stays.
 */
function landOnSomething(): void {
  if (state.activeRecord === null) return;
  if (state.sessions.length > 0) return;
  // A file is content and takes the whole centre; an address about a place inside one is not
  // about the record.
  if (state.filePlace !== null) return;
  if (selectedOpen(state.opens).kind !== "session") return;
  setCentre("record");
}

// ── wiring ──────────────────────────────────────────────────────────

function setView(view: "chat" | "document"): void {
  state.view = view;
  ui.layout.classList.toggle("doc", view === "document");
  keepView();
  // A class on the layout re-flows every message in the column without redrawing anything, so the
  // dock decision taken before it is measured against a layout that no longer exists.
  resyncDock();
}

/**
 * Fullscreen (SPEC 194): both side columns leave and the centre column becomes the window.
 *
 * The class on `#layout` IS the state — nothing but the CSS and this function reads it, and a copy
 * in `state` would be a second truth to keep in step for no reader. `keepView` reads it back off
 * the element for the same reason.
 */
function setFullscreen(on: boolean): void {
  ui.layout.classList.toggle("fullscreen", on);
  // Below 900px these same two columns come back as OVERLAYS, and those classes style nothing above
  // it — so one carried into fullscreen would sit there deciding what the overlay does the next time
  // the window is narrowed, which is the state `drawer-reopen` already had to stop setting blind.
  if (on) ui.layout.classList.remove("rail-open", "drawer-open");
  keepView();
  // Same reason as `setView`, and a bigger relayout: the column changes WIDTH here, so the
  // composer's place in the flow moves and the decision about it has to be taken again.
  resyncDock();
  // Every message rewraps at a new width, so every marker point is somewhere else — exactly what the
  // resize handler redraws it for (SPEC 192). Next frame: before the browser has applied the class
  // there is nothing new to measure.
  requestAnimationFrame(() => drawGutter());
}

/**
 * Is this keystroke going into something he is writing in?
 *
 * `f` is a letter. The document listener below already stands down for the composer, but a record is
 * full of fields — a task's title, the add-a-task box, a hypothesis, the tree's search — and a
 * shortcut that reorganises the screen in the middle of a word is a trap, not a shortcut. Both the
 * event's target and the focused element are asked: they are the same element for a keystroke typed
 * into a field, and disagreeing anywhere is a reason to do nothing.
 */
function typingInto(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  return node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT";
}

// ── the view state that survives a reload (revising SPEC 114/187) ───
// The three buttons that used to change this (doc/think/meta) are gone (usage-bar, 2026-08-26 —
// User asked for the row back and said his current view must not change when they go). Nothing
// below reads a button any more; it only reads and writes `loom-view` — the state itself, so
// whatever a device already has keeps driving the render exactly as it did with the buttons.

// A view that resets on reload costs a click every session, which is what made persistence
// load-bearing while there were buttons to press; it still is now there are not, because the state
// itself is what a session opens into.
const VIEW_KEY = "loom-view";

function keepView(): void {
  const kept = {
    doc: state.view === "document",
    thinking: state.showThinking,
    meta: state.showMeta,
    // Read off the element rather than a mirror in `state` — see `setFullscreen`. It joins the other
    // three because 114's argument does not change with the control: a view toggle that resets on
    // reload costs a click every session (SPEC 195).
    full: ui.layout.classList.contains("fullscreen"),
  };
  localStorage.setItem(VIEW_KEY, JSON.stringify(kept));
}

/**
 * Restore the view from the last visit. Runs at wiring time, before `boot()` draws, so the first
 * paint is already the view User left — no flash of the default and no second draw.
 *
 * Reads ONLY — nothing here writes a new value into `doc`/`thinking`/`meta`; the buttons that did
 * are gone, and the point of removing them was that this keeps reading whatever they last wrote
 * (usage-bar, 2026-08-26).
 */
function loadView(): void {
  let kept: { doc?: unknown; thinking?: unknown; meta?: unknown; full?: unknown } = {};
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw !== null) kept = JSON.parse(raw) as typeof kept;
  } catch {
    kept = {}; // corrupted storage means the defaults, never a dead app
  }
  state.showThinking = kept.thinking === true;
  state.showMeta = kept.meta === true;
  // Before `setView`, which writes the key back: `keepView` reads fullscreen off the element, so
  // restoring it second would persist a `false` over what he actually left. No toast on this path —
  // the toast teaches the key at the moment he presses it, and a cold start he set himself last time
  // is not that moment.
  setFullscreen(kept.full === true);
  setView(kept.doc === true ? "document" : "chat"); // rewrites the key it just read, which is fine
}

// On a phone the rail is off-canvas, so this button is the only way to the tree. Picking a project
// closes it again — a drawer that stays open over what you just chose is in the way.
/**
 * Notice when the page is running an older bundle than the server is serving.
 *
 * loom's client is bundled at server start, so a code change needs a restart — and after one, an
 * open page keeps showing the old UI with nothing to say so. Twice on 2026-08-06 that read as "the
 * fix did not work" against a server that was already serving it.
 */
/** Name the bundle on screen, taken from the content hash of the stylesheet it actually loaded. */
function showBundle(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
  const match = /chunk-([a-z0-9]+)\.css/.exec(link?.href ?? "");
  ui.build.textContent = match === null ? "" : match[1]?.slice(0, 5) ?? "";
}

async function watchBuild(): Promise<void> {
  showBundle();
  const read = async (): Promise<string | null> => {
    try {
      return (await getJson<{ build: string }>("/api/build")).build;
    } catch {
      return null; // a dropped connection is the socket's story to tell, not this one's
    }
  };
  const first = await read();
  if (first === null) return;
  setInterval(() => {
    void read().then((now) => {
      if (now !== null && now !== first) ui.updateBar.hidden = false;
    });
  }, 30_000);
}

// Reload past the HTTP cache: a fresh URL can never be answered from it, and the new document
// names the new content-hashed chunks.
ui.updateBar.addEventListener("click", () => {
  const url = new URL(location.href);
  url.searchParams.set("v", Date.now().toString(36));
  location.replace(url.toString());
});

ui.railToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  ui.layout.classList.toggle("rail-open");
});
ui.tree.addEventListener("click", () => ui.layout.classList.remove("rail-open"));
ui.active.addEventListener("click", () => ui.layout.classList.remove("rail-open"));

wireTouchGestures(ui.layout, {
  isNarrow: () => window.matchMedia("(max-width: 900px)").matches,
  openRail: () => ui.layout.classList.add("rail-open"),
  closeRail: () => ui.layout.classList.remove("rail-open"),
  isRailOpen: () => ui.layout.classList.contains("rail-open"),
  openDrawer: () => {
    ui.layout.classList.remove("drawer-collapsed");
    ui.layout.classList.add("drawer-open");
  },
  closeDrawer: () => ui.layout.classList.remove("drawer-open"),
  isDrawerOpen: () => ui.layout.classList.contains("drawer-open"),
});

loadView();

/**
 * Closing the file. It is a member of the open set now (SPEC 189), so the × inside it and the row's
 * own × are the same gesture — a pane closed without its row would leave a row naming nothing.
 *
 * Escape closes the selected non-chat member now (SPEC 187), which for a file up in the centre is
 * this same path.
 */
function closeFileCentre(): void {
  const path = panePath();
  if (path !== null && isOpenMember(state.opens, memberKey("file", path))) {
    closeMember(memberKey("file", path));
    return;
  }
  closePane(paneHandles());
  applyCentre();
}

need<HTMLElement>("file-close").addEventListener("click", () => closeFileCentre());
need<HTMLElement>("file-open").addEventListener("click", () => {
  const path = panePath();
  if (path !== null) void handOff(path);
});
ui.filePath.addEventListener("click", () => {
  const path = panePath();
  if (path === null) return;
  void navigator.clipboard.writeText(path).then(() => toast("path copied"), () => toast("copy failed", true));
});

// Below 900px the column is an overlay rather than a column (SPEC 188), so the same two controls
// carry a second job: `drawer-open` slides it in, and the handle is never hidden down there because
// it is the only way back to the open list, the picker and the foot.
need<HTMLElement>("drawer-collapse").addEventListener("click", () => {
  ui.layout.classList.add("drawer-collapsed");
  ui.layout.classList.remove("drawer-open");
  ui.drawerReopen.hidden = false;
});
ui.drawerReopen.addEventListener("click", () => {
  ui.layout.classList.remove("drawer-collapsed");
  // `drawer-open` is the OVERLAY's state and it styles nothing above 900px, so toggling it at every
  // width leaves the desktop carrying a class from the narrow layout. It then decides what the
  // overlay does the next time the window is narrowed, which is a state he never set down there.
  if (window.matchMedia("(max-width: 900px)").matches) ui.layout.classList.toggle("drawer-open");
  ui.drawerReopen.hidden = true;
});

// The two picks. Clicking the surface already showing releases the pick back to following the
// centre — the same "collapsing must never be a one-way door" rule the drawer already lives by.
for (const [node, pick] of [
  [ui.drawerTasks, "tasks"],
  [ui.drawerProtos, "protos"],
  [ui.drawerFiles, "files"],
] as const) {
  node.addEventListener("click", () => {
    state.drawerPick = state.drawerPick === pick ? null : pick;
    // Picking prototypes re-reads the disk: the session beside this column mints new files.
    if (state.drawerPick === "protos") state.protos = null;
    if (state.drawerPick === null) localStorage.removeItem(DRAWER_PICK_KEY);
    else localStorage.setItem(DRAWER_PICK_KEY, state.drawerPick);
    drawDrawer();
  });
}
{
  const stored = localStorage.getItem(DRAWER_PICK_KEY);
  if (stored === "tasks" || stored === "protos" || stored === "files") state.drawerPick = stored;
}


ui.composerText.addEventListener("input", () => {
  if (!NATIVE_FIT) scheduleFit();
  keepDraft();
  syncDock();
});
// The reader's own scroll is the other half of the rule: the composer's place leaves the viewport
// and comes back as he moves (SPEC 199, 184).
ui.transcript.addEventListener("scroll", () => syncDock(), { passive: true });
window.addEventListener("resize", () => {
  syncDock();
  // A narrower window rewraps every message, so every point is somewhere else (SPEC 192).
  drawGutter();
});

// The way back to the composer he scrolled away from (SPEC 184). It scrolls the composer into view
// and focuses it — the pill only exists while the box is EMPTY, so there is no draft to disturb.
ui.writePill.addEventListener("click", () => {
  ui.composer.scrollIntoView({ block: "end", behavior: "auto" });
  ui.composerText.focus();
  syncDock();
});
// The badge scrolls to the card and does nothing else: answering from a badge is answering without
// reading (SPEC 184).
ui.permitBadge.addEventListener("click", () => {
  const card = firstPermitCard();
  if (card === null) return;
  card.scrollIntoView({ block: "center", behavior: "auto" });
  syncDock();
});

// Installability: service worker registration for offline app shell and fast caching.
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});

// One delegated listener for every chip and drawer row — they are re-created on each redraw.
document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const chip = target.closest<HTMLElement>(".chip");
  if (chip !== null) {
    event.preventDefault();
    const raw = chip.dataset["path"];
    // Cmd/Ctrl-click keeps the old behaviour: hand the path to Obsidian or the file manager.
    if (raw !== undefined) {
      const abs = absolutise(raw);
      // A chip pointing at a project record enters the project, rather than showing its markdown
      // in the file pane — a link to a project should do what clicking its tree row does. A chip
      // carrying a PLACE is never that: `project.md:12` is a line in a document, not the project.
      const place = chip.dataset["place"];
      const record = state.records.find((r) => normalise(r.path) === normalise(abs));
      // `project.md#next 12` is a TASK, not a heading and not the project: enter the record and put
      // that row on screen. User, 2026-08-11: the plan's task links "are all links to project and
      // not to tasks". A place inside a record is only a document place when it is not a task id.
      const task = /^#\s*next\s+(\d+)\s*$/i.exec(place ?? "");
      // `wiki:A note#a heading` names a note by NAME; the server looks it up (link kind 11). There
      // is nothing to absolutise and nothing to hand to Obsidian until it has been resolved.
      if (raw.startsWith("wiki:")) {
        const hash = raw.indexOf("#");
        if (hash < 0) openInPane(raw);
        else openInPane(raw.slice(0, hash), raw.slice(hash));
        return;
      }
      if (event.metaKey || event.ctrlKey) void handOff(abs);
      else if (record !== undefined && task !== null) {
        wantTask = task[1] ?? null;
        void enterRecord(record.path);
      } else if (record !== undefined && place === undefined) {
        // A chip naming the record he is already IN (SPEC 246). `enterRecord` decides the centre
        // from the rail's activity, and for a project with a live session that is the chat already
        // on screen — so the click moved nothing at all and the link read as dead. The tab strip's
        // own row has answered this case since 221 by showing the record page; this is the same
        // answer, and only for this case: a chip naming another record still lands on its chat.
        if (record.path === state.activeRecord) setCentre("record");
        else void enterRecord(record.path);
      }
      // A relative chip travels UNRESOLVED: `absolutise` can only guess the cwd, while the server
      // knows which of the cwd's ancestors actually holds the file (SPEC 143).
      else openInPane(raw.startsWith("/") || raw.startsWith("~") ? abs : raw, place);
    }
    return;
  }

  // The way out of a refusal (link kind 12): the pane offers it, and it leaves loom by design.
  const hand = target.closest<HTMLElement>(".file-handoff");
  if (hand !== null) {
    const path = hand.dataset["path"];
    if (path !== undefined) void handOff(path);
    return;
  }

  // A link to LOOM walks in place instead of booting a second copy in a new tab (link kind 9).
  // The entry is written here rather than by `pushUrl`, so `restoring` holds the same way it does
  // for Back: everything `applyLocation` then triggers refines this entry instead of adding more.
  const inward = target.closest<HTMLAnchorElement>("a[data-loom]");
  if (inward !== null) {
    event.preventDefault();
    const url = new URL(inward.getAttribute("href") ?? "/", location.href);
    history.pushState(null, "", url.pathname + url.search);
    restoring = true;
    void applyLocation(url.searchParams).finally(() => {
      restoring = false;
    });
    return;
  }

  const art = target.closest<HTMLElement>(".art");
  if (art !== null) {
    const path = art.dataset["path"];
    if (path !== undefined) {
      if (event.metaKey || event.ctrlKey) void handOff(path);
      else openInPane(path);
    }
    return;
  }

  // An Active row is the same gesture as a tree row, on purpose: one way to enter a project.
  const activeItem = target.closest<HTMLElement>(".active-item");
  if (activeItem !== null) {
    const path = activeItem.dataset["record"];
    if (path !== undefined) void enterRecord(path);
    return;
  }

  const treeItem = target.closest<HTMLElement>(".tree-item");
  if (treeItem !== null) {
    if (treeItem.dataset["general"] !== undefined) enterGeneral();
    else if (treeItem.dataset["record"] !== undefined) void enterRecord(treeItem.dataset["record"]);
  }
});

// Back/forward walk the same states the clicks pushed.
/**
 * Back and Forward re-enter the state IN PLACE (requirement 222).
 *
 * This was `location.reload()`, which threw away the socket, the transcript and the reader's place
 * on every press, and — over a history that gained three or four entries per click — reloaded
 * straight into the middle of a move. User: *"going back in browser history often doesnt work and
 * leaves me on a broken page with just the input field"*.
 *
 * `restoring` keeps the restore itself out of the history: re-entering a record in order to show it
 * must not push the place just returned from, or Back would never make progress.
 *
 * A change of CORE still reloads. The record list, the session stores and the tree all differ
 * across cores, so restoring one in place means re-deriving everything the boot sequence derives —
 * and that is the boot sequence. Honest and rare beats clever and half-right.
 */
window.addEventListener("popstate", () => {
  const params = new URL(location.href).searchParams;
  if (coreFromParams(params) !== state.core) {
    location.reload();
    return;
  }
  restoring = true;
  void applyLocation(params).finally(() => {
    restoring = false;
  });
});

/** A relative chip resolves against the session's cwd; absolute paths pass through. */
function absolutise(path: string): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  return state.cwd !== null ? `${state.cwd}/${path}` : path;
}

/**
 * Collapse `.` and `..` — ONLY for comparing against a record's path, never for what is sent to
 * the server. The server resolves paths itself and rejects some shapes this would rewrite.
 */
function normalise(path: string): string {
  if (!path.startsWith("/")) return path;
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

ui.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

// The mode survives reloads per device; auto is the default (SPEC 42).
ui.modeCards.checked = localStorage.getItem("loom-mode") === "cards";
ui.modeCards.addEventListener("change", () => {
  localStorage.setItem("loom-mode", ui.modeCards.checked ? "cards" : "auto");
});

// The browser switch persists the same way, and OFF is what a device that never touched it gets:
// only an explicit "browser" in storage turns MCP back on. Flipping it re-fingerprints the child,
// so the next turn spawns a fresh one — that costs one re-written prefix, which is the same thing
// a flap costs, once, on purpose.
ui.useBrowser.checked = localStorage.getItem("loom-browser") === "on";
ui.useBrowser.addEventListener("change", () => {
  localStorage.setItem("loom-browser", ui.useBrowser.checked ? "on" : "off");
});

// Model and thinking level persist per device, as default for sessions with no pick yet (SPEC google-pro-models).
function restorePick(pick: HTMLSelectElement, key: string): void {
  const stored = localStorage.getItem(key);
  if (stored !== null) pick.value = stored;
  if (pick.selectedIndex < 0) pick.selectedIndex = 0;
  const mark = (): void => {
    if (pick.value === "default") pick.removeAttribute("data-picked");
    else pick.setAttribute("data-picked", pick.value);
  };
  mark();
  pick.addEventListener("change", () => {
    localStorage.setItem(key, pick.value);
    mark();
    const cur = state.sessions.find((s) => s.id === state.sessionId);
    if (cur !== undefined && !state.pendingNew) {
      const spec = state.models.find((m) => m.id === ui.pickModel.value);
      if (spec !== undefined) {
        cur.family = spec.family;
        state.activeFamily = spec.family;
      }
      cur.pick = {
        model: ui.pickModel.value,
        effort: ui.pickEffort.value,
        mode: ui.modeCards.checked ? "cards" : "auto",
        at: Date.now(),
      };
    }
    drawBadge();
  });
}
restorePick(ui.pickModel, "loom-model");
restorePick(ui.pickEffort, "loom-effort");

// Images arrive by paste or by the attach button; both feed the same strip.
ui.composerStop.addEventListener("click", () => void interruptTurn());
// The seam User opens himself. Nothing cuts automatically: what makes a cut safe is an open
// question, and a wrong guess costs him context he expected to still be there (session-flow).
ui.composerNew.addEventListener("click", () => beginNewSession());
// The countdown is a clock, so it has to keep moving without a frame arriving to redraw it.
setInterval(() => drawBadge(), 30_000);

// Hover or click opens the bar-tip detail panel. Click toggles pin so the panel stays open
// while inspecting or clicking across pools (SPEC google-pro-models).
let isBarTipPinned = false;

ui.barMeter.addEventListener("pointerenter", () => {
  if (!isBarTipPinned) ui.barTip.hidden = ui.barTip.childElementCount === 0;
});
ui.barMeter.addEventListener("pointerleave", () => {
  if (!isBarTipPinned) ui.barTip.hidden = true;
});
ui.barMeter.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".bar-tip")) return;
  isBarTipPinned = !isBarTipPinned;
  ui.barTip.hidden = !isBarTipPinned;
});
document.addEventListener("click", (event) => {
  if (isBarTipPinned && event.target instanceof Element && !ui.barMeter.contains(event.target)) {
    isBarTipPinned = false;
    ui.barTip.hidden = true;
  }
});

/**
 * Poll `/api/bar` and `/api/budgets`. When `/api/budgets` 404s (e.g. before server route lands),
 * degrades quietly to `/api/bar` single-budget behavior.
 */
async function loadBar(): Promise<void> {
  const session = pendingKey();
  barSession = session;
  const url = session.length > 0 ? `/api/bar?session=${encodeURIComponent(session)}` : "/api/bar";
  const [barRes, budgetsRes] = await Promise.allSettled([
    getJson<BarReading>(url),
    getJson<BudgetsReport>("/api/budgets"),
  ]);
  if (barRes.status === "fulfilled") {
    state.bar = barRes.value;
  }
  if (budgetsRes.status === "fulfilled") {
    state.budgets = budgetsRes.value;
  }
  drawBadge();
}

void loadBar();
setInterval(() => void loadBar(), 20_000);
ui.composerAttach.addEventListener("click", () => ui.attachInput.click());
ui.attachInput.addEventListener("change", () => {
  for (const file of ui.attachInput.files ?? []) addAttachment(file);
  ui.attachInput.value = "";
});
ui.composerText.addEventListener("paste", (event) => {
  for (const item of event.clipboardData?.items ?? []) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) {
      event.preventDefault();
      addAttachment(file);
    }
  }
});

ui.composerText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});

document.addEventListener("keydown", (event) => {
  // Global shortcuts never fire while typing a message.
  if (document.activeElement === ui.composerText) return;
  // Escape closes the SELECTED non-chat member of the open set (SPEC 187, revising 59): the wheel
  // it used to shut is gone, and the file pane it fell through to is one of those members now. The
  // chat is not closable, so Escape does nothing when the chat is what the centre shows.
  if (event.key === "Escape") {
    if (isBarTipPinned) {
      isBarTipPinned = false;
      ui.barTip.hidden = true;
    }
    const member = selectedOpen(state.opens);
    if (member.kind !== "session") closeMember(member.key);
  } else if (event.key === "End") {
    scrollToEnd();
  } else if (event.code === "KeyF") {
    // Fullscreen (SPEC 194). The PHYSICAL key, not the letter: `event.key` is whatever the active
    // layout printed, so under ЙЦУКЕН this key arrives as `а` and the shortcut silently stopped
    // existing for half of User's typing (2026-08-24). `event.code` names the position and reads
    // `KeyF` under every layout — the price is that a remapped physical layout (Dvorak, Colemak)
    // would toggle on whatever key sits in that position, which is nobody here.
    //
    // Modifiers are left alone on purpose: Ctrl+F and ⌘F are the browser's find, and stealing them
    // would cost more than this key gives.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (typingInto(event.target) || typingInto(document.activeElement)) return;
    event.preventDefault();
    const on = !ui.layout.classList.contains("fullscreen");
    setFullscreen(on);
    // The panels are gone and only a key brings them back, so the key is said out loud — the same
    // rule the layout adopted generally: anything that can go away keeps one visible way back.
    if (on) toast("fullscreen — press f to bring the panels back");
  }
});

// ── auth (SPEC §Auth) ───────────────────────────────────────────────

const loginForm = need<HTMLFormElement>("login");
loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = need<HTMLInputElement>("login-token").value.trim();
  if (token.length === 0) return;
  // /login sets the cookie and redirects home; a wrong token comes back as a visible 403 page.
  location.href = `/login?token=${encodeURIComponent(token)}`;
});

// One delegated listener for every `.zoomable` image, wherever and whenever it is rendered
// (SPEC §117). Installed before boot so an image in the first paint is already live.
installZoom();

void boot().catch((error: unknown) => {
  // A 401 is not a fault, it is an unauthorised device: show the token prompt, not a dead pane.
  if (String(error).includes("401")) {
    loginForm.hidden = false;
    setStatus("unauthenticated", "error");
    return;
  }
  setStatus(String(error), "error");
});
