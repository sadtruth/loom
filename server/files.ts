/**
 * The guarded file reader behind the in-loom file pane.
 *
 * WHY A GUARD AT ALL. Until now `main.ts` could say "no route accepts a filesystem path for reading";
 * the file pane breaks that sentence, and loom listens on a LAN/Tailscale/Yggdrasil-reachable port
 * with NO password (unlike the hub, which has one). An unbounded reader would therefore hand
 * `~/.ssh/id_ed25519` to anything that can reach :4173. So the rule is an allow-list of roots plus a
 * deny-list of shapes, checked after `realpath` so a symlink cannot walk out of a root.
 *
 * Pure decision logic lives in `decide()` — no I/O — so the properties can hunt traversal strings
 * without touching a filesystem. `readable()` adds the realpath step that only a real FS can answer.
 */

import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Roots are absolute, realpath-ed once at startup. Everything outside them is invisible to loom. */
export interface Guard {
  roots: readonly string[];
  /**
   * `[from, to]` pairs rewriting a path BEFORE it is judged. A session transplanted from another
   * machine names files by THAT machine's paths — `/home/user/docs/…` on a box whose copy of the
   * same tree is `/home/user/resilio/docs/…`. Without this, every path chip in a moved session is a
   * 403, which is the entire measured cost of moving a session between machines (2026-08-13).
   *
   * This can only ever move a path INTO a root, never out of one: the rewrite happens first and the
   * deny-list and containment checks then run on the rewritten path, exactly as for any other.
   */
  aliases: readonly (readonly [string, string])[];
  /**
   * The vault as this machine holds it. A session worktree wears a vault-shaped hat
   * (`~/looms/<slug>/docs/…`), so a file inside one has a twin here — which is the only thing that
   * still exists once the branch has landed and the worktree has been dropped (item 16).
   */
  vault: string;
}

/** Names that are never worth reading through a browser, wherever they sit inside an allowed root. */
export const DENY_SEGMENT = new Set([".ssh", ".gnupg", ".aws", ".password-store", "node_modules", ".git"]);
export const DENY_NAME = /^(\.env(\..*)?|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|kdbx))$/i;

/** 2 MB. A transcript pane is for reading, and anything larger is a download, not a read. */
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_READ_BYTES = 10 * 1024 * 1024;

export type Decision =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 403 | 404 | 413; reason: string };

/**
 * Directories loom may read from, unless `LOOM_ROOTS` overrides.
 *
 * `wt/` and `looms/` are where session worktrees live, and they are roots because loom's own build
 * process puts documents there. The build skill mandates a worktree before the first edit, so every
 * plan, prototype and record a running build produces lived outside all three original roots until
 * it landed — User, 2026-08-13: *"cant open the plan though it says 403 - outside loom's readable
 * roots"* — which is precisely when reading it no longer helps (SPEC 220, parent items 40 and 47).
 *
 * This widens WHERE loom looks, never WHAT it hands over: `DENY_SEGMENT` and `DENY_NAME` are checked
 * after containment, so a worktree's `.git`, its `node_modules` and any key file inside it are
 * refused exactly as they are in the vault.
 */
export function defaultRoots(vaultRoot: string): string[] {
  const home = homedir();
  // HOME IS A ROOT (requirement 225). It replaces the four named subdirectories that used to be
  // listed here — `.claude`, `projects`, `wt`, `looms` — each of which was added the day a file
  // inside it turned out to be unreadable, which is the shape of a list that will always be one
  // entry short.
  //
  // User's own example is a link to a file on the home box, clicked from the work Mac: loom reads
  // the box's disk for every device, so the transport was never the obstacle and the root list was
  // the whole of it.
  //
  // This widens WHERE loom looks, never WHAT it hands over: `DENY_SEGMENT` and `DENY_NAME` are
  // checked after the alias rewrite and before containment, so keys, credential directories, `.git`
  // and `node_modules` are refused inside home exactly as they were inside the vault. And it is not
  // a weakening of a security boundary, because the read guard was never one — anyone who can type
  // into loom's chat spawns a `claude` process whose own tools read the disk directly. User,
  // 2026-08-19: *"if the actor has access to loom and to chats then he can ask you to send him
  // something because you would think it is me."* The real boundary is the device token, and it is
  // a different project (`tools/loom/securing-loom/project.md`).
  //
  // 2026-08-24, item 15: the list is now the MACHINE. The audit found 339 links posted into a
  // session that loom refused for being outside these two directories — `/etc/nixos/configuration.nix`
  // most of all, which User edits by hand, plus every `/tmp/…` a run wrote. Home-plus-vault was
  // the same one-entry-short list as before, one level up.
  //
  // `home` and `vaultRoot` stay in the returned list only so `/api/roots` and the startup banner
  // still say something legible; `/` contains both, and containment is what the check uses.
  return ["/", vaultRoot, home];
}

