/**
 * The composer, the dock it lives in, its drafts and attachments, and the permit card.
 */

import { dockState } from "./dock.ts";
import { spokenText } from "./render.ts";
import { holdEnd, moveTranscript, stuck } from "./scroll.ts";
import { toast } from "./status.ts";
import { state, ui } from "./store.ts";
import type { PendingEcho, Permit } from "./types.ts";

export function syncDock(): void {
  const composer = ui.composer;
  // Docking is a statement about the composer's place in the CHAT's flow: it docks when that place
  // has scrolled away. Under a record the composer is not in that flow at all — it hangs off the
  // centre column — so the rule's second term can never be true and there is nothing to dock or to
  // point a pill at. Measuring anyway would read a hidden scroller's zero rect and dock everything.
  if (composer.hidden || composer.parentElement !== ui.transcript) {
    composer.classList.remove("docked");
    ui.composerAnchor.style.height = "0px";
    ui.writePill.hidden = true;
    return;
  }
  const view = ui.transcript.getBoundingClientRect();
  const rect = composer.getBoundingClientRect();
  // The composer's place in the flow costs its own height PLUS the gap above it, and the gap is the
  // spacer's own `min-height` — so the spacer has to hold both, or the scroller changes height at
  // exactly the moment 182 says nothing may move.
  const margin = Number.parseFloat(getComputedStyle(ui.composerAnchor).minHeight) || 0;
  const decision = dockState({
    text: ui.composerText.value,
    attachments: state.attachments.length,
    focused: document.activeElement === ui.composerText,
    anchorTop: ui.composerAnchor.getBoundingClientRect().top,
    viewBottom: view.bottom,
    height: rect.height + margin,
  });
  const was = composer.classList.contains("docked");
  // Deleting the last character of a docked draft puts the box back in the flow — which, while he
  // is 2000px up, is off screen with the caret still in it, and a browser scrolls a focused caret
  // into view. That is the lurch of 182 in the undock direction, so the box is let go BEFORE it
  // moves; the pill below is the way back to it, which is exactly what 184 is for.
  if (was && !decision.docked && decision.pill && document.activeElement === ui.composerText) {
    ui.composerText.blur();
  }
  const keep = ui.transcript.scrollTop;
  composer.classList.toggle("docked", decision.docked);
  // The spacer keeps the scroller's HEIGHT identical across the two states, and that is not enough:
  // when the composer re-enters the flow off screen, the browser scrolls it back into view by
  // itself — 1865px, measured, on the keystroke that empties a draft while he reads 2000px up. So
  // the reader's position is put back on the next frame. `stuck` is the one case where it must not
  // be: a reader following the live end belongs at the end, and `holdEnd` owns that.
  if (was !== decision.docked && !stuck) {
    requestAnimationFrame(() => {
      if (Math.abs(ui.transcript.scrollTop - keep) <= 1) return;
      moveTranscript(keep); // our correction, not his hand — the listener must ignore it
    });
  }
  // NOT rounded: the composer's height is fractional, and a rounded spacer changes the scroller's
  // height by up to a pixel at the moment of docking — which is a real, measurable lurch.
  ui.composerAnchor.style.height = `${decision.spacer}px`;
  ui.writePill.hidden = !decision.pill;
  drawPermitBadge();
  // Docking and undocking change nothing about the scroller's height — the spacer sees to that —
  // but the box growing does, and a reader at the end must stay at the end.
  holdEnd();
}

/**
 * The badge for an unanswered permission card that has scrolled out of view (SPEC 184).
 *
 * Only while the card is off screen, and it never answers anything: a permission granted from a
 * badge is one granted without reading it. It carries ONE card's identity — the first unanswered
 * one — so a second card arriving cannot steal it silently.
 */
function drawPermitBadge(): void {
  const card = firstPermitCard();
  if (card === null || ui.chatArea.hidden) {
    ui.permitBadge.hidden = true;
    return;
  }
  const view = ui.transcript.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const offScreen = box.bottom < view.top + 8 || box.top > view.bottom - 8;
  ui.permitBadge.hidden = !offScreen;
  if (offScreen) {
    // The card's own words, not a count. A count is the silent steal object 7 forbids: two cards
    // waiting reads "2 permissions waiting" whichever one the badge scrolls to, so the second card
    // arriving changes the badge without saying that the thing it points at is still the first.
    // Naming the tool means the badge either says the same thing it said before, or visibly changes.
    ui.permitBadge.textContent = `claude wants to run ${card.dataset["tool"] ?? "a tool"} ↓`;
  }
}

