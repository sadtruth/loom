/**
 * Prototype discovery + provenance (SPEC 133, 134, 136).
 *
 * A record's prototypes are the `.html` files in `mockups/` beside its record file. The drawer's
 * scope is the record PLUS its descendants — never a parent: a prototype argues for one feature's
 * design, and the parent is only a place to go looking when the child's name is forgotten.
 *
 * Provenance is the transcript store: the message that first EMBEDS a file is where the design
 * conversation around it lives, so a row can jump there. Derived by search on demand rather than
 * kept in an index nothing maintains.
 */


import { readdir, stat, } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { RecordInfo } from "./records.ts";
import { DENY_SEGMENT, DENY_NAME, decide, type Guard } from "./files.ts";
import { extractPaths } from "../client/paths.ts";
import { storeKeyOf } from "./train.ts";
import { cwdFor } from "./cores.ts";
import { sessionsOf } from "./links.ts";
import type { ProtoGroup } from "../client/types.ts";


/** The record and every descendant, breadth-first — the record itself always leads. */
export function subtreeOf(records: readonly RecordInfo[], path: string): RecordInfo[] {
  const root = records.find((r) => r.path === path);
  if (root === undefined) return [];
  const out: RecordInfo[] = [root];
  const seen = new Set([root.path]);
  for (let i = 0; i < out.length; i += 1) {
    const current = out[i];
    if (current === undefined) break;
    for (const record of records) {
      if (record.parent === current.path && !seen.has(record.path)) {
        seen.add(record.path);
        out.push(record);
      }
    }
  }
  return out;
}



/**
 * PURE logic for deduplicating prototype files found across multiple origins.
 * Files with the same absolute path are merged, and their origins are combined.
 */
export function deduplicateProtos(
  files: readonly { name: string; path: string; mtime: number; origins: string[] }[]
): { name: string; path: string; mtime: number; origins: string[] }[] {
  const map = new Map<string, { name: string; path: string; mtime: number; origins: Set<string> }>();
  for (const f of files) {
    const existing = map.get(f.path);
    if (existing) {
      for (const o of f.origins) existing.origins.add(o);
    } else {
      map.set(f.path, { name: f.name, path: f.path, mtime: f.mtime, origins: new Set(f.origins) });
    }
  }
  return Array.from(map.values())
    .map(f => ({ name: f.name, path: f.path, mtime: f.mtime, origins: Array.from(f.origins).sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Groups in subtree order; a record without a mockups/ directory contributes nothing. */
export async function listPrototypes(records: readonly RecordInfo[], path: string, links: ReadonlyMap<string, string>, root: string, agyRoot: string, guard: Guard): Promise<ProtoGroup[]> {
  const groups: ProtoGroup[] = [];
  for (const record of subtreeOf(records, path)) {
    const skipped: string[] = [];
    const foundRaw: { name: string; path: string; mtime: number; origins: string[] }[] = [];

    // 1. mockups
    const dir = join(dirname(record.path), "mockups");
    try {
      const names = (await readdir(dir)).filter((n) => /\.html?$/i.test(n));
      for (const name of names) {
        const fullPath = join(dir, name);
        try {
          const s = await stat(fullPath);
          if (decide(guard, fullPath).ok) {
            foundRaw.push({ name, path: fullPath, mtime: s.mtimeMs, origins: ["mockups"] });
          }
        } catch {
          if (!skipped.includes("mockups")) skipped.push("mockups");
        }
      }
    } catch {
      skipped.push("mockups");
    }

    // 2. folder
    const folderDir = dirname(record.path);
    let level = [folderDir];
    let depth = 0;
    while (level.length > 0 && depth <= 6) {
      const nextLevel: string[] = [];
      for (const d of level) {
        try {
          const entries = await readdir(d, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".") || DENY_SEGMENT.has(entry.name) || DENY_NAME.test(entry.name)) continue;

            const entryPath = join(d, entry.name);
            if (entry.isDirectory()) {
              nextLevel.push(entryPath);
            } else if (/\.html?$/i.test(entry.name)) {
              try {
                const s = await stat(entryPath);
                if (decide(guard, entryPath).ok) {
                  foundRaw.push({ name: entry.name, path: entryPath, mtime: s.mtimeMs, origins: ["folder"] });
                }
              } catch {
                if (!skipped.includes(d)) skipped.push(d);
              }
            }
          }
        } catch {
          if (!skipped.includes(d)) skipped.push(d);
        }
      }
      level = nextLevel;
      depth++;
    }

    // 3. linked
    try {
      const ids = sessionsOf(record.path, links);
      const ownKey = storeKeyOf(dirname(record.path));
      const coreKey = storeKeyOf(cwdFor(record.path));

      const storesToSearch = [
        join(root, ownKey),
        join(root, coreKey),
        join(agyRoot, ownKey),
        join(agyRoot, coreKey)
      ];

      const uniqueStores = [...new Set(storesToSearch)];

      for (const store of uniqueStores) {
        for (const sessionId of ids) {
          const sessionFile = join(store, `${sessionId}.jsonl`);
          try {
            const text = await Bun.file(sessionFile).text();
            for (const match of extractPaths(text)) {
              if (/\.html?$/i.test(match.path)) {
                try {
                  const s = await stat(match.path);
                  const name = match.path.split(sep).pop() ?? "";
                  if (decide(guard, match.path).ok) {
                    foundRaw.push({ name, path: match.path, mtime: s.mtimeMs, origins: ["linked"] });
                  }
                } catch {
                  // File not found on disk, ignore.
                }
              }
            }
          } catch {
            // Probably file not in this store.
          }
        }
      }
    } catch {
      if (!skipped.includes("linked")) skipped.push("linked");
    }

    const files = deduplicateProtos(foundRaw);

    if (files.length > 0 || record.path === path) {
      groups.push({ record: record.path, title: record.title, files, skipped });
    }
  }
  return groups;
}

/**
 * The first transcript row in the record's store that names the file — session + message uuid, so
 * the client can open the conversation where the prototype entered it. Sessions are read oldest
 * first: "introduced" means the FIRST embed, not the latest mention.
 */
export async function findIntroduction(
  storeDir: string,
  fileName: string,
): Promise<{ session: string; uuid: string } | null> {
  let entries: string[];
  try {
    entries = (await readdir(storeDir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const dated: Array<{ id: string; mtime: number }> = [];
  for (const entry of entries) {
    try {
      dated.push({ id: entry.replace(/\.jsonl$/, ""), mtime: (await stat(join(storeDir, entry))).mtimeMs });
    } catch {
      continue;
    }
  }
  dated.sort((a, b) => a.mtime - b.mtime);

  for (const { id } of dated) {
    let text: string;
    try {
      text = await Bun.file(join(storeDir, `${id}.jsonl`)).text();
    } catch {
      continue;
    }
    if (!text.includes(fileName)) continue;
    for (const line of text.split("\n")) {
      if (!line.includes(fileName)) continue;
      try {
        const row = JSON.parse(line) as { uuid?: unknown };
        if (typeof row.uuid === "string") return { session: id, uuid: row.uuid };
      } catch {
        continue; // a torn tail line — the next mention still counts
      }
    }
  }
  return null;
}
