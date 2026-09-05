/**
 * Project file index.
 *
 * One row per resolved absolute path across a project record's entire train.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { DENY_SEGMENT, DENY_NAME } from "./files.ts";

export type Band = "read" | "code" | "data";

export interface FileRow {
  path: string;
  name: string;
  band: Band;
  origins: string[];
  lastTs: string;
  bytes: number;
  pinned: boolean;
}

export interface FilePin {
  ts: string;
}

export type FilePinMap = Record<string, FilePin>;

export function bandOf(path: string): Band {
  const segments = path.split("/");
  // Data beats Code beats Read. Segments beat extensions.
  if (segments.some(s => s === "state" || s === "test-results" || s === ".playwright-mcp" || s === "coverage" || s === "__pycache__")) {
    return "data";
  }
  if (segments.some(s => s === "tests" || s === "dist" || s === "build" || s === "node_modules" || s === ".github")) {
    return "code";
  }

  const name = segments.length > 0 ? segments[segments.length - 1]! : "";
  const dotAt = name.lastIndexOf(".");
  if (dotAt > 0) {
    const ext = name.slice(dotAt).toLowerCase();
    if (ext === ".jsonl" || ext === ".log" || ext === ".lock" || ext === ".csv" || ext === ".tsv") return "data";
    if (
      ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs" ||
      ext === ".py" || ext === ".ex" || ext === ".exs" || ext === ".rs" || ext === ".go" || ext === ".rb" ||
      ext === ".css" || ext === ".scss" || ext === ".sh" || ext === ".bash" || ext === ".nix" || ext === ".sql" ||
      ext === ".toml" || ext === ".yaml" || ext === ".yml" || ext === ".json"
    ) return "code";

    // read
    if (
      ext === ".md" || ext === ".markdown" || ext === ".pdf" || ext === ".html" || ext === ".htm" || ext === ".txt" ||
      ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".gif" || ext === ".svg" || ext === ".ico"
    ) return "read";
  }

  // Check for lockfiles explicitly
  if (name.includes("lock")) {
    // wait: .lock extension is data. But "lockfiles" is code.
    // "lockfiles" usually refers to bun.lock, bun.lockb, package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock, poetry.lock, Gemfile.lock
    if (name === "bun.lockb" || name === "bun.lock" || name === "package-lock.json" || name === "yarn.lock" || name === "pnpm-lock.yaml" || name === "Cargo.lock" || name === "poetry.lock" || name === "Gemfile.lock") return "code";
    return "data"; // fallback for other lock-like things
  }

  return "code";
}

export function filePinsPath(stateDir: string, recordPath: string): string {
  // Use a hash of the record path so it is safe to use as a filename
  const hash = createHash("sha256").update(recordPath).digest("hex");
  return join(stateDir, "filepins", `${hash}.json`);
}

export async function readFilePins(stateDir: string, recordPath: string): Promise<FilePinMap> {
  const path = filePinsPath(stateDir, recordPath);
  try {
    const raw: unknown = await Bun.file(path).json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: FilePinMap = {};
    for (const [p, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as { ts?: unknown };
      out[p] = {
        ts: typeof v.ts === "string" ? v.ts : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function setFilePin(
  stateDir: string,
  recordPath: string,
  path: string,
  pinned: boolean,
  now: string,
): Promise<FilePinMap> {
  const pinsPath = filePinsPath(stateDir, recordPath);
  const pins = await readFilePins(stateDir, recordPath);
  if (pinned) pins[path] = { ts: now };
  else delete pins[path];
  await mkdir(dirname(pinsPath), { recursive: true });
  await Bun.write(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
  return pins;
}

export interface OriginInput {
  path: string;
  origin: string;
  ts: string;
  bytes: number;
}

export function mergeOrigins(inputs: readonly OriginInput[], pins: FilePinMap): FileRow[] {
  const byPath = new Map<string, { origins: Set<string>, ts: string, bytes: number }>();

  for (const input of inputs) {
    if (!isAbsolute(input.path)) continue;

    // Check DENY_SEGMENT and DENY_NAME
    const segments = input.path.split("/");
    const name = segments.length > 0 ? segments[segments.length - 1]! : "";
    if (segments.some(s => DENY_SEGMENT.has(s))) continue;
    if (DENY_NAME.test(name)) continue;

    const existing = byPath.get(input.path);
    if (existing === undefined) {
      byPath.set(input.path, { origins: new Set([input.origin]), ts: input.ts, bytes: input.bytes });
    } else {
      existing.origins.add(input.origin);
      if (input.ts > existing.ts) existing.ts = input.ts;
      if (input.bytes > existing.bytes) existing.bytes = input.bytes;
    }
  }

  // Include pinned paths that didn't appear in inputs
  for (const [path, pin] of Object.entries(pins)) {
    const existing = byPath.get(path);
    if (existing !== undefined) continue;

    if (!isAbsolute(path)) continue;
    const segments = path.split("/");
    const name = segments.length > 0 ? segments[segments.length - 1]! : "";
    if (segments.some(s => DENY_SEGMENT.has(s))) continue;
    if (DENY_NAME.test(name)) continue;

    byPath.set(path, { origins: new Set(["pinned"]), ts: pin.ts, bytes: 0 });
  }

  const rows: FileRow[] = [];
  for (const [path, data] of byPath) {
    const origins = Array.from(data.origins).sort();
    const segments = path.split("/");
    const name = segments.length > 0 ? segments[segments.length - 1]! : path;
    const isPinned = pins[path] !== undefined;

    rows.push({
      path,
      name,
      band: bandOf(path),
      origins,
      lastTs: data.ts,
      bytes: data.bytes,
      pinned: isPinned,
    });
  }

  // Sort: lastTs descending inside each band (not implemented here since bands are grouped, but we can sort overall and group in UI, or just return sorted)
  // Actually, wait: "Rows sorted by lastTs descending inside each band, ties broken on path"
  // Is the whole array sorted? "Rows sorted by lastTs descending inside each band, ties broken on path".
  // This implies sorting the array first by band, then lastTs desc, then path.
  // "data beats code beats read" -> data: 3, code: 2, read: 1
  const bandRank: Record<Band, number> = { data: 3, code: 2, read: 1 };

  rows.sort((a, b) => {
    if (bandRank[a.band] !== bandRank[b.band]) return bandRank[b.band] - bandRank[a.band];
    if (a.lastTs !== b.lastTs) return a.lastTs > b.lastTs ? -1 : 1;
    return a.path < b.path ? -1 : 1; // Strict alphabetical comparison
  });

  return rows;
}


export async function walkRecordDirectory(dir: string, depth = 0): Promise<OriginInput[]> {
  if (depth > 8) return [];
  const out: OriginInput[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "mockups") continue;
      if (entry.isDirectory() && entry.name.startsWith(".")) continue;
      if (DENY_SEGMENT.has(entry.name) || DENY_NAME.test(entry.name)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const children = await walkRecordDirectory(full, depth + 1);
        for (const child of children) out.push(child);
      } else if (entry.isFile()) {
        try {
          const s = await stat(full);
          out.push({ path: full, origin: "record", ts: new Date(s.mtimeMs).toISOString(), bytes: s.size });
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore
  }
  return out;
}
