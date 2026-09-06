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
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
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