/**
 * The oldest unanswered card in the flow — the one the badge speaks for and scrolls to.
 *
 * Read off the DOM in document order, which after 185 IS message order, so the badge and the scroll
 * can never disagree about which card they mean.
 */
export function firstPermitCard(): HTMLElement | null {
  return ui.transcript.querySelector<HTMLElement>(".permit");
}

/**
 * Which session's echoes the screen is showing. A `pendingNew` send has a real session id from the
 * moment the server answers — seconds before adoption swaps it into `state.sessionId` — so the
 * bucket is addressable the whole time the composed-but-unadopted session is on screen.
 */
export function pendingKey(): string {
  return state.pendingNew && state.pendingNewId !== null ? state.pendingNewId : state.sessionId;
}

/**
 * This session's echoes that still need drawing — the queue minus whatever the transcript already
 * shows, oldest first. A FILTER, not a prune: the list belongs to the server now, so the client must
 * not delete from it. The head of the queue is the turn being answered RIGHT NOW, and the CLI writes
 * that message into the transcript when it picks it up — which is well before the `result` frame that
 * takes it off the queue. Without this, the message being answered would read twice.
 */
export function undrawnEchoes(): PendingEcho[] {
  const waiting = state.pending[pendingKey()];
  if (waiting === undefined || waiting.length === 0) return [];
  const seen = state.messages.filter((m) => m.role === "user").map(spokenText);
  return waiting.filter((echo) => !seen.includes(echo.text.trim())).sort((a, b) => a.at - b.at);
}

/** Same escape rule the transcript store uses — a record's sessions are keyed by its directory. */
function escapeKey(path: string): string {
  return path.replace(/[^A-Za-z0-9-]/g, "-");
}

export function recordDir(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/**
 * The CONTEXT key — which project the composer is talking to. Stable while you stay in a record,
 * because drafts and the pending-new name hang off it: `journey9-train` pins that a draft stays
 * with the session it was typed for, and a key that moves when the open session changes breaks it.
 */
export function storeKey(): string {
  return state.activeRecord !== null ? escapeKey(recordDir(state.activeRecord)) : state.projectKey;
}

/** Which session the box is holding a draft FOR. The queue's own key, so a pending session has one. */
function draftKey(): string {
  return pendingKey().length > 0 ? pendingKey() : `new:${storeKey()}`;
}

/** The key the box's current text belongs to — the one it was typed under, not the one now open. */
export let draftOwner = "";

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingWrites = new Map<string, { text: string; at: number }>();
const DRAFT_DEBOUNCE_MS = 400;

export async function flushDraft(beacon = false): Promise<void> {
  for (const timeout of draftTimers.values()) clearTimeout(timeout);
  draftTimers.clear();

  if (draftOwner.length > 0) {
    const text = ui.composerText.value;
    const at = Date.now();
    if (text.length === 0) delete state.drafts[draftOwner];
    else state.drafts[draftOwner] = { text, at };
    pendingWrites.set(draftOwner, { text, at });
  }

  mirrorDrafts();

  if (pendingWrites.size === 0) return;

  const writes = Array.from(pendingWrites.entries());
  pendingWrites.clear();

  if (beacon) {
    for (const [key, { text, at }] of writes) {
      const json = JSON.stringify({ key, text, at });
      const blob = new Blob([json], { type: "application/json" });
      if (!navigator.sendBeacon("/api/draft", blob)) {
        try {
          fetch("/api/draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: json,
            keepalive: true
          }).catch(() => {});
        } catch {}
      }
    }
    return;
  }

  const c = new AbortController();
  const id = setTimeout(() => c.abort(), 1500);
  try {
    await Promise.all(
      writes.map(([key, { text, at }]) =>
        fetch("/api/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, text, at }),
          signal: c.signal
        }).catch(() => {})
      )
    );
  } finally {
    clearTimeout(id);
  }
}

function mirrorDrafts() {
  const entries = Object.entries(state.drafts).sort((a, b) => b[1].at - a[1].at);
  const capped = Object.fromEntries(entries.slice(0, 50));
  state.drafts = capped;
  try {
    localStorage.setItem("loom-drafts", JSON.stringify(capped));
  } catch {
    // quota exceeded or incognito
  }
}

