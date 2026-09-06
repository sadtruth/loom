/**
 * The three directories a session may run in.
 *
 * User, 2026-08-16: *"lets build the plan so that sessions are in core directory, not each in its
 * own directory. I want 3 variations of that: personal claude, work claude, spouse"*.
 *
 * A core is a cwd, not a project. Its whole job is to be the directory the CLI reads its skills,
 * its output style and its CLAUDE.md from — all three come from the cwd and none of them walks up.
 * Which PROJECT a session belongs to is `links.ts`, and the two must not be confused again.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type CoreId = "personal" | "work" | "spouse";

/**
 * A core whose records are NOT `type: project` files, described the way that core already describes
 * them to itself.
 *
 * The work vault's unit of work is a directory directly under `epics/` holding a `README.md` with
 * frontmatter — the exact rule `scripts/dashboard_refresh.py` collects the epic dashboard by, and
 * `epics/Эпики.base` filters Obsidian by. Its `type:` field is NOT the rule: of the 22 live epics,
 * ten say `type: epic` and twelve say `type: task` or nothing at all, and neither the dashboard nor
 * the Base reads the field. Keying loom on the type would have shown ten of the twenty-two and
 * looked like it worked.
 */
export interface FolderRecords {
  /** The directory whose immediate subdirectories are records. */
  dir: string;
  /** The file inside each subdirectory that carries the frontmatter. */
  file: string;
  /** Subdirectory names that are not records. */
  skip: readonly string[];
}

export interface Core {
  id: CoreId;
  label: string;
  /** Where a session for this core is spawned. */
  cwd: string;
  /** Records under any of these prefixes belong to this core. Empty = the default core. */
  owns: readonly string[];
  /**
   * Where a NEW record for this core is written. User, 2026-08-16, asked for a work project and
   * watched it land in the personal tree: the selector scoped what he SAW and not where a record
   * went. It must stay under a record root, or the thing just created is never scanned again.
   */
  home: string;
  /** This core's own record layout, when it does not use `type: project` files. */
  records?: FolderRecords;
}

/**
 * The vault cores govern — the REAL one, deliberately not derived from `import.meta.dir`.
 *
 * `main.ts` computes its own `VAULT_ROOT` five levels up from the server file, which in a git
 * worktree at `~/wt/<branch>` resolves to `/home/user`. Threading that in made every fixture
 * record count as "inside the vault", so `journey4-records` and `journey5-tasks` spawned their
 * children into the real Personal Claude and their transcripts landed in the real store. A core
 * is a statement about one fixed tree; a path that moves with the checkout cannot be it.
 */
export const VAULT = Bun.env["LOOM_CORE_VAULT"] ?? join(homedir(), "resilio", "docs");

/**
 * Every core path below is a GUESS until the machine names its own. The source carries neutral
 * placeholders so a public checkout leaks nothing, and the install that owns the real vault sets
 * these in `~/.config/loom/local.env` (read by `run.sh` and by loom.service). Getting this wrong is
 * silent and total: on 2026-09-05 a deploy carried a placeholder vault root and every core came up
 * "no vault yet", no session was tied to a project, and nothing in the log said why. `main.ts`
 * warns at boot when VAULT does not exist, which is the loud half of the same lesson.
 */
export const SPOUSE_LABEL = Bun.env["LOOM_SPOUSE_LABEL"] ?? "Spouse";
export const SPOUSE_CORE = Bun.env["LOOM_SPOUSE_CORE"] ?? `${VAULT}/Projects/Spouse Claude`;
export const SPOUSE_DIR = Bun.env["LOOM_SPOUSE_DIR"] ?? `${VAULT}/Areas/Family/spouse`;

/**
 * Ordered MOST SPECIFIC FIRST — `coreFor` takes the first match, so a core with no prefixes must be
 * last or it would swallow everything.
 *
 * Spouse has no vault yet: `SPOUSE_DIR` is a folder of documents with no `.claude`, so there is
 * nothing for the CLI to load there. The entry is declared so the shape is complete, and
 * `usableCores` drops any core whose cwd does not exist — an unusable core falls back to personal
 * rather than spawning a session into a directory that cannot answer for it.
 */
export const CORES: readonly Core[] = [
  {
    id: "work",
    label: "Work",
    cwd: `${VAULT}/Projects/claude`,
    owns: [`${VAULT}/Projects/claude`],
    home: `${VAULT}/Projects/claude/projects`,
    records: { dir: `${VAULT}/Projects/claude/epics`, file: "README.md", skip: ["архив"] },
  },
  {
    id: "spouse",
    label: SPOUSE_LABEL,
    cwd: SPOUSE_CORE,
    owns: [SPOUSE_DIR, SPOUSE_CORE],
    home: `${SPOUSE_CORE}/projects`,
  },
  {
    id: "personal",
    label: "Personal",
    cwd: `${VAULT}/Projects/Personal Claude`,
    owns: [],
    home: `${VAULT}/Projects`,
  },
];

