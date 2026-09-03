/**
 * The working row, step ticker, and job state reconciliation.
 */

import { getJson } from "./request.ts";
import { holdEnd } from "./scroll.ts";
import { state, ui } from "./store.ts";
import type { PendingEcho } from "./types.ts";

/**
 * Put a node the redraw built ABOVE the tail: before the first tail node still attached, or at the
 * end while none is — the first draw of a fresh page, before `drawStep` and the appends at the foot
 * have ever run.
 */
export function placeAboveTail(node: Node): void {
  for (const member of [workingRow, ui.composerAnchor, ui.composer]) {
    if (member !== null && member.parentElement === ui.transcript) {
      ui.transcript.insertBefore(node, member);
      return;
    }
  }
  ui.transcript.append(node);
}

/**
 * The composer reflects the job WITHOUT locking it (SPEC 106). Sending stays available while a turn
 * runs — the session's child queues the message and answers it in order — and the stop button
 * appears instead of being a permanently dead control. The old shape disabled send until the turn
 * finished, which is precisely what made a turn going wrong something to sit and watch.
 */
export function setJob(job: "idle" | "running", queued = 0, step: string | null = null, stepMs = 0): void {
  // The overstay clock counts from the last CHANGE, so a step that keeps changing can never look
  // stalled and one that stops changing always does. An unchanged step keeps its original mark —
  // resetting it here would let a repeat frame quietly hide a hang. The start of a turn counts as a
  // change, so a child that hangs BEFORE it says anything is caught by the same rule.
  const changed = step !== state.step || state.job !== "running";
  state.job = job;
  state.queued = queued;
  if (job !== "running") {
    for (const agent of state.subagents.values()) {
      if (agent.verdict === "STALE / POSSIBLY DEAD" || agent.verdict === "RUNNING") {
        agent.verdict = "DEAD";
      }
    }
    drawSubagents();
  }
  if (job !== "running") state.step = null;
  else if (changed) {
    state.step = step;
    state.stepAt = Date.now() - stepMs;
  }
  ui.composerStop.hidden = job !== "running";
  // No placeholder (SPEC 191, "its annoying"). The attribute came off the markup at step 4 of this
  // build, and this line was putting it straight back on the next job frame — the same string, set
  // from code. The accessible name is the `aria-label`, which stays.
  drawStep();
}

/**
 * The working indication (SPEC 96) — loom's first animation, and the one place it earns its motion.
 *
 * Three things sit on this line: the spinner (something is in flight), the act (`reading tasks.ts`,
 * quieted server-side so a burst of parallel calls is one line), and — only once the act has stopped
 * changing for longer than it should — how long it has been stuck there. That last part is the whole
 * honesty argument: a spinner alone spins just as happily on a hung child, and a label held steady
 * for legibility makes a stalled turn look like a slow one unless the label itself admits it.
 *
 * It lives at the bottom of the TRANSCRIPT, not the composer's toolbar — User, 2026-08-07, after
 * the first cut put it there: *"you did it in the bottom panel and you should have done it at the
 * bottom of chat like in vs code."* VS Code's chat and the CLI's own status line both put it as the
 * last line of the conversation, not a composer control, so the row is built here and appended as
 * the last child of `ui.transcript` — the same place `drawPending()` puts a queued echo, and for the
 * same reason: `drawTranscript()` may replace any row on any redraw (SPEC 211), so anything that
 * has to survive one gets re-appended after it, not left sitting in static HTML.
 */
const OVERSTAY_MS = 10_000;

