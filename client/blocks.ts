/**
 * Rich-block registry. SPEC §16/§17.
 *
 * A fenced block whose info string is in the registry renders as a component with its source kept
 * behind a toggle; anything unknown falls through to normal code rendering. The registry grows by
 * adding a renderer here, never by touching the markdown parser.
 */

import type { RecordLike } from "./chips.ts";
import { renderPlanBlock } from "./plan-block.ts";
import { embedPage } from "./embed.ts";

export type BlockRenderer = (source: string, ctx: BlockContext) => HTMLElement;

export interface BlockContext {
  /** Session cwd — relative image paths in a grid resolve against it. */
  cwd: string | null;
  /** Every scanned record, so a chip to one can say its TITLE rather than "project.md". */
  records: readonly RecordLike[];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = trimmed.includes("\t") ? trimmed.split("\t") : trimmed.split("|");
  return cells.map((c) => c.trim());
}

/** TSV or markdown-pipe rows; the first row is the header, a --- separator row is dropped. */
const renderTable: BlockRenderer = (source) => {
  const rows = source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^\|?[\s:|-]+\|?$/.test(l) || !l.includes("-"))
    .map(splitRow);

  const table = el("table");
  const [header, ...body] = rows;
  if (header !== undefined) {
    const thead = el("thead");
    const tr = el("tr");
    for (const cell of header) tr.append(el("th", undefined, cell));
    thead.append(tr);
    table.append(thead);
  }
  const tbody = el("tbody");
  for (const row of body) {
    const tr = el("tr");
    for (const cell of row) tr.append(el("td", undefined, cell));
    tbody.append(tr);
  }
  table.append(tbody);

  const wrap = el("div", "rich rich-table");
  wrap.append(table);
  return wrap;
};

/** One image per line: `path-or-url [| caption]`. */
const renderGrid: BlockRenderer = (source, ctx) => {
  const wrap = el("div", "rich");
  const grid = el("div", "rich-grid");
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [rawSrc = "", caption] = trimmed.split("|").map((p) => p.trim());
    if (rawSrc.length === 0) continue;

    const figure = el("figure");
    const img = el("img", "zoomable");
    img.loading = "lazy";
    img.alt = caption ?? rawSrc;
    if (/^https?:\/\//.test(rawSrc)) {
      img.src = rawSrc;
    } else {
      const abs = rawSrc.startsWith("/") ? rawSrc : ctx.cwd !== null ? `${ctx.cwd}/${rawSrc}` : rawSrc;
      img.src = `/api/file?path=${encodeURIComponent(abs)}`;
    }
    figure.append(img);
    if (caption !== undefined && caption.length > 0) figure.append(el("figcaption", undefined, caption));
    grid.append(figure);
  }
  wrap.append(grid);
  return wrap;
};

/**
 * `path-to-html-file [| height-px]` — a sandboxed live prototype. The document text comes through
 * /api/file (same guard as everything else) and lands in srcdoc; allow-scripts only, no same-origin,
 * so the embedded page can run but cannot reach the loom API or storage.
 *
 * The height is the FRAMED PAGE'S, not a number in the fence (SPEC 149). A literal is a scrollbar or
 * a field of dead space at every column width but one, and the right value cannot be known when the
 * message is written — User said so twice in an hour, then a third time when it recurred. The
 * frame cannot be measured from outside (no `allow-same-origin`, deliberately), so a few lines are
 * injected into the copy that goes into `srcdoc`: they post the document height up on load, on
 * resize, and whenever the content changes. The fence's number, when given, is only the height it
 * starts at while the document loads.
 */
const renderIframe: BlockRenderer = (source, ctx) => {
  const [rawPath = "", rawHeight] = source.trim().split("|").map((p) => p.trim());
  const wrap = el("div", "rich rich-iframe");
  if (rawPath.length === 0) return wrap;
  const abs = rawPath.startsWith("/") ? rawPath : ctx.cwd !== null ? `${ctx.cwd}/${rawPath}` : rawPath;
  // One frame builder for the whole app (`client/embed.ts`): the plan block shows prototypes too,
  // and two copies of the sandbox flags, the height protocol and the error text would drift.
  // A DECLARED number is also the answer for a document that fills whatever it is given, which is
  // why the fence's number and the placeholder are no longer the same fact (SPEC 214).
  const fenced = Number.parseInt(rawHeight ?? "", 10);
  const declared = Number.isFinite(fenced) && fenced > 0;
  wrap.append(embedPage(abs, "", declared ? fenced : undefined, declared));
  return wrap;
};

/**
 * `path` — the build plan at that path, drawn as a document (SPEC 147). The first kind whose
 * content lives in a FILE rather than in the fence, so the chat and the plan cannot drift.
 */
const renderPlan: BlockRenderer = (source, ctx) => renderPlanBlock(source, ctx.cwd, ctx.records);

export const REGISTRY: Record<string, BlockRenderer> = {
  table: renderTable,
  grid: renderGrid,
  iframe: renderIframe,
  plan: renderPlan,
};

export function isRichTag(tag: string): boolean {
  return Object.hasOwn(REGISTRY, tag);
}

/** Render a registered block plus its collapsed source. Unknown tags must never reach here. */
export function renderRich(tag: string, source: string, ctx: BlockContext): HTMLElement {
  const renderer = REGISTRY[tag];
  const wrap = el("div", "rich");
  if (renderer === undefined) {
    const pre = el("pre");
    pre.append(el("code", undefined, source));
    wrap.append(pre);
    return wrap;
  }

  let rendered: HTMLElement;
  try {
    rendered = renderer(source, ctx);
  } catch {
    // A malformed rich block degrades to its source rather than blanking the message.
    rendered = el("pre");
    rendered.append(el("code", undefined, source));
  }

  const details = el("details", "rich-src");
  details.append(el("summary", undefined, `${tag} source`));
  const pre = el("pre");
  pre.append(el("code", undefined, source));
  details.append(pre);

  wrap.append(rendered, details);
  return wrap;
}
