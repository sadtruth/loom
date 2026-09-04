/**
 * The file pane — a file opens INSIDE loom instead of being thrown at Obsidian or Finder.
 *
 * User, 2026-08-01: *"i want files from the panel to open there in loom in a split screen and not
 * somewhere else"*. Clicking a path used to leave the app, which breaks the read: you lose the
 * transcript position and land in another window. The Obsidian/Finder hand-off is still available,
 * but as a button in the pane rather than the only behaviour.
 *
 * It was a column beside the transcript until SPEC 189. Now it IS the centre, at full width, as a
 * member of the open set — so the head that used to sit above the scroller is rendered INSIDE it,
 * as the first thing there, and scrolls away with the content.
 */

import DOMPurify from "dompurify";
import { labelChips, makeChip, renderMarkdown } from "./markdown.ts";
import { highlightLines, languageOf } from "./highlight.ts";
import type { BlockContext } from "./blocks.ts";
import { embedPage } from "./embed.ts";

interface FileResponse {
  path: string;
  kind: "markdown" | "text" | "dir" | "page" | "pdf" | "download";
  truncated?: boolean;
  bytes: number;
  text: string;
  /** Present for `kind: "dir"` — one row per entry, directories first (SPEC 141). */
  entries?: Array<{ name: string; dir: boolean; bytes: number }>;
}

export interface PaneHandles {
  layout: HTMLElement;
  /** Name, path and actions. Lives INSIDE `body` and is re-appended above every render. */
  head: HTMLElement;
  title: HTMLElement;
  path: HTMLElement;
  body: HTMLElement;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|heic|heif|tif|tiff)$/i;

function base(path: string): string {
  return path.split("/").filter((s) => s.length > 0).slice(-1)[0] ?? path;
}

/** The path currently in the pane, so a second click on the same row is a no-op rather than a flash. */
let current: string | null = null;

/**
 * What loom may read, and where it is running — for the refusal below, which is the one place a
 * reader needs both. Set once at boot from `/api/roots`; empty until then, and the refusal simply
 * omits the list rather than guessing at it.
 */
let environment: { roots: string[]; host: string } = { roots: [], host: "" };

export function setEnvironment(next: { roots: string[]; host: string }): void {
  environment = next;
}

/**
 * A refusal that names a way out (link kind 12).
 *
 * `403 — outside loom's readable roots` was honest and a dead end: it did not say which roots, and
 * it did not say what to do instead. So the note now names what was checked, and offers the one
 * action that legitimately reaches outside them — handing the path to the machine loom runs on. The
 * button is a button, not a chip, because it LEAVES loom; `app.ts` picks it up by class.
 */
function refusal(status: number, reason: string, path: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "file-note file-refusal";
  box.append(Object.assign(document.createElement("p"), { textContent: `${status} — ${reason}` }));
  if (status === 403 && environment.roots.length > 0) {
    const roots = document.createElement("p");
    roots.className = "file-roots";
    roots.textContent = `loom reads: ${environment.roots.join(" · ")}`;
    box.append(roots);
  }
  if (status === 403 || status === 415) {
    const hand = document.createElement("button");
    hand.className = "file-handoff";
    hand.dataset["path"] = path;
    hand.textContent = environment.host.length > 0 ? `open it on ${environment.host}` : "open it on the server";
    box.append(hand);
  }
  return box;
}

export function openPath(): string | null {
  return current;
}

export function closePane(handles: PaneHandles): void {
  current = null;
  handles.layout.classList.remove("file-open");
  // The head is a child of the scroller now, so clearing the body would throw it away.
  handles.body.replaceChildren(handles.head);
}

/**
 * Fetch and show a file. Every failure lands in the pane as text — a pane that silently stays empty
 * is indistinguishable from a pane that is broken, and the guard's refusals (403 outside a readable
 * root) are exactly what a reader needs to see.
 */
