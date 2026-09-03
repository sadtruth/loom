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

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RecordInfo } from "./records.ts";

export interface ProtoGroup {
  record: string;
  title: string;
  files: Array<{ name: string; path: string; mtime: number }>;
}

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

/** Groups in subtree order; a record without a mockups/ directory contributes nothing. */
export async function listPrototypes(records: readonly RecordInfo[], path: string): Promise<ProtoGroup[]> {
  const groups: ProtoGroup[] = [];
  for (const record of subtreeOf(records, path)) {
    const dir = join(dirname(record.path), "mockups");
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => /\.html?$/i.test(n));
    } catch {
      continue;
    }
    const files: ProtoGroup["files"] = [];
    for (const name of names) {
      try {
        files.push({ name, path: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs });
      } catch {
        continue; // raced a deletion — not this route's problem
      }
    }
    if (files.length > 0) groups.push({ record: record.path, title: record.title, files });
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