export function defaultCore(cores: readonly Core[] = CORES): Core {
  const last = cores[cores.length - 1];
  if (last === undefined) throw new Error("cores: at least one core is required");
  return cores.find((c) => c.owns.length === 0) ?? last;
}

/**
 * Prefix match on a SEGMENT boundary — the same trap `parseAliases` documents. Without it a record
 * in `Projects/claude-optimization` would be claimed by the `Projects/claude` core, which is a
 * different project with a different CLAUDE.md.
 */
export function under(path: string, prefix: string): boolean {
  return isUnder(resolve(path), resolve(prefix));
}

/** The same test with both sides ALREADY resolved — the hot half, called per record per scan. */
function isUnder(p: string, q: string): boolean {
  return p === q || p.startsWith(`${q}/`);
}

/**
 * Every core's prefixes, resolved ONCE.
 *
 * `parseRecord` calls `coreFor` for every record, so a scan of 112 records was doing ~900 `resolve`
 * calls that can never change. That cost landed on the path `journey2-input` measures, and that pin
 * owns a clock — it asserts a message is still QUEUED, so anything that slows the server between
 * two sends makes it fail. Removing the work is the fix; re-running it would only fail to
 * reproduce (build ratchet, 2026-08-15).
 */
const RESOLVED = new Map<CoreId, string[]>(CORES.map((c) => [c.id, c.owns.map((o) => resolve(o))]));

/** Which core a record's sessions should run in. Unknown records go to the default core. */
export function coreFor(recordPath: string, cores: readonly Core[] = CORES): Core {
  const p = resolve(recordPath);
  for (const core of cores) {
    const prefixes = cores === CORES ? (RESOLVED.get(core.id) ?? []) : core.owns.map((o) => resolve(o));
    if (prefixes.some((q) => isUnder(p, q))) return core;
  }
  return defaultCore(cores);
}

/**
 * Is this cwd a core's own root?
 *
 * The CLI discovers `.claude/settings.json` from the cwd, so a session running IN a core loads that
 * core's hooks by itself and must not have another core's injected on top — `childSettings` used to
 * inject Personal Claude's ~30 hooks into anything whose cwd was not the loom repo root, which for
 * a work-core session meant the personal vault's guards, pointed at the personal vault.
 */
export function isCoreRoot(path: string, cores: readonly Core[] = CORES): boolean {
  const p = resolve(path);
  return cores.some((c) => resolve(c.cwd) === p);
}

/**
 * Cores whose cwd actually exists. A core that names a missing directory is not offered and never
 * spawned into: the CLI would run there with no skills, no style and no CLAUDE.md, which is the
 * exact failure this whole change exists to end.
 */
export function usableCores(cores: readonly Core[] = CORES, exists: (p: string) => boolean = existsSync): Core[] {
  return cores.filter((c) => exists(c.cwd));
}

/**
 * The cwd to spawn in for a record.
 *
 * Cores govern the VAULT and nothing else. A record outside it — every test fixture, and anything
 * under a `LOOM_RECORD_ROOTS` pointed somewhere else — keeps the old behaviour of running in its
 * own directory. Without that clause the first driven run redirected a fixture record's child into
 * the real Personal Claude, its transcript landed in the real store, and `journey4-records` waited
 * 30s for a reply that had been written somewhere else entirely. A core is an opinion about the
 * vault's layout, so it must not have opinions about paths that are not in the vault.
 *
 * A core whose directory does not exist (Spouse, today) falls back to the default core rather than
 * spawning into a directory with no `.claude` — the exact failure this change exists to end.
 */
export function cwdFor(
  recordPath: string,
  vaultRoot: string = VAULT,
  cores: readonly Core[] = CORES,
  exists: (p: string) => boolean = existsSync,
): string {
  if (!under(recordPath, vaultRoot)) return dirname(resolve(recordPath));
  const core = coreFor(recordPath, cores);
  if (exists(core.cwd)) return core.cwd;
  const fallback = defaultCore(cores);
  return exists(fallback.cwd) ? fallback.cwd : dirname(resolve(recordPath));
}

/** Where a new record goes for a chosen core. Unknown or absent core → the default's home. */
export function homeFor(coreId: string | null, cores: readonly Core[] = CORES): string {
  if (coreId === "lena") coreId = "spouse"; // leak-ok: legacy id accepted at the read boundary
  const core = cores.find((c) => c.id === coreId);
  return (core ?? defaultCore(cores)).home;
}
