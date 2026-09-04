/**
 * Pure bundle-identity helpers — no DOM, safe to import in tests.
 *
 * Bun emits three script/chunk path shapes depending on the development flag:
 *   development: true          →  /_bun/client/<hash>.js
 *   development: { hmr:false } →  /chunk-<hash>.js
 *   development: false         →  /../chunk-<hash>.js  (normalises to /chunk-<hash>.js in browsers)
 *
 * All functions strip query strings and compare only the file name (last path segment).
 */

/** Last path segment of a URL pathname, with any query string removed. */
function fileBasename(src: string): string {
  // Remove query string, then take the last non-empty segment.
  const clean = (src.split("?")[0] ?? "").replace(/\/$/, "");
  const slash = clean.lastIndexOf("/");
  return slash === -1 ? clean : clean.slice(slash + 1);
}

/**
 * The file name of the first `<script type="module" src="...">` in an HTML string, or null.
 *
 * Handles all three Bun path shapes:
 *   /_bun/client/<hash>.js
 *   /chunk-<hash>.js
 *   /../chunk-<hash>.js   (Bun's production shape — browsers normalise it to /chunk-<hash>.js)
 */
export function bundleNameOf(html: string): string | null {
  // Match the first module script with a src attribute; attribute order can vary.
  const m =
    /<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i.exec(html) ??
    /<script[^>]+src=["']([^"']+)["'][^>]+type=["']module["']/i.exec(html);
  if (m === null) return null;
  const src = m[1] ?? "";
  // Only JS assets are the bundle entry; skip data URIs or empty strings.
  if (!src.includes(".js")) return null;
  return fileBasename(src) || null;
}

/**
 * True when the page's module script has the same file name as what the HTML now serves.
 *
 * `pageSrc` is the resolved pathname of the page's own `<script type="module" src>`.
 * Returns TRUE when the HTML names no module script — an unbundled page has nothing to
 * compare, and must never trigger a reload on that.
 */
export function sameBundle(pageSrc: string, html: string): boolean {
  const theirs = bundleNameOf(html);
  if (theirs === null) return true; // no bundle in HTML → nothing to compare
  return fileBasename(pageSrc) === theirs;
}

/**
 * The first five characters of the content hash from a stylesheet href, or null.
 *
 * Handles both Bun stylesheet shapes:
 *   /chunk-<hash>.css          (development: {hmr:false})
 *   /_bun/asset/<hash>.css     (development: true)
 */
export function styleHashOf(href: string): string | null {
  // /chunk-<hash>.css shape
  const chunkMatch = /\/chunk-([a-z0-9]+)\.css/i.exec(href);
  if (chunkMatch !== null) return chunkMatch[1] ?? null;

  // /_bun/asset/<hash>.css shape
  const bunMatch = /\/_bun\/asset\/([a-z0-9]+)\.css/i.exec(href);
  if (bunMatch !== null) return bunMatch[1] ?? null;

  return null;
}
