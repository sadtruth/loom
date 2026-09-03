/**
 * Markdown -> sanitised DOM, then the path-chip pass. SPEC §5/§12/§13.
 *
 * ORDER MATTERS: sanitise first, then walk TEXT NODES ONLY for paths. Doing it the other way round
 * would let a path-shaped string in model output inject markup. The chip pass cannot reintroduce
 * markup because it never parses HTML — it splits text nodes and appends elements.
 *
 * Paths are never hrefs. That is the whole point of the project: an href needs escaping, and
 * "only space-free paths render" is exactly the breakage this replaces.
 */

import { Marked } from "marked";
import DOMPurify from "dompurify";
import { isRichTag, renderRich, type BlockContext } from "./blocks.ts";
import { extractPaths, looksLikePath } from "./paths.ts";
import { labelChips, placeMark, splitPlace } from "./chips.ts";
import { highlightLines } from "./highlight.ts";

export { labelChips };

/**
 * DOMPurify's default scheme list, plus `file:` (link kind 20).
 *
 * Without it the sanitiser strips the href before anything can read it, so a `file://` link arrived
 * as an anchor pointing nowhere and `chipPathLinks` had nothing to convert. Letting it through is
 * safe here because it is converted to a CHIP in the same render — the href never survives — and
 * because a `file:` URL cannot execute: the browser refuses to navigate one from an http page,
 * which is the whole reason this kind was broken in the first place.
 */
const URI_SCHEMES = /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const RICH_ATTR = "data-rich";
const richSources = new Map<string, { tag: string; source: string }>();
let richSeq = 0;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const marked = new Marked({
  gfm: true,
  renderer: {
    // Rich tags become a slot hydrated after sanitisation; everything else gets the ordinary
    // code-block output, written out here rather than relying on marked's fall-through sentinel.
    code({ text, lang }): string {
      const tag = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      if (isRichTag(tag)) {
        const id = `r${(richSeq += 1)}`;
        richSources.set(id, { tag, source: text });
        return `<div class="rich-slot" ${RICH_ATTR}="${id}"></div>`;
      }
      const cls = tag.length > 0 ? ` class="language-${escapeHtml(tag)}"` : "";
      return `<pre><code${cls}>${highlightLines(text, tag.length > 0 ? tag : null).join("\n")}\n</code></pre>`;
    },
  },
});

/**
 * A chip carries three things: what the reader wrote (`data-raw`), what the server may be asked for
 * (`data-path`, raw and never encoded — SPEC §12–13), and where inside it to land (`data-place`).
 *
 * The label is NOT decided here. `labelChips()` below owns it, because the rule needs two things a
 * single chip cannot see: the record list (which may arrive after this render) and its sibling chips
 * (a filename is only ambiguous relative to the others on screen).
 */
export function makeChip(raw: string, label?: string): HTMLAnchorElement {
  const chip = document.createElement("a");
  chip.className = "chip";
  chip.dataset["raw"] = raw;
  chip.dataset["path"] = raw; // RAW path — never encoded into an href
  chip.href = "#";
  chip.title = raw;
  chip.textContent = label ?? raw.split("/").slice(-1)[0] ?? raw;
  if (label !== undefined) chip.dataset["fixed"] = "1"; // a caller's own label is not ours to redo
  return chip;
}

/**
 * `:120`, `:120:5` or `#a-heading` immediately after a path. Bounded on the right so a sentence
 * cannot be swallowed: a heading reference stops at whitespace, and `see /a/b.md: it says` is a
 * colon followed by prose, not a line number.
 */
/**
 * `:120`, `:120:5`, `:120-140` or `#a-heading` immediately after a path — and `#next 12`, which is
 * the one place-form carrying a SPACE.
 *
 * The work-item form is spelled out rather than allowed generally, because a general "letters, then
 * a space, then more" would eat the sentence after any heading reference. `CLAUDE.md` rule 45
 * mandates exactly this shape for a task link, so every task link written to User since the rule
 * landed was dead: the suffix never matched, the chip never carried the place, and the click entered
 * the project and stopped there (link kind 17).
 */
