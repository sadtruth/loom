/**
 * Global read state across devices.
 *
 * Read state moves from browser localStorage to a Resilio-synced directory in the vault,
 * written as ONE FILE PER DEVICE and merged on read. Two machines never write the same file,
 * making concurrent reads and writes lossless under Resilio sync.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { VAULT } from "./cores.ts";

export interface SeenState {
  watermark: number;
  seen: Record<string, number>;
}

export function seenDir(): string {
  return Bun.env["LOOM_SEEN_DIR"] ?? join(VAULT, "Projects/Personal Claude/tools/loom/seen");
}

export function sanitizeHost(host: string): string {
  const sanitized = host.replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function deviceFile(dir: string = seenDir(), host?: string): string {
  const name = sanitizeHost(host ?? hostname());
  return join(dir, `${name}.json`);
}

/**
 * Pure function: merges parsed file contents into a single { watermark, seen } state.
 *
 * - seen[id] = MAX across files (a session read anywhere is read everywhere).
 * - watermark = MIN of positive watermarks (oldest floor wins; new device doesn't hide unreads).
 * - Corrupted files or non-finite / non-positive values are dropped.
 */
export function mergeSeen(files: unknown[]): SeenState {
  if (!Array.isArray(files)) return { watermark: 0, seen: {} };

  const watermarks: number[] = [];
  const mergedSeen: Record<string, number> = Object.create(null);

  for (const file of files) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) continue;
    const rec = file as Record<string, unknown>;

    if (typeof rec.watermark === "number" && Number.isFinite(rec.watermark) && rec.watermark > 0) {
      watermarks.push(rec.watermark);
    }

    if (typeof rec.seen === "object" && rec.seen !== null && !Array.isArray(rec.seen)) {
      for (const [k, v] of Object.entries(rec.seen as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          const prev = Object.hasOwn(mergedSeen, k) ? (mergedSeen[k] as number) : 0;
          mergedSeen[k] = Math.max(prev, v);
        }
      }
    }
  }

  const watermark = watermarks.length > 0 ? Math.min(...watermarks) : 0;
  return { watermark, seen: Object.assign({}, mergedSeen) };
}

/** Reads every *.json in seenDir() and returns the merged state. */
export async function readAll(dir: string = seenDir()): Promise<SeenState> {
  if (!existsSync(dir)) return { watermark: 0, seen: {} };
  try {
    const entries = await readdir(dir);
    const jsonFiles = entries.filter((e) => e.endsWith(".json"));
    const contents: unknown[] = [];
    for (const f of jsonFiles) {
      try {
        const text = await readFile(join(dir, f), "utf8");
        contents.push(JSON.parse(text));
      } catch {
        // Skip unreadable or corrupt file
      }
    }
    return mergeSeen(contents);
  } catch {
    return { watermark: 0, seen: {} };
  }
}

/**
 * Merges patch into this device's own file, caps seen to 300 newest entries, and writes atomically.
 * Only ever touches this device's own file.
 */
export async function writeOwn(patch: unknown, dir: string = seenDir(), host?: string): Promise<void> {
  const file = deviceFile(dir, host);
  let current: unknown = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(await readFile(file, "utf8"));
    } catch {
      current = {};
    }
  }
  const merged = mergeSeen([current, patch]);
  const sortedEntries = Object.entries(merged.seen)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300);
  const capped: SeenState = {
    watermark: merged.watermark,
    seen: Object.fromEntries(sortedEntries),
  };

  await mkdir(dir, { recursive: true });
  const tmp = `${file}.loom-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(capped, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