/**
 * `[[A note]]` → the file it names, looked up by FILENAME across the vault (link kind 11).
 *
 * A wikilink names a note rather than a path, so nothing in the string says where the note lives —
 * which is the whole convenience of the form and the whole reason it needs an index. Built on first
 * use and re-built after `WIKI_TTL_MS`, because notes are created between clicks and a reader who
 * has just written one should not have to reload loom to link to it.
 *
 * Shallowest wins on a name collision, which is what Obsidian does; the walk is breadth-first for
 * exactly that reason. Dotted directories and every denied segment are skipped, so the index can
 * never offer a path the guard would then refuse.
 */
const WIKI_TTL_MS = 60_000;
let wikiAt = 0;
let wikiIndex: Map<string, string> | null = null;

async function indexNotes(root: string, depth: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let level = [root];
  for (let d = 0; d <= depth && level.length > 0; d += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || DENY_SEGMENT.has(entry.name)) continue;
        const here = join(dir, entry.name);
        if (entry.isDirectory()) {
          next.push(here);
          continue;
        }
        if (!/\.md$/i.test(entry.name)) continue;
        const key = entry.name.replace(/\.md$/i, "").toLowerCase();
        if (!out.has(key)) out.set(key, here); // shallower levels run first, so the first is nearest the root
      }
    }
    level = next;
  }
  return out;
}

/**
 * Where a `[[name]]` may be looked for: the vault, narrowed to what the guard actually allows.
 *
 * Two reasons it is not simply the vault root. An index that offers a path the guard then refuses is
 * a lookup that succeeds into a 403, and a walk over a tree loom cannot read is work nobody can use.
 * With roots INSIDE the vault, those roots are the scope; with a root that CONTAINS the vault, the
 * vault is — so home being a root does not turn a wikilink click into a walk of the home directory.
 */
export function wikiScope(guard: Guard, vaultRoot: string): string[] {
  const inside = guard.roots.filter((root) => within(vaultRoot, root));
  if (inside.length > 0) return inside;
  return guard.roots.some((root) => within(root, vaultRoot)) ? [vaultRoot] : [];
}

export async function resolveWiki(scope: readonly string[], name: string): Promise<string | null> {
  const now = Date.now();
  if (wikiIndex === null || now - wikiAt > WIKI_TTL_MS) {
    const map = new Map<string, string>();
    for (const root of scope) for (const [key, path] of await indexNotes(root, 12)) if (!map.has(key)) map.set(key, path);
    wikiIndex = map;
    wikiAt = now;
  }
  // `[[A note#a heading]]` names a place inside the note; only the name half is looked up.
  const bare = name.split("#")[0]?.trim().toLowerCase() ?? "";
  return wikiIndex.get(bare) ?? null;
}

/**
 * `LOOM_ALIASES` — `from=to` pairs, colon-separated:
 * `/home/user/docs=/home/user/resilio/docs`. Empty everywhere except a machine that holds
 * transplanted sessions. A pair with an empty half, or a half that is not absolute, is dropped
 * rather than guessed at: a half-parsed alias silently reading the wrong tree is worse than none.
 */
export function parseAliases(aliasEnv: string | undefined): (readonly [string, string])[] {
  if (aliasEnv === undefined || aliasEnv.trim().length === 0) return [];
  const out: [string, string][] = [];
  for (const pair of aliasEnv.split(":")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const from = pair.slice(0, eq).trim();
    const to = pair.slice(eq + 1).trim();
    if (!isAbsolute(from) || !isAbsolute(to)) continue;
    out.push([resolve(from), resolve(to)]);
  }
  return out;
}

