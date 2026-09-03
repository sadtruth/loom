/**
 * Enumerate the Claude Code transcript store.
 *
 * Directory names are the absolute project path with "/" and "." replaced by "-", which is lossy:
 * "-Users-serbir-docs-Projects-Personal-Claude" cannot be mechanically unescaped back to a path
 * containing a space. So the real cwd is read out of the transcript itself (row.cwd), and the
 * escaped name is only ever a key.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

export interface ProjectInfo {
  /** Escaped directory name — the stable key used in URLs. */
  key: string;
  dir: string;
  /** Real cwd, read from the newest transcript. Null when no transcript could be read. */
  cwd: string | null;
  label: string;
  sessions: number;
  lastActive: number;
}

/**
 * Scans COMPLETE lines across a generous head, not just line 0 of 8KB: a single row carrying a big
 * attachment or a long tool result routinely exceeds that, and the first parse failure used to leave
 * every project labelled by its escaped directory name.
 */
async function firstCwd(dir: string, files: readonly string[]): Promise<string | null> {
  for (const name of files.slice(0, 3)) {
    try {
      const head = await Bun.file(join(dir, name)).slice(0, 512 * 1024).text();
      const lines = head.split("\n");
      lines.pop(); // the last line is truncated by the slice
      for (const line of lines) {
        if (line.length === 0) continue;
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof row === "object" && row !== null && "cwd" in row) {
          const cwd = (row as { cwd: unknown }).cwd;
          if (typeof cwd === "string" && cwd.length > 0) return cwd;
        }
      }
    } catch {
      // An unreadable file is not an error here — try the next one.
    }
  }
  return null;
}

/** `rootOrRoots` is a parameter, not the module constant: the journey pin serves a fixture store. */
export async function listProjects(
  rootOrRoots: string | readonly string[] = PROJECTS_ROOT,
): Promise<ProjectInfo[]> {
  const roots = typeof rootOrRoots === "string" ? [rootOrRoots] : rootOrRoots;
  const projectDirsByKey = new Map<string, string[]>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const key of entries) {
      const dir = join(root, key);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) continue;
        const dirs = projectDirsByKey.get(key) ?? [];
        dirs.push(dir);
        projectDirsByKey.set(key, dirs);
      } catch {
        continue;
      }
    }
  }

  const out: ProjectInfo[] = [];
  for (const [key, dirs] of projectDirsByKey) {
    const allFilesWithStats: { file: string; dir: string; mtime: number }[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        let mtime = 0;
        try {
          mtime = (await stat(join(dir, f))).mtimeMs;
        } catch {
          mtime = 0;
        }
        allFilesWithStats.push({ file: f, dir, mtime });
      }
    }

    if (allFilesWithStats.length === 0) continue;

    allFilesWithStats.sort((a, b) => b.mtime - a.mtime);

    const seen = new Set<string>();
    const uniqueFiles: { file: string; dir: string; mtime: number }[] = [];
    for (const item of allFilesWithStats) {
      if (!seen.has(item.file)) {
        seen.add(item.file);
        uniqueFiles.push(item);
      }
    }

    let cwd: string | null = null;
    for (const item of uniqueFiles.slice(0, 3)) {
      cwd = await firstCwd(item.dir, [item.file]);
      if (cwd !== null) break;
    }

    const primaryDir = dirs[0] ?? "";
    out.push({
      key,
      dir: primaryDir,
      cwd,
      label: cwd !== null ? (cwd.split("/").slice(-1)[0] ?? cwd) : key,
      sessions: uniqueFiles.length,
      lastActive: uniqueFiles[0]?.mtime ?? 0,
    });
  }

  return out.sort((a, b) => b.lastActive - a.lastActive);
}
