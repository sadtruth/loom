/**
 * Finding filesystem paths inside prose. Pure and DOM-free so it can be property-tested.
 *
 * THIS IS THE HARD PART OF THE WHOLE PROJECT. User's actual complaint is that links with spaces
 * and Cyrillic do not work, and his own vault path is
 * "/Users/user/docs/Projects/Personal Claude/…" — a space in the middle. So a regex that stops at
 * whitespace fails the main case, while one that runs through whitespace swallows the rest of the
 * sentence. Neither is acceptable, hence the two-rule repair below.
 *
 * Rule A (extension): from a greedy candidate, cut at the EARLIEST known file extension. Earliest,
 * not longest — "/a/x.md and /b/y.md" must yield two paths, and a longest-match would yield one.
 * Rule B (segment), when no extension is present: accept a segment containing a space only if
 * another "/" follows it, since a space inside a directory name is always followed by more path.
 *   "…/Projects/Personal Claude/tools"  -> kept whole ("Personal Claude" is followed by /tools)
 *   "see /Users/user/docs and go"     -> cut to "/Users/user/docs"
 */

export interface PathMatch {
  path: string;
  start: number;
  end: number;
}

const ROOTS = String.raw`(?:~|/(?:Users|home|opt|etc|var|tmp|mnt|srv))/`;
/** Greedy: everything up to a newline or a delimiter that cannot appear in a shell-legible path. */
const CANDIDATE = new RegExp(`${ROOTS}[^\\n<>"'\`|]*`, "gu");

const EXTENSIONS = [
  "md", "markdown", "txt", "ts", "tsx", "js", "mjs", "cjs", "jsx", "py", "rb", "go", "rs", "nix",
  "json", "jsonl", "yml", "yaml", "toml", "ini", "conf", "sh", "bash", "zsh", "fish", "sql", "html",
  "css", "scss", "csv", "tsv", "pdf", "epub", "png", "jpg", "jpeg", "gif", "webp", "svg", "avif",
  "mp3", "m4a", "mp4", "mkv", "zip", "tar", "gz", "log", "lock", "excalidraw",
];
const EXT_RE = new RegExp(`\\.(?:${EXTENSIONS.join("|")})(?![A-Za-z0-9])`, "iu");
const FILE_EXT_ONLY = new RegExp(`\\.(?:${EXTENSIONS.join("|")})$`, "iu");
const ROOTS_PREFIX = new RegExp(`^${ROOTS}`, "u");

/**
 * Punctuation that ends a path rather than belonging to it. The prompt characters are here because
 * User pastes terminals into the chat, and `user@nixos:~/projects$ ls` used to yield the chip
 * `~/projects$` — a link to nothing, still clickable (2026-08-19).
 */
const TRAILING_PUNCT = /[.,;:!?)\]}»…$#%>]+$/u;

/**
 * A shell operator ends a path. `&&` and `;` cannot appear in one anyone means to open, and a pasted
 * command line is the commonest way a path arrives with prose stuck to it.
 */
const OPERATOR = /(?:\s(?:&&|\|\|)|;)/u;

/**
 * The one shape text alone cannot settle, and how it is settled without asking the disk.
 *
 * A space inside the FINAL segment ends the path in `see /home/user/docs and go` and belongs to it
 * in `…/Projects/Personal Claude`. Nothing in either string distinguishes them — so the tiebreak is
 * a directory loom ALREADY KNOWS, from the records it has loaded. `…/Projects/Personal Claude` is
 * recognised because that prefix is on the list, not because anything was looked up.
 *
 * Deliberately not a filesystem question (User, 2026-08-19: *"show the link as the link only based
 * on the text of the link, not on the access to it - dont ask the disk"*). A disk check made a chip
 * depend on which machine loom happens to run on, which is wrong for a man reading his own
 * transcripts from four devices — and it cost a round trip per message to answer.
 */
function longestKnownPrefix(candidate: string, known: readonly string[]): string | null {
  let best: string | null = null;
  for (const dir of known) {
    if (dir.length <= (best?.length ?? 0)) continue;
    if (candidate === dir || candidate.startsWith(`${dir}/`) || candidate.startsWith(`${dir} `)) best = dir;
  }
  return best;
}