/** Remember what is in the box, under the session it was typed for. */
export function keepDraft(): void {
  if (draftOwner.length === 0) draftOwner = draftKey();
  const text = ui.composerText.value;
  const at = Date.now();
  const owner = draftOwner;

  if (text.length === 0) delete state.drafts[owner];
  else state.drafts[owner] = { text, at };
  mirrorDrafts();

  pendingWrites.set(owner, { text, at });

  const existing = draftTimers.get(owner);
  if (existing !== undefined) clearTimeout(existing);

  draftTimers.set(
    owner,
    setTimeout(() => {
      draftTimers.delete(owner);
      const pending = pendingWrites.get(owner);
      if (pending === undefined) return;
      pendingWrites.delete(owner);

      fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: owner, text: pending.text, at: pending.at })
      }).catch(() => {});
    }, DRAFT_DEBOUNCE_MS)
  );
}

/**
 * Move the box to whatever session is now open: what was in it goes back to the session it was
 * typed for, and that session's own draft comes out. Called from every path that can change which
 * session the composer is talking to, and a no-op when the owner has not changed.
 */
export function switchDraft(): void {
  const now = draftKey();
  if (now === draftOwner) return;
  keepDraft();
  draftOwner = now;
  ui.composerText.value = state.drafts[now]?.text ?? "";
  fitComposer();
  syncDock();

  // Conditionally refresh text if server has a newer version.
  fetch(`/api/draft?key=${encodeURIComponent(now)}`)
    .then(res => {
      if (res.ok) return res.json();
      throw new Error();
    })
    .then(data => {
      if (typeof data !== "object" || data === null) return;
      const { text, at } = data as { text?: string, at?: number };
      if (typeof text !== "string" || typeof at !== "number") return;

      const local = state.drafts[now];
      const localAt = local ? local.at : 0;
      if (at > localAt) {
        state.drafts[now] = { text, at };
        mirrorDrafts();
        if (draftOwner === now) {
          ui.composerText.value = text;
          fitComposer();
          syncDock();
        }
      }
    })
    .catch(() => {});
}

/** A session that has just been named keeps the draft composed under its placeholder key. */
export function renameDraft(from: string, to: string): void {
  if (from === to) return;
  const entry = state.drafts[from];
  if (entry !== undefined) {
    state.drafts[to] = entry;
    delete state.drafts[from];
    mirrorDrafts();

    // R6. Rename posts a delete for `from` and a write for `to` (with the same `at`).
    fetch("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: from, text: "", at: entry.at })
    }).catch(() => {});

    fetch("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: to, text: entry.text, at: entry.at })
    }).catch(() => {});
  }
  if (draftOwner === from) draftOwner = to;
}

/**
 * The composer's height is its content's height, so it must be recomputed on every change to the
 * value — including the changes no `input` event fires for. Clearing the text on send is exactly
 * that case, and it was the bug: the inline height written while typing survived `value = ""`, so
 * the box stayed as tall as the message already gone (User, 2026-08-07: "it stays large and
 * doesnt collapse after sending the message"). The floor and the ceiling are the stylesheet's
 * (`min-height` / `max-height` beat an inline `height`); this only ever fits the content between
 * them.
 */
/**
 * Grow the box to its content.
 *
 * The browser can do this itself with `field-sizing: content`, and when it can, we must NOT: the
 * JS path writes a style and then reads `scrollHeight`, and that read is a forced synchronous
 * layout costing 15–29ms per frame in his browser even after the per-character version was
 * coalesced away. Native sizing has no measurement in it at all, so there is nothing to force.
 * The clamp moves to `max-height` in the stylesheet, which is the same 40% of the window.
 *
 * The old path stays for anything without support — it is correct, only expensive.
 */
export const NATIVE_FIT =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

export function fitComposer(): void {
  if (NATIVE_FIT) return;
  ui.composerText.style.height = "auto";
  ui.composerText.style.height = `${Math.min(ui.composerText.scrollHeight, window.innerHeight * 0.4)}px`;
}

// ── attachments (images only; SPEC §Input path) ─────────────────────

export function drawAttachments(): void {
  ui.attachments.replaceChildren();
  ui.attachments.hidden = state.attachments.length === 0;
  // An attachment is a draft even with no words in the box, so the strip and the dock rule move
  // together (SPEC 199). The strip lives INSIDE the composer now, so it docks with it.
  queueMicrotask(() => syncDock());
  state.attachments.forEach((attachment, index) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    const img = document.createElement("img");
    img.src = `data:${attachment.mediaType};base64,${attachment.data}`;
    img.alt = "attachment";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      drawAttachments();
    });
    chip.append(img, remove);
    ui.attachments.append(chip);
  });
}

