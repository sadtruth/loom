export type Snapshot = {
  at: number;
  cwd: string | null;
  messages: any[];
  artifacts: any[];
  pins: Record<string, any>;
  accepts?: any[];
};

export async function saveSnapshot(key: string, snap: Snapshot): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await globalThis.caches.open("loom-snap");
    await cache.put(`/snap/${key}` as unknown as Request, new Response(JSON.stringify(snap)));
    const keys = await cache.keys();
    const entries = await Promise.all(
      keys.map(async (k) => {
        const url = new URL(k.url);
        const entryKey = url.pathname.replace(/^\/snap\//, "");
        const res = await cache.match((typeof k !== 'undefined' ? k : `/snap/${key}`) as unknown as Request);
        if (!res) return { key: entryKey, at: 0 };
        const data = await res.json() as Snapshot;
        return { key: entryKey, at: data.at };
      })
    );
    const toDelete = pruneSnapshots(entries, 8);
    for (const d of toDelete) {
      await cache.delete(`/snap/${d}` as unknown as Request);
    }
  } catch {
    // ignore
  }
}

export async function loadSnapshot(key: string): Promise<Snapshot | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await globalThis.caches.open("loom-snap");
    const res = await cache.match(`/snap/${key}` as unknown as Request);
    if (!res) return null;
    return await res.json() as Snapshot;
  } catch {
    return null;
  }
}

export function pruneSnapshots(entries: {key: string, at: number}[], cap: number): string[] {
  if (entries.length <= cap) return [];
  const sorted = [...entries].sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    return a.key.localeCompare(b.key);
  });
  return sorted.slice(cap).map(e => e.key);
}
