/**
 * Message -> DOM.
 *
 * The transcript's biggest source of visual noise is that a tool call and its result are two separate
 * rows: the assistant emits tool_use, and the RESULT arrives as a "user" row. So this module pairs
 * them by tool_use_id into one disclosure, and drops user rows that are nothing but tool results —
 * otherwise every Bash call renders as a fake turn from User.
 */

import { renderMarkdown } from "./markdown.ts";
import { commandGist, summariseRun } from "./gist.ts";
import type { BlockContext } from "./blocks.ts";
import { turnSignature } from "./signature.ts";
import { turnCostLabel } from "./turn-cost.ts";
export type { MessageUsage } from "./turn-cost.ts";
export { sumTurnUsage, turnCostLabel } from "./turn-cost.ts";
import type { MessageUsage } from "./turn-cost.ts";

export { turnSignature };

export type Role = "user" | "assistant" | "system";

export interface Block {
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  mediaType?: string;
  data?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  forId?: string;
  isError?: boolean;
}


export interface Message {
  uuid: string;
  parentUuid: string | null;
  role: Role;
  ts: string;
  blocks: Block[];
  isSidechain: boolean;
  isMeta: boolean;
  /** Server-side, from `stop_reason` (SPEC 111). The answer of a turn is the row this is true of. */
  endsTurn?: boolean;
  usage?: MessageUsage;
}

export interface RenderOptions {
  /** The meta toggle, so "show me the noise" shows the recap block too rather than only whole rows. */
  showMeta?: boolean;
  ctx: BlockContext;
  results: Map<string, Block>;
  pinned: boolean;
  showThinking: boolean;
  onPin: (uuid: string, pinned: boolean) => void;
  /**
   * A fingerprint of everything OUTSIDE the turn that changes how it draws — the session cwd and
   * the record list, which decide what a path chip is labelled. It rides in the signature (211) so
   * a turn drawn before the records arrived is rebuilt once they do, and not otherwise.
   */
  stamp: string;
  /**
   * Window-percent one weighted `usage.units` is worth, from `/api/bar`'s `scale` (usage-bar,
   * 2026-08-26). Optional, and treated as 0 when absent, the same as when the quota reading is
   * unknown — `renderTurn` then draws no cost figure rather than a percentage of a window it
   * cannot size. Optional so callers built before this field existed (the signature pins) do not
   * have to know about it.
   */
  scale?: number;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A user row carrying only tool results is machinery, not a turn. */
export function isToolCarrier(message: Message): boolean {
  return (
    message.role === "user" &&
    message.blocks.length > 0 &&
    message.blocks.every((b) => b.kind === "tool_result")
  );
}

/**
 * Group rows into TURNS.
 *
 * One reply from Claude is many rows in the transcript — thinking, each tool_use, and each text
 * block arrive as separate assistant rows, with the tool RESULTS interleaved as user rows. Rendering
 * rows one-to-one produces a dozen "ASSISTANT 02:02 PM" headers for a single answer, which is most
 * of the chronological noise User is complaining about. A turn ends only at a real user message.
 */
export function groupTurns(messages: readonly Message[]): Message[][] {
  const turns: Message[][] = [];
  let current: Message[] | null = null;
  // ONE ROW, ONE DRAW (SPEC 230). A uuid is unique to a row, and a transcript carrying the same one
  // twice is the CLI having written that row again — resuming across a compaction re-emits the rows
  // it carried forward. Measured 2026-08-20 on a real session: 3,653 rows, 2,666 distinct uuids,
  // 979 repeats, every one byte-identical to its twin. Nothing downstream can tell the copies
  // apart, because they share the `drawKey` the reconcile assumes is unique.
  const seen = new Set<string>();

  for (const message of messages) {
    if (isToolCarrier(message)) continue; // machinery: consumed via the results map
    if (seen.has(message.uuid)) continue;
    seen.add(message.uuid);
    const last = current?.[0];
    const sameTurn =
      last !== undefined &&
      last.role === message.role &&
      message.role !== "user" &&
      last.isMeta === message.isMeta;
    if (sameTurn && current !== null) {
      current.push(message);
      continue;
    }
    current = [message];
    turns.push(current);
  }

  return turns;
}

export function collectResults(messages: readonly Message[]): Map<string, Block> {
  const map = new Map<string, Block>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "tool_result" && typeof block.forId === "string") map.set(block.forId, block);
    }
  }
  return map;
}