function cutByExtension(candidate: string): string | null {
  const found = EXT_RE.exec(candidate);
  if (found === null) return null;
  return candidate.slice(0, found.index + found[0].length);
}

function cutBySegments(candidate: string): string {
  const parts = candidate.split("/");
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    const isLast = i === parts.length - 1;
    // A LEADING space means the path already ended and prose resumed ("/Users/ and /home/").
    // A directory name never starts with a space.
    if (/^\s/u.test(part)) break;
    const spaceAt = part.search(/\s/u);
    if (spaceAt === -1) {
      kept.push(part);
      continue;
    }
    // A space inside a non-final segment belongs to a directory name ("Personal Claude/tools");
    // in the final segment it ends the path and the sentence carries on.
    if (isLast) {
      kept.push(part.slice(0, spaceAt));
      break;
    }
    // ...unless the space TRAILS the segment, in which case the "/" that followed it opened a new
    // path rather than continuing this one. A directory name never ends in a space before its
    // slash, so `ls /home/user /home/spouse` is two paths and used to extract as one wide chip
    // spanning both (2026-08-19). An interior space — the case this whole extractor exists for —
    // is untouched.
    if (/\s$/u.test(part)) {
      kept.push(part.trimEnd());
      break;
    }
    kept.push(part);
  }
  return kept.join("/");
}

/**
 * All filesystem paths in a string, in order, with their offsets.
 *
 * Scans manually rather than with matchAll: the greedy candidate for "…/a.md and …/b.md" spans BOTH
 * paths, so the cursor must advance to the end of the EXTRACTED path, not the end of the candidate.
 * Advancing by the candidate silently swallowed every path after the first.
 */
export function extractPaths(text: string, known: readonly string[] = []): PathMatch[] {
  const out: PathMatch[] = [];
  let from = 0;

  while (from < text.length) {
    CANDIDATE.lastIndex = from;
    const match = CANDIDATE.exec(text);
    if (match === null) break;

    const start = match.index;
    const operator = OPERATOR.exec(match[0]);
    const candidate = operator === null ? match[0] : match[0].slice(0, operator.index);
    if (candidate.length === 0) {
      from = start + 1;
      continue;
    }
    let path = (cutByExtension(candidate) ?? cutBySegments(candidate)).replace(TRAILING_PUNCT, "");

    // A directory loom knows about beats the segment guess, and only ever makes the path LONGER —
    // the guess is a prefix of it by construction, so this can never swallow prose the walk kept out.
    const prefix = longestKnownPrefix(candidate, known);
    if (prefix !== null && prefix.length > path.length) {
      const rest = candidate.slice(prefix.length);
      const tail = rest.startsWith("/")
        ? (cutByExtension(rest) ?? cutBySegments(rest)).replace(TRAILING_PUNCT, "")
        : "";
      path = (prefix + tail).replace(TRAILING_PUNCT, "");
    }

    // Must still be rooted and have at least one segment after the root: "/Users" is not a path
    // anyone means to open, and "/Users/" is a bare root.
    if (path.length === 0 || !ROOTS_PREFIX.test(path) || path.replace(ROOTS_PREFIX, "").length === 0) {
      from = start + Math.max(1, path.length);
      continue;
    }

    out.push({ path, start, end: start + path.length });
    from = start + path.length;
  }

  return out;
}

/** Is this whole string a path? Used for inline-code spans, which may be project-relative. */
export function looksLikePath(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return false;
  if (/\n|\s{2,}/u.test(trimmed)) return false;
  if (ROOTS_PREFIX.test(trimmed)) return true;
  // A TRAILING SLASH declares a directory, and it is the only thing the text can say about a
  // relative path carrying no extension. Without this, `client/` in prose was never a chip at all
  // while `locate()` would have resolved it perfectly well (link kind 5). A relative path with
  // neither an extension nor a slash at the end stays out: nothing distinguishes it from two
  // ordinary words with a slash between them.
  if (trimmed.length > 1 && trimmed.endsWith("/") && !trimmed.startsWith("/")) return true;
  return trimmed.includes("/") && FILE_EXT_ONLY.test(trimmed);
}