/**
 * Rewrite `path` through the first matching alias, on SEGMENT boundaries only — `/home/user/docs`
 * must not rewrite `/home/user/docsomething`, which is the same mistake `within()` exists to avoid
 * one layer down. Pure, and applied to an already-resolved absolute path.
 */
export function applyAlias(guard: Guard, path: string): string {
  for (const [from, to] of guard.aliases) {
    if (path === from) return to;
    if (path.startsWith(from.endsWith(sep) ? from : from + sep)) {
      return resolve(to, path.slice(from.length + (from.endsWith(sep) ? 0 : 1)));
    }
  }
  return path;
}

export function guardFrom(
  rootsEnv: string | undefined,
  vaultRoot: string,
  aliasEnv?: string | undefined,
): Guard {
  const roots =
    rootsEnv !== undefined && rootsEnv.trim().length > 0
      ? rootsEnv.split(":").filter((r) => r.length > 0)
      : defaultRoots(vaultRoot);
  return { roots: roots.map((r) => resolve(r)), aliases: parseAliases(aliasEnv), vault: resolve(vaultRoot) };
}

/** `child` is inside `root` — compared on segment boundaries, so `/a/bc` is NOT inside `/a/b`. */
export function within(root: string, child: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * `~/x` is a path a human wrote, and loom's own prose is full of them; expanding it HERE rather than
 * on the client keeps one answer for what home means and leaves containment to the check below,
 * which still runs on the expanded, resolved path. Before this, every `~/…` chip in the transcript
 * was dead on arrival with "absolute path required" (2026-08-10).
 *
 * `~` alone and `~user` are NOT expanded: the first names no file, and the second would need a
 * passwd lookup to mean anything, so both stay 400s.
 */
export function expandHome(raw: string): string {
  if (raw === "~") return raw;
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

/**
 * The whole decision, minus symlink resolution: absolute, normalised, inside a root, not denied.
 *
 * `resolve()` collapses `..` before the root check, which is what makes traversal strings
 * (`/vault/../../etc/passwd`) fail the containment test rather than sneak through it.
 */
const WRITABLE_DENY_SEGMENTS = new Set(["Diary", "Archive", ".git"]);
const WRITABLE_EXT = /\.(md|markdown|txt)$/i;

export function writable(guard: Guard, raw: string): Decision {
  const base = decide(guard, raw);
  if (!base.ok) return base;

  const segments = base.path.split(sep);
  if (segments.some(s => WRITABLE_DENY_SEGMENTS.has(s))) {
    return { ok: false, status: 403, reason: "read-only location" };
  }

  // Also check Garden/Sources/Highlights/ matched on path segments
  for (let i = 0; i < segments.length - 2; i++) {
    if (segments[i] === "Garden" && segments[i+1] === "Sources" && segments[i+2] === "Highlights") {
      return { ok: false, status: 403, reason: "read-only location" };
    }
  }

  const name = segments[segments.length - 1] ?? "";
  if (!WRITABLE_EXT.test(name)) {
    return { ok: false, status: 403, reason: "read-only file type" };
  }

  return base;
}

export async function writableFile(guard: Guard, raw: string): Promise<Decision> {
  const first = writable(guard, raw);
  if (!first.ok) return first;
  let real: string;
  try {
    real = await realpath(first.path);
  } catch {
    return { ok: false, status: 400, reason: "not found" };
  }
  return writable(guard, real);
}

export function decide(guard: Guard, raw: string): Decision {
  const expanded = expandHome(raw);
  if (expanded.length === 0 || !isAbsolute(expanded)) {
    return { ok: false, status: 400, reason: "absolute path required" };
  }
  if (expanded.includes("\0")) return { ok: false, status: 400, reason: "bad path" };

  // The alias runs AFTER `resolve()` collapses `..` and BEFORE every judgement below, so a rewritten
  // path faces exactly the same deny-list and containment checks as one that was typed. Rewriting
  // after the checks would let an alias smuggle a path past them; rewriting before `resolve()` would
  // let `/alias/../..` escape the prefix it matched.
  const path = applyAlias(guard, resolve(expanded));
  const segments = path.split(sep);
  const name = segments[segments.length - 1] ?? "";
  if (segments.some((s) => DENY_SEGMENT.has(s))) return { ok: false, status: 403, reason: "denied location" };
  if (DENY_NAME.test(name)) return { ok: false, status: 403, reason: "denied file" };
  if (!guard.roots.some((root) => within(root, path))) {
    return { ok: false, status: 403, reason: "outside loom's readable roots" };
  }
  return { ok: true, path };
}

/**
 * `decide()` plus the realpath check. A symlink inside a root pointing at `/etc/shadow` passes the
 * string test and fails here, which is the entire reason this second step exists.
 */
export async function readable(guard: Guard, raw: string): Promise<Decision> {
  const first = decide(guard, raw);
  if (!first.ok) return first;
  let real: string;
  try {
    real = await realpath(first.path);
  } catch {
    return { ok: false, status: 400, reason: "not found" };
  }
  return decide(guard, real);
}

/**
 * Every directory a RELATIVE chip may be resolved against, nearest first (SPEC 143).
 *
 * The session's cwd alone is not enough: a session runs in a project's record directory
 * (`tools/loom/projects/smart-links/`) while the prose it writes names files in the enclosing tree
 * (`client/markdown.ts`). Joining to the cwd and stopping there made every such chip a 400.
 *
 * Pure, so the ladder's shape is testable without a filesystem: cwd, then each ancestor, stopping
 * at the outermost guard root that contains it. Ancestors ABOVE every root are never candidates —
 * containment is still re-checked per candidate, but there is no reason to generate them.
 */
export function bases(guard: Guard, cwd: string): string[] {
  const start = resolve(expandHome(cwd));
  if (!isAbsolute(start)) return [];
  const out: string[] = [];
  let dir = start;
  for (;;) {
    if (guard.roots.some((root) => within(root, dir))) out.push(dir);
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Resolve `raw` for real: absolute and `~/…` paths answer as themselves, a relative one is tried
 * against each base in turn and the FIRST that exists wins. Nearest-first, so a file that sits both
 * beside the session and higher up resolves to the near one.
 */
export function mainTreeTwin(guard: Guard, raw: string): string | null {
  const path = resolve(expandHome(raw));
  const hat = /^(.*\/looms\/[^/]+)\/docs\//u.exec(path);
  if (hat === null) return null;
  const rest = path.slice((hat[1] ?? "").length + "/docs/".length);
  if (rest.length === 0) return null;
  const twin = join(guard.vault, rest);
  return twin === path ? null : twin;
}

export async function locate(
  guard: Guard,
  raw: string,
  cwd: string | null,
  /**
   * The record the reader has open. A message is usually ABOUT a record while the session runs
   * somewhere else, so a relative path that the session's ladder cannot resolve often sits beside
   * the record — the largest group in the 2026-08-24 audit, 1,099 links (item 14). Tried only after
   * the session's own ladder has missed, so a file that exists in both still resolves to the near
   * one, and it costs nothing on the path that already worked.
   */
  record?: string | null,
): Promise<Decision> {
  const direct = await readable(guard, raw);
  if (direct.ok) return direct;

  // A path into a session worktree outlives the worktree: the branch lands, `session.sh` drops the
  // directory, and every link written during that build 404s — 102 of them in the audit (item 16).
  // The same file is in the main tree, and trying it costs one `stat` on a path that already failed.
  const twin = mainTreeTwin(guard, raw);
  if (twin !== null) {
    const landed = await readable(guard, twin);
    if (landed.ok) return landed;
  }

  if (cwd === null || isAbsolute(expandHome(raw)) || raw.startsWith("~")) return direct;

  for (const base of bases(guard, cwd)) {
    const candidate = await readable(guard, join(base, raw));
    if (candidate.ok) return candidate;
  }
  if (record !== undefined && record !== null && record.length > 0) {
    for (const base of bases(guard, dirname(resolve(expandHome(record))))) {
      const candidate = await readable(guard, join(base, raw));
      if (candidate.ok) return candidate;
    }
  }
  // Nothing on the ladder. NOT the original "absolute path required" — a relative path is now a
  // legitimate thing to send, so the honest answer is that the file is not there.
  return { ok: false, status: 404, reason: `not found from ${cwd} or its ancestors` };
}

const TEXT_EXT =
  /\.(md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|jsonl|ya?ml|toml|ini|conf|sh|bash|zsh|fish|py|rb|go|rs|ex|exs|eex|heex|erl|c|h|cpp|hpp|java|kt|swift|sql|css|scss|html?|xml|svg|csv|tsv|log|nix|lua|gd|vim|el|dockerfile|gitignore|env\.example)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|heif|tif|tiff)$/i;

export type Kind = "markdown" | "text" | "image" | "page" | "pdf" | "download";

/** One directory entry, as the pane draws it. Denied locations never appear (SPEC 141). */
export interface DirEntry {
  name: string;
  dir: boolean;
  bytes: number;
}

/**
 * A directory's readable contents — directories first, then files, each alphabetical.
 *
 * The same DENY list the guard uses applies per entry, so `node_modules` and `.git` are absent
 * rather than present-and-refused: a listing is an invitation, and every row in it must be openable.
 */
export async function listDir(path: string): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (DENY_SEGMENT.has(entry.name) || DENY_NAME.test(entry.name)) continue;
    const dir = entry.isDirectory();
    let bytes = 0;
    if (!dir) {
      try {
        bytes = (await stat(join(path, entry.name))).size;
      } catch {
        continue; // raced a deletion, or a broken symlink — not a row worth offering
      }
    }
    out.push({ name: entry.name, dir, bytes });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

/** How the pane should render it. Extensionless files are read as text and sniffed for NUL bytes. */
export function kindOf(path: string): Kind {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (IMAGE_EXT.test(path) && !/\.svg$/i.test(path)) return "image";
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  // BEFORE `TEXT_EXT`, which also claims `html?` — and claiming it is how every prototype link ever
  // written opened as highlighted markup instead of as a page (item 10, 24 links in the audit).
  if (/\.html?$/i.test(path)) return "page";
  if (TEXT_EXT.test(path)) return "text";
  if (!/\.[A-Za-z0-9]{1,8}$/.test(path)) return "text"; // README, Makefile, LICENSE…
  return "download";
}

/** Binary sniff for the extensionless case: a NUL in the first KB means "not for the pane". */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Truncates a byte array at a given max length, taking care not to split a UTF-8 character.
 */
export function truncateUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let i = max - 1;
  while (i >= 0 && (bytes[i]! & 0xC0) === 0x80) {
    i -= 1;
  }
  if (i < 0) return bytes.slice(0, 0);

  let seqLen = 1;
  const b = bytes[i]!;
  if ((b & 0xE0) === 0xC0) seqLen = 2;
  else if ((b & 0xF0) === 0xE0) seqLen = 3;
  else if ((b & 0xF8) === 0xF0) seqLen = 4;

  if (max - i < seqLen) {
    return bytes.slice(0, i);
  }
  return bytes.slice(0, max);
}

/**
 * Builds the content-disposition header for downloading a file, emitting BOTH forms:
 * an ASCII-folded filename="..." and an RFC 5987 filename*=UTF-8''...
 */
export function contentDisposition(name: string): string {
  // Strip control characters (including CR, LF) for safety in headers.
  const cleanName = name.replace(/[\x00-\x1F\x7F]/g, "");

  // RFC 5987 encode logic. We use encodeURIComponent and then fix some characters.
  const rfc5987 = encodeURIComponent(cleanName)
    // Note: encodeURIComponent encodes spaces to %20, which is correct for RFC 5987.
    // It doesn't encode !'()* so we manually encode them for full compliance, though not strictly required.
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");

  // ASCII-folded fallback for older clients.
  // We'll replace non-ASCII with '?'.
  const ascii = cleanName.replace(/[^\x20-\x7E]/g, "?");

  // Escape quotes and backslashes in the quoted string
  const quoted = ascii.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  return `attachment; filename="${quoted}"; filename*=UTF-8''${rfc5987}`;
}