/** One line that says what the call actually did — the reason a collapsed row is still useful. */
export function summariseTool(name: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const pick = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");

  // The gist strips the `cd <project> &&` prefix every Bash call in a real session carries.
  if (name === "Bash") return commandGist(pick("command"));
  if (name === "Read" || name === "Write" || name === "Edit" || name === "NotebookEdit") return pick("file_path");
  if (name === "Grep") return `${pick("pattern")} ${pick("path")}`.trim();
  if (name === "Glob") return pick("pattern");
  if (name === "WebFetch" || name === "WebSearch") return pick("url") || pick("query");
  if (name === "Task" || name === "Agent") return pick("description");
  if (name === "TodoWrite") return "todo list";

  const first = Object.values(record).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Two calls in a row are still readable; three start being a wall. */
const FOLD_AT = 3;

/**
 * What the reader has UNFOLDED, by key, across redraws (SPEC 146).
 *
 * The transcript is a full redraw per change and a `<details>` keeps its open state nowhere but the
 * DOM, so every frame of a running turn refolded whatever was being read — User, 2026-08-10:
 * *"when i open a list of actions you took and try to look at them, they collapse back if you're
 * doing something in the session at that point."* The state belongs to the READER, so it lives
 * beside the renderer rather than in the message model, keyed by the tool_use id: unique inside a
 * session, stable across every redraw of it, and unaffected by anything arriving above.
 */
const unfolded = new Map<string, boolean>();

/**
 * Draw one disclosure in the state the reader left it in, and remember what they do to it.
 * `fallback` is what an unseen one opens as, which is how "a fresh strip arrives folded" and
 * "thinking is expanded" both keep working.
 *
 * `keys` is a LIST, and both facts about it are requirement 212:
 *
 * The keys are NAMESPACED — `tool:<id>` against `run:<id>`. They used to be the bare tool_use id
 * for both a call and the strip containing it, which is one entry in one map: opening the list of
 * commands opened its first command on the next frame, dumping its input and its output into the
 * page, and closing that command closed the list (User, 2026-08-14: *"i cant open collapsed list
 * of commands because they randomly close or open again"*). 146 prescribed that collision in so
 * many words, so the clause moved with the code.
 *
 * And a strip's identity is its WHOLE membership, not its head. A run grows while a turn works, and
 * SPLITS when a call's result turns out to be an error — `[A,B,C,D]` becomes `[A]`, a bare failed
 * `B`, and a strip of `[C,D]` keyed on C. Marking every member is what carries an open list through
 * both.
 *
 * The write happens on the CLICK, synchronously. `toggle` is queued as a task, so a redraw landing
 * between the click and that task read the old value, rebuilt the node folded, and the event then
 * fired on a node nobody could see — at two redraws a second, a window hit routinely.
 */
function remember(details: HTMLDetailsElement, keys: readonly string[], fallback: boolean): void {
  const first = keys[0];
  details.open = first === undefined ? fallback : (unfolded.get(first) ?? fallback);
  if (first === undefined) return;
  const write = (open: boolean): void => {
    for (const key of keys) unfolded.set(key, open);
  };
  details.addEventListener("click", (event) => {
    // Only THIS disclosure's own summary: a click on a nested one bubbles up here too, and a strip
    // answering for its children would be the collision again, wearing an event listener.
    const summary = (event.target as Element | null)?.closest("summary");
    if (summary?.parentElement !== details) return;
    write(!details.open);
  });
  details.addEventListener("toggle", () => {
    // The assignment above queues a `toggle` of its own; writing back the value it just read is
    // pointless, and skipping it keeps the map to what a reader actually did.
    if (unfolded.get(first) === details.open) return;
    write(details.open);
  });
}

/**
 * Fill a disclosure the first time it OPENS, and never before (SPEC 229).
 *
 * A closed `<details>` shows its summary and nothing else, and a working session is mostly closed
 * disclosures: measured on a real 179-turn session, 2026-08-20, the page held 1,100 of them, **none
 * open**, and 2.0 MB of the 2.7 MB of text on that page was inside them. Three quarters of what it
 * cost to draw the session was content nobody had asked to see.
 *
 * The body is built from the block, which the client already holds, so opening one is a few
 * milliseconds of the same code that used to run at load. The build closure captures what it needs
 * and is dropped after one call — `filled` is the latch, because `toggle` fires on every open.
 *
 * What this gives up: the browser's own find-in-page can no longer reach text inside a disclosure
 * that has never been opened. It could before — Chrome expands a `<details>` to show a match. Stated
 * here rather than discovered later.
 */
function lazyBody(details: HTMLDetailsElement, build: () => Node[]): void {
  let filled = false;
  const fill = (): void => {
    if (filled) return;
    filled = true;
    details.append(...build());
  };
  // A disclosure the reader had already opened comes back open (146), and it comes back FULL: the
  // whole point of remembering it is that it looks the way they left it.
  if (details.open) {
    fill();
    return;
  }
  details.addEventListener("toggle", () => {
    if (details.open) fill();
  });
}

function renderTool(block: Block, result: Block | undefined): HTMLElement {
  const name = block.name ?? "tool";
  const details = el("details", "tool");
  remember(details, block.id === undefined ? [] : [`tool:${block.id}`], false);
  if (result?.isError === true) details.classList.add("error");

  const summary = el("summary");
  summary.append(el("span", "tname", name));
  summary.append(el("span", "tsum", truncate(summariseTool(name, block.input).replace(/\s+/g, " "), 200)));
  details.append(summary);

  lazyBody(details, () => {
    const parts: Node[] = [];
    const inputPre = el("pre");
    inputPre.append(el("span", "label", "input\n"));
    inputPre.append(document.createTextNode(JSON.stringify(block.input, null, 2) ?? ""));
    parts.push(inputPre);

    if (result !== undefined) {
      const outPre = el("pre");
      outPre.append(el("span", "label", result.isError === true ? "error\n" : "result\n"));
      outPre.append(document.createTextNode(truncate(result.text ?? "", 20000)));
      parts.push(outPre);
    }
    return parts;
  });
  return details;
}

/** Render one turn (a group from groupTurns) as a single article. */
/**
 * Whether a text block is a reminder being held back. Pulled out of `renderTurn` so the rule can be
 * stated without a DOM: `bun test` has no `document`, and a rule only checkable in a browser gets
 * checked less often than one that is not.
 */
export function hiddenReminder(text: string, showMeta: boolean): boolean {
  if (showMeta) return false;
  return text.trimStart().startsWith("<system-reminder>");
}

export function renderTurn(turn: readonly Message[], options: RenderOptions): HTMLElement | null {
  const first = turn[0];
  if (first === undefined) return null;

  const wrap = el("article", `msg ${first.role}`);
  wrap.dataset["uuid"] = first.uuid;
  // What the redraw reconciles on (211): which row this is, and whether it would come out the same.
  wrap.dataset["drawKey"] = `turn:${first.uuid}`;
  wrap.dataset["drawSig"] = turnSignature(turn, options);
  wrap.id = `m-${first.uuid}`;
  if (first.isMeta) wrap.classList.add("meta");
  if (options.pinned) wrap.classList.add("pinned");
  // The ANSWER of a turn (SPEC 190): the row the CLI stopped on, which is the row `stop_reason`
  // already identifies for the tree's envelope. It is a mark in the margin and NOTHING else — v7
  // gave it a white card and dimmed the working steps around it, and User rejected that in four
  // words. The class is on the turn because a turn renders as one article; the working rows inside
  // it keep every pixel of their styling.
  if (first.role === "assistant" && turn[turn.length - 1]?.endsTurn === true) wrap.classList.add("answer");

  const head = el("div", "msg-head");
  head.append(el("span", "who", first.role === "user" ? "you" : first.role));
  if (first.ts.length > 0) {
    const time = new Date(first.ts);
    if (!Number.isNaN(time.getTime())) {
      head.append(el("span", "when", time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
    }
  }
  const pin = el("button", `pin-btn${options.pinned ? " on" : ""}`, options.pinned ? "★" : "☆");
  pin.title = options.pinned ? "Unpin" : "Pin to index";
  pin.dataset["pin"] = first.uuid;
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    options.onPin(first.uuid, !options.pinned);
  });
  head.append(pin);
  const cost = turnCostLabel(turn, options.scale ?? 0);
  if (cost !== null) {
    const costSpan = el("span", `cost${cost.loud ? " loud" : ""}`, cost.text);
    costSpan.title = cost.title;
    head.append(costSpan);
  }
  wrap.append(head);

  // Runs of consecutive tool calls fold into one strip, because a working turn is 90% machinery by
  // height and the prose is what is being read. A call whose result is an ERROR never folds: the one
  // thing you always want visible is the step that failed.
  let run: Block[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    // Captured, then the field is cleared: the closure below outlives this call, and a `run` it
    // shared with the next strip would fill the first one with the second one's calls.
    const calls = run;
    run = [];
    const build = (b: Block): HTMLElement =>
      renderTool(b, b.id !== undefined ? options.results.get(b.id) : undefined);
    if (calls.length < FOLD_AT) {
      for (const block of calls) wrap.append(build(block));
      return;
    }
    const strip = el("details", "steps");
    // READ from the run's first call, WRITTEN to every call in it (212). Reading from the head is
    // what lets a growing run keep its identity as calls arrive; writing to the whole membership
    // is what carries an open list through the run splitting around a failed call.
    remember(
      strip,
      calls.flatMap((b) => (b.id === undefined ? [] : [`run:${b.id}`])),
      false,
    );
    const summary = el("summary");
    summary.append(el("span", "srun", summariseRun(calls.map((b) => b.name ?? "tool"))));
    strip.append(summary);
    // A folded strip is the densest thing on the page — a dozen calls, each with its input and its
    // result, under one closed summary. Building none of it until the strip opens is where most of
    // the saving lives (SPEC 229).
    lazyBody(strip, () => {
      const inner = el("div", "inner");
      for (const block of calls) inner.append(build(block));
      return [inner];
    });
    wrap.append(strip);
  };

  let thoughts = 0;
  for (const block of turn.flatMap((m) => m.blocks)) {
    if (block.kind === "text") {
      // A reminder block is context the harness put in front of his words, not something he typed —
      // and from SPEC §Recap onward one of them IS the previous session's recap, riding in the same
      // turn so it never becomes an assistant turn of its own. `detectMeta` already hides a row that
      // is ENTIRELY reminders; this hides the block when it sits alongside real text, which is the
      // shape the recap actually takes. Same rule as `meta`: shown when he asks to see the noise.
      if (hiddenReminder(block.text ?? "", options.showMeta === true)) continue;
      flushRun();
      wrap.append(renderMarkdown(block.text ?? "", options.ctx, { breaks: true }));
    } else if (block.kind === "thinking") {
      // Hidden means HIDDEN. Rendering a collapsed stub per thinking block put ten empty grey rows
      // in every turn while telling the reader nothing — the noise the toggle exists to remove.
      if (!options.showThinking) continue;
      flushRun();
      const details = el("details", "thinking");
      // A thinking block carries no id, so it is keyed by its place in the turn — which only shifts
      // if the turn's own earlier blocks change, and by then it is a different thought anyway.
      thoughts += 1;
      remember(details, [`think:${first.uuid}#${thoughts}`], true);
      details.append(el("summary", undefined, "thinking"));
      const inner = el("div", "inner");
      inner.append(renderMarkdown(block.text ?? "", options.ctx, { breaks: true }));
      details.append(inner);
      wrap.append(details);
    } else if (block.kind === "tool_use") {
      const failed = block.id !== undefined && options.results.get(block.id)?.isError === true;
      if (failed) {
        flushRun();
        const node = renderTool(block, block.id !== undefined ? options.results.get(block.id) : undefined);
        wrap.append(node);
      } else {
        run.push(block);
      }
    } else if (block.kind === "tool_result" && block.forId !== undefined && !options.results.has(block.forId)) {
      // Orphan result (its call was compacted away) — show it rather than silently dropping it.
      flushRun();
      const pre = el("pre");
      pre.textContent = truncate(block.text ?? "", 8000);
      wrap.append(pre);
    } else if (block.kind === "image" && block.mediaType !== undefined && block.data !== undefined) {
      // A pasted image renders as itself — the transcript already carries the bytes.
      flushRun();
      const img = document.createElement("img");
      img.className = "msg-image zoomable";
      img.src = `data:${block.mediaType};base64,${block.data}`;
      img.alt = "attached image";
      wrap.append(img);
    }
  }
  flushRun();

  return wrap;
}

/**
 * A message's own words — what HE typed, joined and trimmed. The rule for matching a transcript row
 * against a queue entry, and for placing it by the time it was accepted.
 *
 * Lives here rather than in `app.ts` for the same reason `hiddenReminder` does: `bun test` has no
 * `document`, and a rule only checkable in a browser gets checked less often than one that is not.
 */
/**
 * What a turn WEIGHS, without rendering it — the input to the window's height estimate (SPEC 228).
 *
 * Counted off the blocks the client already holds, so a session of five thousand turns can be
 * measured in a few milliseconds of arithmetic instead of a layout pass.
 */
export function turnBulk(turn: readonly Message[]): { chars: number; tools: number; images: number } {
  let chars = 0;
  let tools = 0;
  let images = 0;
  for (const message of turn) {
    for (const block of message.blocks) {
      if (block.kind === "text" || block.kind === "thinking") chars += (block.text ?? "").length;
      else if (block.kind === "tool_use") tools += 1;
      else if (block.kind === "image") images += 1;
    }
  }
  return { chars, tools, images };
}

/**
 * Does this turn carry an embedded artifact — a build plan, a framed prototype (SPEC 192)?
 *
 * Read from the FENCE, not from the DOM. The gutter used to ask each row on screen whether it
 * contained a `.rich-plan`, which stopped being possible the moment most turns are not on screen
 * (SPEC 228): a point for a plan five hundred turns back has to exist before that turn is mounted,
 * or the gutter is a map of the window rather than of the session.
 *
 * The fence test is the same one `markdown.ts` applies — the info string's first word, against the
 * block registry — so the two cannot disagree about what a plan is. `journey21-gutter` drives that
 * agreement in a browser rather than trusting this sentence: it collects every `.rich-plan` /
 * `.rich-iframe` the RENDERER produces over a full scroll and counts them against the points.
 */
export function turnArtifacts(turn: readonly Message[]): { plan: boolean; proto: boolean } {
  let plan = false;
  let proto = false;
  for (const message of turn) {
    for (const block of message.blocks) {
      if (block.kind !== "text") continue;
      const text = block.text ?? "";
      // The prefilter is what makes this affordable to run over a WHOLE session at open: a
      // substring search runs at memory speed, and only a block that already contains the word
      // pays for the regex that decides whether it is really an opening fence.
      if (!text.includes("plan") && !text.includes("iframe")) continue;
      for (const match of text.matchAll(/^ {0,3}(?:```+|~~~+)[ \t]*([^\s`~]+)/gm)) {
        const tag = match[1] ?? "";
        if (tag === "plan") plan = true;
        else if (tag === "iframe") proto = true;
      }
    }
  }
  return { plan, proto };
}

export function spokenText(message: Message): string {
  return message.blocks
    .filter((b) => b.kind === "text")
    .map((b) => b.text ?? "")
    // What the app carried in front of him is not what he said. The recap rides INSIDE his first
    // message (requirement 175), and counting it made that message match no queue entry — so the
    // queued copy was drawn beside the real one for the rest of the session (requirement 210).
    // The same rule the screen uses to hide it, so the two can never disagree.
    .filter((text) => !hiddenReminder(text, false))
    .join("")
    .trim();
}

/** Plain text of a message or a whole turn, for search and rail labels. */
export function messageText(message: Message | readonly Message[]): string {
  const list = Array.isArray(message) ? message : [message as Message];
  return list
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}