export function addAttachment(file: File | Blob & { type: string }): void {
  if (!file.type.startsWith("image/")) {
    toast("only images can be attached for now", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    const comma = url.indexOf(",");
    state.attachments.push({ mediaType: file.type, data: url.slice(comma + 1) });
    drawAttachments();
  };
  reader.readAsDataURL(file);
}

/**
 * A pending permit is a card with the tool call and two buttons — the whole permission UI.
 *
 * Built one card at a time because the cards live IN the message flow now (SPEC 185), each at the
 * point of the turn where it was asked. `drawTranscript` places them; there is no container. The
 * card carries the tool name as data so the badge can name the card it points at (SPEC 184) without
 * re-reading `state.permits` and picking a different one.
 *
 * `aria-live` sits on the card rather than on a standing region, which is the cost of the move the
 * plan named: a node that is inserted already carrying the attribute is announced less reliably
 * than one written into a region that was already there. The placement is the requirement; this is
 * the part of it that got worse.
 */
export function permitCard(permit: Permit): HTMLElement {
  // The SAME node every redraw, keyed by the permit's id. `drawTranscript` runs on every frame the
  // socket delivers, and a card rebuilt each time is a card whose buttons are replaced under the
  // cursor and whose `aria-live` announces again on every poll. A permit never changes once asked —
  // id, tool, input and time are all fixed — so the node has nothing to re-render.
  const cached = permitNodes.get(permit.id);
  if (cached !== undefined) return cached;

  const card = document.createElement("div");
  card.className = "permit";
  card.setAttribute("aria-live", "polite");
  card.dataset["permit"] = permit.id;
  card.dataset["tool"] = permit.toolName;

  const head = document.createElement("div");
  head.className = "permit-head";
  head.textContent = `claude wants to run ${permit.toolName}`;
  card.append(head);

  const input = document.createElement("pre");
  input.className = "permit-input";
  const raw = typeof permit.toolInput === "string" ? permit.toolInput : JSON.stringify(permit.toolInput, null, 1);
  input.textContent = raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw;
  card.append(input);

  const actions = document.createElement("div");
  actions.className = "permit-actions";
  for (const verdict of ["allow", "deny"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `permit-btn ${verdict}`;
    button.textContent = verdict;
    button.addEventListener("click", () => void answerPermit(permit.id, verdict));
    actions.append(button);
  }
  card.append(actions);
  permitNodes.set(permit.id, card);
  return card;
}

/** One node per unanswered permit, so a redraw moves the card rather than replacing it. */
const permitNodes = new Map<string, HTMLElement>();

/** When a card was asked, in the same milliseconds `anchorOrder` places messages by. */
export function permitAt(permit: Permit): number {
  const at = Date.parse(permit.ts);
  // An unparseable stamp goes to the END rather than to 1970, where it would sit above the session.
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/** The unanswered cards, oldest first — the order they are placed into the flow in. */
export function pendingPermits(): Permit[] {
  // An answered card is gone from the frame, so its node is dead: drop it or the map grows for the
  // life of the page.
  const live = new Set(state.permits.map((p) => p.id));
  for (const id of [...permitNodes.keys()]) if (!live.has(id)) permitNodes.delete(id);
  return [...state.permits].sort((a, b) => permitAt(a) - permitAt(b));
}

async function answerPermit(id: string, verdict: "allow" | "deny"): Promise<void> {
  try {
    const response = await fetch("/api/permit/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, verdict }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      toast(body.error ?? `answer failed (${response.status})`, true);
    }
  } catch (error) {
    toast(`answer failed: ${String(error)}`, true);
  }
}

// The composer grows with its content up to 40% of the screen (ui record, item 2), and every
// change to the text is a change to the dock decision (SPEC 199) — including the ones that grow it.
/**
 * The box's RESIZE is coalesced to one frame; the dock is not.
 *
 * Measured in his browser: `TEXTAREA#composer-text.oninput x21 = 990ms (forced 969ms)` — 47ms per
 * character, essentially all of it forced synchronous layout, because `fitComposer` writes a style
 * and then reads `scrollHeight`. Typing faster than the browser can service each event collapses
 * twenty of them into one frame, and that is the second-long freeze.
 *
 * Coalescing BOTH calls was tried first and reverted: it stopped the composer docking at all, for
 * five seconds, in two scroll journeys. `syncDock` therefore stays exactly where it was — the dock
 * is a statement about the composer's place that other code depends on being current, and it is
 * the cheaper of the two reads. Only the resize moves, and it still lands before the next paint,
 * which is when a frame ends, so nothing he can see happens later than it did.
 */
let fitPending = 0;
export function scheduleFit(): void {
  if (fitPending !== 0) return;
  fitPending = requestAnimationFrame(() => {
    fitPending = 0;
    fitComposer();
  });
}
