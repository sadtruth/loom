/**
 * The marks a project row wears, and what decides them.
 */

import { statusClass } from "./chips.ts";
import { ACTIVE_MS, activeRows } from "./panel.ts";
import { drawCacheBar, minutes } from "./quota-bar.ts";
import {
  carriesBar,
  rowIconState,
  warmestWindow,
  type CacheWindow,
} from "./rowicon.ts";
import { state, ui } from "./store.ts";
import type { RecordInfo, SessionActivity, SessionInfo } from "./types.ts";

/** Session id → its activity, flattened across stores, so a session's mark costs one lookup. */
export const activityById = new Map<string, SessionActivity>();

/** The floor a reply must beat to count as unread: what this device saw, never below the watermark. */
function seenFloor(sessionId: string): number {
  return Math.max(state.seen[sessionId] ?? 0, state.watermark);
}

/**
 * A letter means "something is waiting for you", so it is drawn on the reply that ENDED the turn,
 * not on the newest reply of any kind (SPEC 111). A long turn says things on its way through; being
 * called back to a row three times before there is anything to act on is the cost this removes.
 */
function unreadSession(sessionId: string): boolean {
  const activity = activityById.get(sessionId);
  return activity !== undefined && activity.lastEnded > seenFloor(sessionId);
}

/**
 * The four facts one row has about its sessions, folded into one answer (SPEC 257).
 *
 * A record's store holds a TRAIN of sessions, so every fact here needs a rule for which one it
 * speaks for. Unread, active and working are "any of them"; the cache window is the warmest one,
 * because that is the session he would type into. Nothing here fetches: it reads the poll's answer
 * the client is already holding.
 */
function attention(key: string): {
  unread: boolean;
  active: boolean;
  working: boolean;
  cache: CacheWindow | null;
} {
  const floor = Date.now() - ACTIVE_MS;
  let unread = false;
  let active = false;
  let working = false;
  const sessions = state.activity[key] ?? [];
  for (const session of sessions) {
    // One definition of "unread", shared with the picker's ✉: two comparisons would be two rules,
    // free to drift apart (found by mutation — killing one left the other reporting green).
    if (unreadSession(session.id)) unread = true;
    if (session.lastTyped > floor) active = true;
    if (session.running === true) working = true;
  }
  return { unread, active, working, cache: warmestWindow(sessions) };
}

/** Children by parent path; roots are records whose parent is absent from the scan. */
export function recordChildren(): Map<string | null, RecordInfo[]> {
  const byPath = new Set(state.records.map((r) => r.path));
  const map = new Map<string | null, RecordInfo[]>();
  for (const record of state.records) {
    const key = record.parent !== null && byPath.has(record.parent) ? record.parent : null;
    const list = map.get(key) ?? [];
    list.push(record);
    map.set(key, list);
  }
  return map;
}

/** The marching dots: one lap, and how far the second and third dots lag the first. */
const MARCH_MS = 1100;
const MARCH_STAGGER_MS = 160;

/**
 * A tree row's mark, on the written ladder of SPEC 256: **working, unread, new, status** — highest
 * wins, exactly one drawn. The ring (he typed here inside 24h) and the cache bar (what is left of
 * the prompt-cache hour) are MODIFIERS layered on whichever won, so neither ever competes for the
 * slot; the status colour rides on the ROW's class and is never consumed by any of them.
 *
 * Before this the order lived as an `if` here and a second `if` two hundred lines away at the call
 * site, which is how a record could wear one mark in the tree and another in the Active list.
 */
export function treeDot(key: string, isNew = false): HTMLElement {
  const now = Date.now();
  const { unread, active, working, cache } = attention(key);
  const level = rowIconState({ working, unread, isNew });
  const dot = document.createElement("span");
  dot.className = `tree-dot${level === "status" ? "" : ` ${level}`}${active ? " active" : ""}`;
  let said = active ? "you were writing here recently" : "";
  if (level === "working") {
    said = "a turn is running here now";
    // Three dots marching (treatment D, his pick over the spinner arc, the swept clock and the
    // breathing dot, 2026-08-11). The phase comes from a SHARED clock rather than from the node's
    // birth: `drawTree()` replaces every row every 15 s, and an animation timed from creation would
    // visibly restart four times a minute — the defect he has already watched once (SPEC 262).
    for (let i = 0; i < 3; i += 1) {
      const pip = document.createElement("i");
      pip.className = "march";
      const phase = (((now - i * MARCH_STAGGER_MS) % MARCH_MS) + MARCH_MS) % MARCH_MS;
      pip.style.animationDelay = `${String(-phase)}ms`;
      dot.append(pip);
    }
  } else if (level === "unread") {
    said = "a reply you have not read";
    // Drawn, not typed: an envelope CHARACTER renders as a colour emoji on some platforms and as
    // tofu on others, and this glyph has to read at 11px next to a 8px dot.
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 14 10");
    svg.setAttribute("aria-hidden", "true");
    const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    box.setAttribute("x", "0.75");
    box.setAttribute("y", "0.75");
    box.setAttribute("width", "12.5");
    box.setAttribute("height", "8.5");
    box.setAttribute("rx", "1.5");
    const flap = document.createElementNS("http://www.w3.org/2000/svg", "path");
    flap.setAttribute("d", "M1 2 L7 6 L13 2");
    svg.append(box, flap);
    dot.append(svg);
  } else if (level === "new") {
    dot.textContent = "new";
  }
  const told = drawCacheBar(dot, carriesBar(level) ? cache : null, now);
  dot.title = [said, told].filter((part) => part.length > 0).join(" · ");
  return dot;
}