const PLACE_SUFFIX = /^(?::\d+(?:[:-]\d+)?|#(?:next\s+\d+|[\p{L}\p{N}_-]+))(?![^\s.,;:!?)\]}»…])/u;

/**
 * Directories loom already knows about, longest first — the tiebreak for a space inside a final
 * segment (`paths.ts`, `longestKnownPrefix`).
 *
 * Only ancestors that CONTAIN a space are worth listing: a segment walk already gets every other
 * shape right, so the list stays a handful of entries even with a hundred records. Derived from the
 * record list that is in memory anyway — no request, no disk, and the same answer on every machine.
 */
export function knownDirs(records: readonly { path: string }[]): string[] {
  const out = new Set<string>();
  for (const record of records) {
    const parts = record.path.split("/");
    parts.pop(); // the record file itself
    for (let i = parts.length; i > 1; i -= 1) {
      const dir = parts.slice(0, i).join("/");
      if (dir.includes(" ")) out.add(dir);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function chipTextNodes(root: HTMLElement, known: readonly string[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const parent = node.parentElement;
    if (parent !== null && !parent.closest("pre, code, a, .chip")) targets.push(node as Text);
    node = walker.nextNode();
  }

  for (const text of targets) {
    const value = text.nodeValue ?? "";
    const matches = extractPaths(value, known);
    if (matches.length === 0) continue;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) frag.append(value.slice(cursor, match.start));
      // A place suffix is picked up HERE rather than in `paths.ts`: the extractor cuts a candidate
      // at the earliest known extension, so `app.ts:2911` reaches us as `app.ts` with the line left
      // behind in the prose. Reading it back off the following text extends the chip without
      // touching the space-in-path rules, which are not this project's to re-decide.
      const suffix = PLACE_SUFFIX.exec(value.slice(match.end))?.[0] ?? "";
      frag.append(makeChip(match.path + suffix));
      cursor = match.end + suffix.length;
    }
    if (cursor < value.length) frag.append(value.slice(cursor));
    text.replaceWith(frag);
  }
}

/** An inline-code span that is really a path becomes a chip (SPEC §12) — covers relative paths. */
export function chipCodeSpans(root: HTMLElement | any): void {
  for (const code of [...root.querySelectorAll("code")]) {
    if (code.closest("pre") !== null) continue;
    const text = code.textContent ?? "";
    if (!looksLikePath(text)) continue;
    const raw = text.trim();
    // A DIRECTORY gets no fixed label, so the chip rule can read it as one and give it the folder
    // glyph — the label it would compute is the same string anyway (link kind 5). Everything else
    // keeps the text as written: an inline-code path is quoted deliberately.
    code.replaceWith(raw.endsWith("/") ? makeChip(raw) : labelledChip(raw));
  }
}

/**
 * A link that leaves loom opens a NEW TAB, never this one.
 *
 * The chip work is all about not losing your place; a plain `https://` anchor threw the whole
 * session view away on one click, and with back-restore still unbuilt there was nothing to come
 * back to (2026-08-10). `noopener` because a new tab that can reach back into `window.opener` is a
 * gift to whatever the model happened to link.
 */
function externalLinks(root: HTMLElement): void {
  for (const anchor of [...root.querySelectorAll("a")]) {
    const href = anchor.getAttribute("href") ?? "";
    if (!/^(?:https?|mailto):/i.test(href)) continue;
    // A link to LOOM is not an external link (kind 9). It used to be caught here and opened a second
    // loom in a new tab, booting from scratch — a link User sends himself between devices, or one
    // I write to a place in his own workspace, should walk there in the tab he is already in. The
    // click handler in `app.ts` does the walking; this only says which anchors are loom's own.
    if (/^https?:/i.test(href) && sameOrigin(href)) {
      anchor.dataset["loom"] = "1";
      continue;
    }
    anchor.classList.add("ext");
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
}

function sameOrigin(href: string): boolean {
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * `[[A note]]`, `[[A note#heading]]`, `[[A note|shown like this]]` — how the vault links to itself
 * (link kind 11).
 *
 * The file pane renders vault markdown, and nothing handled the double-bracket form, so walking from
 * one note to the next dead-ended. A wikilink names a note by NAME rather than by path, so the chip
 * carries `wiki:<name>` and the server does the lookup at click time — which is allowed, because a
 * click is already a request. It is not the chip pass asking the disk what to render (223): the
 * double brackets are the declaration, and the chip is drawn whether or not the note exists.
 */
const WIKILINK = /\[\[([^\]|#\n]+?)(#[^\]|\n]+?)?(?:\|([^\]\n]+?))?\]\]/gu;

function wikiLinks(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node = walker.nextNode();
  while (node !== null) {
    const parent = node.parentElement;
    if (parent !== null && !parent.closest("pre, code, a, .chip")) targets.push(node as Text);
    node = walker.nextNode();
  }

  for (const text of targets) {
    const value = text.nodeValue ?? "";
    if (!value.includes("[[")) continue;
    WIKILINK.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const match of value.matchAll(WIKILINK)) {
      const name = (match[1] ?? "").trim();
      if (name.length === 0) continue;
      const at = match.index ?? 0;
      if (at > cursor) frag.append(value.slice(cursor, at));
      const place = match[2]?.trim() ?? "";
      const chip = makeChip(`wiki:${name}${place}`, match[3]?.trim() ?? name);
      chip.classList.add("wiki");
      frag.append(chip);
      cursor = at + match[0].length;
    }
    if (cursor === 0) continue;
    if (cursor < value.length) frag.append(value.slice(cursor));
    text.replaceWith(frag);
  }
}

/**
 * A chip whose label the caller supplies — a markdown link's text, or an inline-code path.
 *
 * `labelChips` never touches these (they carry `data-fixed`), and `labelChips` was the ONLY place
 * that split a place off a path. So `[item 10](…/project.md:86)` asked the server for a file whose
 * name ends in `:86` and got a 400 — 147 links in the 2026-08-24 audit, including every task link
 * the constitution's rule 45 mandates. Splitting here is the fix: the place is a property of the
 * path, not of the labelling.
 */
export function labelledChip(raw: string, label?: string): HTMLAnchorElement {
  const { path, place } = splitPlace(raw);
  const explicitLabel = (label === raw || label === undefined) ? undefined : label;
  const chip = makeChip(path, explicitLabel);
  chip.dataset["raw"] = raw; // what was written, for the title and for any later relabelling
  chip.title = raw;
  const mark = placeMark(place);
  if (mark !== null) chip.dataset["place"] = mark;
  return chip;
}

/** A markdown link whose href is a filesystem path becomes a chip keeping its link text. */
export function chipPathLinks(root: HTMLElement | any): void {
  for (const anchor of [...root.querySelectorAll("a")]) {
    const href = anchor.getAttribute("href") ?? "";
    // `file:///home/user/x.md` is an ordinary path wearing a scheme (link kind 20). The browser
    // refuses to navigate one from an http page, so left alone it opened a tab and died there.
    const bare = /^file:\/\//i.test(href) ? href.replace(/^file:\/\//i, "") : href;
    if (/^[a-z]+:/i.test(bare) || bare.startsWith("#")) continue;
    let decoded = bare;
    try {
      decoded = decodeURIComponent(bare);
    } catch {
      // A malformed escape is a literal path, not an error.
    }
    if (!looksLikePath(decoded)) continue;
    anchor.replaceWith(labelledChip(decoded, anchor.textContent ?? decoded));
  }
}

function hydrateRich(root: HTMLElement, ctx: BlockContext): void {
  for (const slot of [...root.querySelectorAll(`[${RICH_ATTR}]`)]) {
    const id = slot.getAttribute(RICH_ATTR) ?? "";
    const entry = richSources.get(id);
    if (entry === undefined) continue;
    richSources.delete(id);
    slot.replaceWith(renderRich(entry.tag, entry.source, ctx));
  }
}

/**
 * The same HTML, with each top-level block carrying the SOURCE LINE it starts at.
 *
 * A rendered record has no lines — that is the whole point of rendering it — so a `project.md:86`
 * chip had nothing to land on and reported "no :86 in this file" for every one of the 44 such links
 * in the 2026-08-24 audit (item 13). User chose landing on the item the line is inside over
 * dropping the record to source, so the line has to survive the render.
 *
 * Each top-level token is parsed on its own, carrying the full token list's link definitions so a
 * reference-style link still resolves. That gives an exact block-to-line map rather than an
 * alignment guessed after the fact from element order.
 */
/**
 * `marked.lexer(src, opt)` and `marked.parser(tokens, opt)` REPLACE this instance's options with the
 * object handed to them — they do not merge. So `{ breaks }` alone arrived with `gfm` undefined and
 * no renderer: GFM's table extension was never registered, and a table lexed as an ordinary
 * paragraph of pipe characters. User, 2026-08-28: *"tables on project page dont render correctly
 * — i cant read your table notes."* The rich-block renderer went the same way, so a ```plan fenced
 * in a FILE came out as a plain code block while the identical text in a record rendered the widget.
 * Spreading `marked.defaults` first keeps everything the constructor set up; `breaks` still wins.
 */
function withSourceLines(source: string, breaks: boolean): string {
  const options = { ...marked.defaults, breaks };
  const tokens = marked.lexer(source, options);
  const out: string[] = [];
  let line = 1;
  for (const token of tokens) {
    const start = line;
    line += (token.raw ?? "").split("\n").length - 1;
    if (token.type === "space" || token.type === "def") continue;
    const one = Object.assign([token], { links: tokens.links });
    const html = marked.parser(one, { ...options, async: false });
    // Onto the FIRST tag of the block. A top-level token always renders as an element — `<p>`,
    // `<h2>`, `<ul>`, `<pre>`, `<blockquote>`, `<table>`, `<hr>` — never as bare text.
    out.push(html.replace(/^(\s*<[a-zA-Z][^>]*?)(\s*\/?>)/u, `$1 data-line="${String(start)}"$2`));
  }
  return out.join("\n");
}

/**
 * `breaks` — chat turns pass true (a model's single newline means a break); records and files
 * keep standard markdown, where hard-wrapped prose reflows into paragraphs.
 */
export function renderMarkdown(
  source: string,
  ctx: BlockContext,
  opts: { breaks?: boolean; lines?: boolean } = {},
): HTMLElement {
  const host = document.createElement("div");
  host.className = "body";
  const raw = opts.lines === true
    ? withSourceLines(source, opts.breaks ?? false)
    : marked.parse(source, { async: false, breaks: opts.breaks ?? false });
  host.innerHTML = DOMPurify.sanitize(raw, { ADD_ATTR: [RICH_ATTR], ALLOWED_URI_REGEXP: URI_SCHEMES });
  hydrateRich(host, ctx);
  chipPathLinks(host);
  chipCodeSpans(host);
  chipTextNodes(host, knownDirs(ctx.records));
  // After the path pass, so a `[[…]]` never competes with it, and before the external one, which
  // only looks at anchors.
  wikiLinks(host);
  externalLinks(host);
  labelChips(host, ctx.records);
  return host;
}

/** First meaningful line, for the index rail. */
export function leadLine(source: string, max = 90): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const plain = trimmed
      .replace(/^#+\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/[*_`]/g, "");
    if (plain.length === 0) continue;
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
  }
  return "";
}

/** SPEC §14 — an assistant turn that opens with a bolded lead phrase is a verdict. */
export function isVerdict(source: string): boolean {
  return /^\s*\*\*[^*\n]+\*\*/.test(source);
}
