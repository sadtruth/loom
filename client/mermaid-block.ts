import DOMPurify from "dompurify";
import type { BlockContext } from "./blocks.ts";

let mermaidPromise: Promise<any> | null = null;
let mermaidId = 0;

export const cache = new Map<string, string>();
const MAX_CACHE = 100;

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

export function renderMermaid(source: string, _ctx: BlockContext): HTMLElement {
  const wrap = el("div", "rich-mermaid");

  const cached = cache.get(source);
  if (cached !== undefined) {
    // Move to end to represent most recently used
    cache.delete(source);
    cache.set(source, cached);
    wrap.innerHTML = cached;
    return wrap;
  }

  const placeholder = el("div", "mermaid-placeholder");
  wrap.append(placeholder);

  if (mermaidPromise === null) {
    // Loaded from /vendor/mermaid rather than imported by name: bundling mermaid with the rest of
    // the client makes mermaid.render throw inside DOMPurify, and every diagram then renders with
    // no labels and NaN geometry (2026-09-07). The path is assembled at runtime so the bundler
    // cannot resolve it and pull the library back in.
    const url = ["", "vendor", "mermaid", "mermaid.esm.mjs"].join("/");
    mermaidPromise = import(url).then((m: { default: any }) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        // loom's UI is light (style.css: "i hate the black theme, make it white"), and the dark
        // theme drew dark labels on dark nodes, so nothing in a diagram could be read.
        theme: "default",
        // Labels as SVG <text> rather than HTML inside <foreignObject>. The sanitize pass below
        // keeps SVG only, so HTML labels were stripped out and every node came out blank while
        // its box and edges survived (2026-09-07).
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
      });
      return m.default;
    });
  }

  void mermaidPromise
    .then(async (mermaid) => {
      if (!wrap.isConnected) return;
      const id = `mermaid-${String(++mermaidId)}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const cleanSvg = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        
        if (!wrap.isConnected) return;

        if (cache.size >= MAX_CACHE) {
          const firstKey = cache.keys().next().value;
          if (firstKey !== undefined) cache.delete(firstKey);
        }
        cache.set(source, cleanSvg);
        
        wrap.innerHTML = cleanSvg;
      } catch (e: unknown) {
        if (!wrap.isConnected) return;
        const msg = e instanceof Error ? e.message : String(e);
        wrap.innerHTML = "";
        const pre = el("pre");
        const code = el("code", undefined, source);
        const errorLine = el("div", "embed-err", `Mermaid error: ${msg.split("\\n")[0] ?? msg}`);
        pre.append(code);
        wrap.append(errorLine, pre);
      }
    })
    .catch(() => {
      // Import failed or something fatal.
    });

  return wrap;
}

// Exported for testing only
export function __clearMermaidCacheForTests() {
  cache.clear();
  mermaidId = 0;
}