/**
 * The mark a RECORD wears, wherever it is drawn. `treeDot` knows only the session facts — a reply
 * waiting, recent typing — and this adds the one fact that lives in the record itself. Both lists
 * call it, so a project cannot show one mark in the tree and a different one in the Active list
 * (User, 2026-08-29: the Active rows were all plain blue balls).
 */
export function recordDot(record: RecordInfo): HTMLElement {
  // Where "new" sits against the other three is `rowIconState`'s to say, not this function's — the
  // whole point of the ladder is that the order lives in one written place (SPEC 256).
  const dot = treeDot(record.path, recordIsNew(record));
  if (dot.classList.contains("new")) dot.title = `created ${record.created ?? ""}`.trim();
  return dot;
}

/** How long a record reads as "new" in the panel after its `created:` date. */
const NEW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * "New" = no non-empty session attached yet (User, 2026-08-09) — a session someone typed in or
 * that ever replied counts; a spawned-but-silent one does not. Not per-device: two earlier
 * definitions died here (age alone flagged projects full of sessions; per-device visited state he
 * rejected outright). The age window only stops ancient empty records — most of the vault has no
 * sessions in its directories at all — from wearing the badge forever.
 */
function recordIsNew(record: RecordInfo): boolean {
  if (record.status === "done" || record.status === "abandoned") return false;
  if (record.created === null) return false;
  const t = Date.parse(record.created);
  if (!Number.isFinite(t) || Date.now() - t >= NEW_MS) return false;
  // UNKNOWN never shows the badge (SPEC requirement 237). A path `/api/activity` has not actually
  // resolved yet — a pending fetch, a failed one, or one that simply has not run since boot — reads
  // exactly like a genuinely empty one through `state.activity[path] ?? []` alone; `activityAnswered`
  // is the only place "I asked" is recorded. User, twice: a busy project wore "new" for the whole
  // first poll interval (items 53, 63).
  if (!state.activityAnswered.has(record.path)) return false;
  // Keyed by the RECORD (SPEC 217). This read the record's escaped DIRECTORY until 2026-08-17, and
  // a record's sessions stopped living there on 2026-08-16 — so the list was always empty, the loop
  // never ran, and every subproject wore "new" for three days however busy it was. User:
  // *"the status 'new' of subproject not updating in work core even though there is an active
  // session in it"*.
  for (const session of state.activity[record.path] ?? []) {
    if (session.lastTyped > 0 || session.lastReply > 0) return false;
  }
  return true;
}

/** One footer row: what is hidden, and the one gesture that brings it back. */
export function treeFoot(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tree-more ${className}`;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * The Active list: everywhere he typed in the last 24 hours, newest first (SPEC 247).
 *
 * The tree answers "is THIS project live" one row at a time, with the ring; nothing answered "which
 * of them is" without opening every branch by hand. This is that question, flat — and it is a second
 * READ of `state.activity`, never a second truth: the window and the comparison both live in
 * `panel.ts` beside the ring's.
 *
 * Scoped to the chosen core, like the tree, on User's word (2026-08-26). The earlier design had it
 * span every core; he asked for the panel to answer about the core he is looking at, and the core
 * selector already says which that is.
 */
export function drawActive(): void {
  const rows = activeRows(state.records, state.activity, { now: Date.now(), core: state.core });
  // Nothing active means nothing drawn — no heading, no "nothing here" row. The panel's quiet-by-
  // default convention: a section that only ever announces its own emptiness costs pixels the tree
  // needs and says nothing the tree does not already show.
  ui.activeHead.hidden = rows.length === 0;
  ui.active.hidden = rows.length === 0;
  ui.active.replaceChildren();
  if (rows.length === 0) return;
  const byPath = new Map(state.records.map((record) => [record.path, record]));
  const now = Date.now();
  for (const { path, lastTyped } of rows) {
    const record = byPath.get(path);
    if (record === undefined) continue; // the scan moved under the list between the two reads
    const row = document.createElement("div");
    row.className = `active-item status-${statusClass(record.status)}${state.activeRecord === path ? " current" : ""}`;
    row.dataset["record"] = path;
    // The record's own mark, not a stand-in for it: status colour, the NEW badge, the unread letter
    // and the ring all read the same here as they do on the tree row for the same project.
    const dot = recordDot(record);
    const label = document.createElement("span");
    label.className = "active-label";
    label.textContent = record.title;
    label.title = `${record.status} · ${path}`;
    const age = document.createElement("span");
    age.className = "active-age";
    // The SAME formatter the cache line uses — inside a 24h window it reads "40 min" or "7 h", and
    // one way of saying how long ago is one thing to learn.
    age.textContent = minutes(Math.max(0, now - lastTyped));
    row.append(dot, label, age);
    ui.active.append(row);
  }
}

/** One session's line in the picker: the letter first, then what it was about, then when. */
export function sessionLabel(session: SessionInfo): string {
  const when = new Date(session.mtime);
  const stamp = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const title = (session.title ?? session.firstPrompt ?? session.id.slice(0, 8)).replace(/\s+/g, " ").slice(0, 60);
  return `${unreadSession(session.id) ? "✉ " : ""}${title}${stamp.length > 0 ? ` · ${stamp}` : ""}`;
}