export async function showFile(
  handles: PaneHandles,
  path: string,
  ctx: BlockContext,
  place?: string,
  /** The session's cwd — a relative `path` is resolved against it and its ancestors (SPEC 143). */
  from?: string,
  /** The record on screen — the second ladder, tried when the session's own misses (SPEC 245). */
  record?: string,
): Promise<void> {
  current = path;
  handles.layout.classList.add("file-open");
  // Until the server answers, a relative path is SHOWN joined to the session directory — the
  // reader's best guess at what was clicked, and the header never reads as a bare fragment. The
  // real answer replaces it below; a refusal leaves the guess, which is what the error is about.
  // A `wiki:Name` target names a note rather than a place, so there is nothing to join a cwd to —
  // the server answers with the path it found and the header is rewritten from that (kind 11).
  const wiki = path.startsWith("wiki:") ? path.slice("wiki:".length) : null;
  const guess = wiki !== null
    ? wiki
    : from !== undefined && !path.startsWith("/") && !path.startsWith("~")
      ? `${from.replace(/\/+$/u, "")}/${path}`
      : path;
  handles.title.textContent = base(guess);
  handles.path.textContent = guess;
  handles.path.dataset["path"] = guess;
  show(handles, Object.assign(document.createElement("p"), {
    className: "file-note",
    textContent: "loading…",
  }));

  const query = wiki !== null
    ? `wiki=${encodeURIComponent(wiki)}`
    : `path=${encodeURIComponent(path)}${from === undefined ? "" : `&base=${encodeURIComponent(from)}`}` +
      `${record === undefined ? "" : `&record=${encodeURIComponent(record)}`}`;

  if (IMAGE.test(path)) {
    const img = document.createElement("img");
    img.className = "file-image zoomable";
    img.src = `/api/file?${query}`;
    img.alt = path;
    show(handles, img);
    return;
  }

  let response: Response;
  try {
    response = await fetch(`/api/file?${query}`);
  } catch (error) {
    show(handles, note(`could not read: ${String(error)}`));
    return;
  }
  if (!response.ok) {
    show(handles, refusal(response.status, await response.text(), guess));
    return;
  }

  const file = (await response.json()) as FileResponse;
  if (current !== path) return; // a faster second click won the race

  // The server answers with the path it actually resolved, which for a relative chip is not the one
  // asked for. The header says the real file, and the directory walk builds children from it —
  // otherwise "↑ up" from a relative chip would climb a path that does not exist (SPEC 143).
  const shown = file.path.length > 0 ? file.path : path;
  current = shown;
  handles.title.textContent = base(shown);
  handles.path.textContent = shown;
  handles.path.dataset["path"] = shown;

  // A directory is a list of chips, so opening one composes with everything else: each row is the
  // same chip the transcript renders, and clicking it walks down (or back up) without leaving loom.
  if (file.kind === "dir") {
    const list = document.createElement("div");
    list.className = "file-dir";
    const parent = shown.replace(/\/+$/u, "").replace(/\/[^/]*$/u, "");
    if (parent.length > 0) list.append(row(makeChip(`${parent}/`, "↑ up")));
    for (const entry of file.entries ?? []) {
      const child = `${shown.replace(/\/+$/u, "")}/${entry.name}`;
      const chip = makeChip(entry.dir ? `${child}/` : child);
      const line = row(chip);
      if (!entry.dir) {
        const size = document.createElement("span");
        size.className = "file-dir-size";
        size.textContent = readableBytes(entry.bytes);
        line.append(size);
      }
      list.append(line);
    }
    if ((file.entries ?? []).length === 0) list.append(note("empty directory"));
    show(handles, list);
    labelChips(list, ctx.records);
    return;
  }

  // An `.html` file is a PAGE, not a listing of its own markup (item 10). `embedPage` is the same
  // sandboxed frame a plan block's prototype uses — it grows to the document's own height and
  // carries the way out to a tab under it — so the pane and the plan cannot drift apart. User,
  // 2026-08-24: *"i dont really need to see the source of prototype … maybe even never"*, so there
  // is no switch: the source is reachable the way any other file's is, through the editor.

  if (file.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "file-embed";
    frame.src = `/api/file?${query}&raw=1`;
    show(handles, frame);
    return;
  }

  if (file.kind === "download") {
    const box = document.createElement("div");
    box.className = "file-note file-download";
    box.append(Object.assign(document.createElement("p"), { textContent: `${base(shown)} (${readableBytes(file.bytes)})` }));

    const actions = document.createElement("div");
    actions.className = "file-roots";

    const rawLink = document.createElement("a");
    rawLink.href = `/api/file?${query}&raw=1`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw in tab";

    const dlLink = document.createElement("a");
    dlLink.href = `/api/file?${query}&raw=1`;
    dlLink.download = base(shown);
    dlLink.textContent = "download";

    actions.append(rawLink, " · ", dlLink);
    box.append(actions);

    show(handles, box);
    return;
  }

  if (file.kind === "page") {
    show(handles, embedPage(shown, ""));
    return;
  }

  let container: HTMLElement | null = null;
  if (file.truncated) {
    container = document.createElement("div");
    const truncNote = note("");
    truncNote.textContent = `showing the first 2 MB of ${readableBytes(file.bytes)} — `;
    const rawLink = document.createElement("a");
    rawLink.href = `/api/file?${query}&raw=1`;
    rawLink.target = "_blank";
    rawLink.textContent = "open raw";
    truncNote.append(rawLink);
    container.append(truncNote);
  }

  if (file.kind === "markdown") {
    const article = document.createElement("article");
    article.className = "file-md";
    // `lines: true` — the rendered blocks carry the source line they start at, so a `:86` chip can
    // land inside a record instead of reporting that the file has no such line (item 13).
    article.append(renderMarkdown(file.text, ctx, { lines: true }));

    if (container) {
      container.append(article);
      show(handles, container);
    } else {
      show(handles, article);
    }

    if (place !== undefined) landOn(handles, article, place);
    return;
  }

  const cv = codeView(shown, file.text);
  if (container) {
    container.append(cv);
    show(handles, container);
  } else {
    show(handles, cv);
  }

  if (place !== undefined) landOn(handles, handles.body, place);
}

