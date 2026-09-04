import type { Artifact, PendingEcho, Pin } from "./types.ts";
import type { Message } from "./render.ts";

export interface Snapshot {
  at: number;
  cwd: string | null;
  messages: Message[];
  artifacts: Artifact[];
  pins: Record<string, Pin>;
  accepts?: PendingEcho[];
}

export function pruneSnapshots(entries: { key: string; at: number }[], cap: number): string[] {
  if (entries.length <= cap) return [];
  // Sort descending by 'at', so the newest are at the beginning
  const sorted = [...entries].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  // Keep the first 'cap' elements, return the keys of the rest
  return sorted.slice(cap).map((entry) => entry.key);
}

export async function saveSnapshot(key: string, snap: Snapshot): Promise<void> {
  if (typeof globalThis.caches === "undefined") return;
  try {
    const cache = await globalThis.caches.open("loom-snap");
    const response = new Response(JSON.stringify(snap), {
      headers: {
        "Content-Type": "application/json",
        "x-snap-at": String(snap.at)
      },
    });
    await cache.put(`/snap/${key}`, response);

    // Prune old snapshots
    const keys = await cache.keys();
    const entries: { key: string; at: number }[] = [];
    for (const req of keys) {
      const snapKey = new URL(req.url).pathname.replace(/^\/snap\//, "");
      const res = await cache.match(req);
      if (res) {
        const atStr = res.headers.get("x-snap-at");
        if (atStr !== null) {
          const at = parseInt(atStr, 10);
          if (!isNaN(at)) {
            entries.push({ key: snapKey, at });
          }
        }
      }
    }

    const toDelete = pruneSnapshots(entries, 8);
    for (const dKey of toDelete) {
      await cache.delete(`/snap/${dKey}`);
    }
  } catch {
    // Swallow every failure (no caches, quota, private mode)
  }
}

export async function loadSnapshot(key: string): Promise<Snapshot | null> {
  if (typeof globalThis.caches === "undefined") return null;
  try {
    const cache = await globalThis.caches.open("loom-snap");
    const res = await cache.match(`/snap/${key}`);
    if (!res) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null; // Swallow errors
  }
}
