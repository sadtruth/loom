/**
 * The audit's bridge into loom's REAL rendering (build plan `link-audit-2026-08-24`, requirement
 * "Every link is judged by loom's own code").
 *
 * Bundled for a browser and injected into a page served by a throwaway loom, so `renderMarkdown`
 * runs with the same `marked`, the same DOMPurify and the same chip passes the chat window uses. If
 * a chip is wrong in loom it is wrong here, which is the only way the audit can find a bug the
 * client has rather than a bug a re-implementation invented.
 *
 * This file reads the DOM back and reports it. It does not classify — which pass made a chip is the
 * driver's inference, from the source text, and is labelled as inference in the report.
 */

import { renderMarkdown } from "../../client/markdown.ts";
import type { BlockContext } from "../../client/blocks.ts";

export interface FoundLink {
  /** What the reader wrote — `data-raw`. */
  raw: string;
  /** What the server would be asked for — `data-path`. */
  path: string;
  /** Where inside the file to land — `data-place`, or null when the chip carries none. */
  place: string | null;
  /** The chip's visible text: what the link SAYS it opens. */
  label: string;
  /** `data-fixed` — the chip kept a caller's label, so `labelChips` never touched it. */
  fixed: boolean;
  /** `wiki:` chip from the `[[note]]` pass. */
  wiki: boolean;
  /** An anchor that survived every chip pass, with its `target` — external, or a missed path. */
  anchor: { href: string; target: string } | null;
}

declare global {
  interface Window {
    __audit: {
      render: (
        texts: readonly string[],
        records: BlockContext["records"],
        cwd: string | null,
      ) => FoundLink[][];
    };
  }
}

function linksIn(host: HTMLElement): FoundLink[] {
  const out: FoundLink[] = [];
  for (const chip of host.querySelectorAll<HTMLElement>(".chip")) {
    const raw = chip.dataset["raw"] ?? "";
    out.push({
      raw,
      path: chip.dataset["path"] ?? raw,
      place: chip.dataset["place"] ?? null,
      label: chip.textContent ?? "",
      fixed: chip.dataset["fixed"] !== undefined,
      wiki: chip.classList.contains("wiki"),
      anchor: null,
    });
  }
  // An anchor that survived every chip pass is either a link that leaves loom — fine, and its
  // `target` is the thing worth checking — or a filesystem path no pass recognised, which is a
  // silent failure the report has to see.
  for (const anchor of host.querySelectorAll<HTMLAnchorElement>("a:not(.chip)")) {
    const href = anchor.getAttribute("href") ?? "";
    if (href.length === 0 || href === "#") continue;
    out.push({
      raw: href,
      path: href,
      place: null,
      label: anchor.textContent ?? "",
      fixed: false,
      wiki: false,
      anchor: { href, target: anchor.getAttribute("target") ?? "" },
    });
  }
  return out;
}

window.__audit = {
  render(texts, records, cwd) {
    const ctx: BlockContext = { cwd, records };
    return texts.map((text) => {
      try {
        // `breaks: true` — these messages were chat turns, and that is how the chat renders them.
        return linksIn(renderMarkdown(text, ctx, { breaks: true }));
      } catch {
        return [];
      }
    });
  },
};