/** How long a step has been the shown label, read at a glance: 14s, 2m 05s, 1h 12m. */
function held(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

let stepTicker: ReturnType<typeof setInterval> | null = null;

// One stable triple, built once and re-appended (never recreated) on every `drawTranscript()`
// rebuild — a replaced row takes it with it, but a fresh `append()` puts the
// SAME node back rather than standing up a new one. Node identity matters here: `aria-live="polite"`
// only reliably announces changes on a region that stays put, and a live-region reader who reloads
// nothing gets nothing if the element under it keeps getting swapped out from under it.
let workingRow: HTMLElement | null = null;
let workingSpin: HTMLElement | null = null;
let workingLabel: HTMLElement | null = null;

function ensureWorkingRow(): void {
  if (workingRow !== null) return;
  workingRow = document.createElement("div");
  workingRow.id = "chat-working";
  workingRow.className = "chat-working";
  workingSpin = document.createElement("span");
  workingSpin.id = "composer-spin";
  workingSpin.setAttribute("aria-hidden", "true");
  workingLabel = document.createElement("span");
  workingLabel.id = "composer-state";
  workingLabel.setAttribute("aria-live", "polite");
  workingRow.append(workingSpin, workingLabel);
}

export function drawSubagents(): void {
  const container = document.getElementById("subagents-container");
  if (!container) return;
  
  if (state.subagents.size === 0) {
    container.innerHTML = "";
    return;
  }

  // Sort by idleS (least idle first) as in spike
  const views = Array.from(state.subagents.values());
  views.sort((a, b) => a.idleS - b.idleS);

  const panel = document.createElement("div");
  panel.className = "panel";
  
  const header = document.createElement("h1");
  header.textContent = `subagents (${views.length})`;
  header.style.margin = "10px 0 5px";
  container.innerHTML = "";
  container.append(header, panel);

  for (const v of views) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "9px";
    row.style.padding = "7px 10px";
    row.style.borderBottom = "1px solid var(--line)";

    const dot = document.createElement("div");
    dot.className = "dot " + (v.verdict === "RUNNING" ? "running" : v.verdict === "FINISHED" ? "finished" : "dead");
    
    const main = document.createElement("div");
    main.className = "main";
    main.style.flex = "1";
    main.style.minWidth = "0";

    const top = document.createElement("div");
    top.className = "top";
    top.style.display = "flex";
    top.style.alignItems = "baseline";
    top.style.gap = "7px";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = v.description || v.agentId;

    const typeSpan = document.createElement("span");
    typeSpan.className = "type";
    typeSpan.textContent = v.agentType || "background";

    top.append(name, typeSpan);

    const stepDiv = document.createElement("div");
    stepDiv.className = "step";
    stepDiv.textContent = v.lastLabel || (v.isBackground ? "running background task..." : "thinking...");

    main.append(top, stepDiv);

    const right = document.createElement("div");
    right.className = "right";
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "10px";

    const elapsed = document.createElement("div");
    elapsed.className = "elapsed";
    elapsed.textContent = `${v.elapsedS}s`;

    const badge = document.createElement("div");
    badge.className = "badge " + (v.verdict === "RUNNING" ? "running" : v.verdict === "FINISHED" ? "finished" : "dead");
    badge.textContent = v.verdict;

    right.append(elapsed, badge);
    
    row.append(dot, main, right);
    panel.append(row);
  }
}

export function drawStep(): void {
  ensureWorkingRow();
  drawSubagents();
  const row = workingRow!;
  const spin = workingSpin!;
  const label = workingLabel!;
  // Its place is the end of the MESSAGES, which is no longer the end of the scroller: the composer
  // and its spacer sit below it now (SPEC 199). Keyed on the neighbour rather than on being last,
  // or the one-second ticker would walk the row down past the composer on every tick.
  const before = ui.composerAnchor.parentElement === ui.transcript ? ui.composerAnchor : null;
  if (row.parentElement !== ui.transcript || row.nextElementSibling !== before) {
    if (before === null) ui.transcript.append(row);
    else ui.transcript.insertBefore(row, before);
  }

  const running = state.job === "running";
  row.hidden = !running;
  spin.hidden = !running;
  if (!running) {
    label.textContent = "";
    if (stepTicker !== null) clearInterval(stepTicker);
    stepTicker = null;
    holdEnd();
    return;
  }
  // One second is fine: the number it draws only ever changes once a second anyway.
  if (stepTicker === null) stepTicker = setInterval(drawStep, 1000);

  const age = Date.now() - state.stepAt;
  // `working` overstays too: a child that hangs before its first frame is the purest hang there is.
  const overstay = age >= OVERSTAY_MS ? ` · ${held(age)}` : "";
  const waiting = state.queued > 1 ? ` · ${state.queued - 1} queued` : "";
  label.textContent = `${state.step ?? "working"}${overstay}${waiting}`;
  // Last thing in the last step of every transcript redraw (`drawTranscript()` ends here), and the
  // once-a-second tick comes through here too — so a reader at the end stays at the end through
  // this row appearing, growing a second line, and going away again.
  holdEnd();
}

/**
 * Ask `/api/session-state` for this session's live truth and correct `state.job` from it — the
 * REST fallback for a terminal event a retire fired while nothing was listening (SPEC requirement
 * for session-truth step 6). Guarded on the session named at the CALL still being the one on screen
 * when the answer lands: a fast navigation elsewhere between the request and the response must not
 * apply a stale session's job state to whatever is now open.
 */
export async function reconcileJobFromServer(sessionId: string): Promise<void> {
  if (sessionId.length === 0) return;
  try {
    const answer = await getJson<{ state: "running" | "idle"; queued: number; pending: PendingEcho[]; step: string | null; stepMs: number }>(
      `/api/session-state?session=${encodeURIComponent(sessionId)}`,
    );
    if (state.sessionId !== sessionId) return; // no longer the session on screen — not this call's to set
    setJob(answer.state === "running" ? "running" : "idle", answer.queued, answer.step, answer.stepMs);
  } catch {
    // The socket's own attach frame is the primary path; this is insurance, not the only chance.
  }
}