/**
 * A code file as an editor draws it: highlighted, one row per line, numbered (SPEC 144).
 *
 * Rows are real elements rather than one blob of text because a `:120` chip has to LAND on a line,
 * and because a number gutter needs something to sit beside. The number is a `::before` off
 * `data-line`, so selecting the code never drags the numbers into the clipboard.
 */
function codeView(path: string, text: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "file-text";
  const code = document.createElement("code");
  const lines = highlightLines(text, languageOf(path));
  // Trailing newline: a file ending in "\n" splits into a last empty line that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  // Sanitised even though every path into it is already escaped: this is the one place in the pane
  // that assigns innerHTML from file CONTENT, and a grammar with a bug must not become an injection.
  code.innerHTML = DOMPurify.sanitize(
    lines.map((html, i) => `<span class="file-row" data-line="${i + 1}">${html}\n</span>`).join(""),
    { ALLOWED_TAGS: ["span"], ALLOWED_ATTR: ["class", "data-line"] },
  );
  pre.append(code);
  return pre;
}

/** The head first, then what was read: one place puts the scroller's contents in order. */
function show(handles: PaneHandles, content: HTMLElement): void {
  handles.body.replaceChildren(handles.head, content);
}

function row(chip: HTMLElement): HTMLElement {
  const line = document.createElement("div");
  line.className = "file-dir-row";
  line.append(chip);
  return line;
}

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
}

/** Slug-compare, so `#path-chips` finds "## Path chips" without the file carrying anchors. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "");
}

/**
 * Scroll to the place a chip named — a heading in a rendered document, or a line in plain text.
 *
 * The flash is the same one a pin jump uses: landing silently in the middle of a long file leaves
 * the reader to work out why the scroll moved.
 */
function landOn(handles: PaneHandles, body: HTMLElement, place: string): void {
  let target: HTMLElement | null = null;

  if (place.startsWith("#")) {
    const want = slug(place.slice(1));
    for (const heading of body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")) {
      if (slug(heading.textContent ?? "") === want) {
        target = heading;
        break;
      }
    }
  } else {
    // A line is already an element (SPEC 144), so landing is a lookup. It used to be a rebuild of
    // the whole pre around a wrapped line — which highlighted markup would not have survived.
    //
    // A RANGE lands on its first line and marks the whole span (link kind 7). Marking only the first
    // one would be indistinguishable from having silently dropped the range, which is what the old
    // code did.
    const [head, tail] = place.slice(1).split("-");
    const line = Number.parseInt(head ?? "", 10);
    const last = Number.parseInt(tail ?? "", 10);
    const row = Number.isFinite(line) ? body.querySelector<HTMLElement>(`.file-row[data-line="${line}"]`) : null;
    // A RENDERED document has no rows — its blocks carry the line each one STARTS at, so the block
    // holding line 86 is the last one that starts at or before it (item 13, User's option A).
    if (row === null && Number.isFinite(line)) {
      const block = blockHolding(body, line);
      if (block !== null) {
        block.classList.add("file-line");
        target = block;
      }
    }
    if (row !== null) {
      row.classList.add("file-line");
      target = row;
      const end = Number.isFinite(last) && last > line ? last : line;
      for (let n = line; n <= end; n += 1) {
        body.querySelector<HTMLElement>(`.file-row[data-line="${n}"]`)?.classList.add("file-line");
      }
    }
  }

  if (target === null) {
    handles.head.after(note(`no ${place} in this file`));
    return;
  }
  target.scrollIntoView({ block: "center" });
  target.classList.add("jumped");
}

/**
 * The rendered block that owns a source line: the last one starting at or before it. A line inside
 * a six-line work item lands on the item, which is what "land on the line" means once the document
 * is prose rather than rows.
 */
function blockHolding(body: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLine = 0;
  for (const block of body.querySelectorAll<HTMLElement>("[data-line]")) {
    if (block.classList.contains("file-row")) continue; // a source row, handled above
    const at = Number.parseInt(block.dataset["line"] ?? "", 10);
    if (!Number.isFinite(at) || at > line || at < bestLine) continue;
    best = block;
    bestLine = at;
  }
  return best;
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "file-note";
  p.textContent = text;
  return p;
}
