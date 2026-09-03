/**
 * Accept sidecar. `state/accepts/<session-id>.json`, shape `[{ text, at }, …]`, oldest first.
 *
 * WHY IT EXISTS (SPEC 145). The queue's accept times live in the Runner's memory and die the moment
 * a message is answered — but that is exactly when the message needs them. The CLI stamps a user row
 * with the time it PICKED the message up, not the time it was sent, so a message queued behind a
 * long turn lands in the transcript minutes after everything that turn produced. The echo was drawn
 * where it was sent and the real row then appeared somewhere else entirely: the message moved.
 *
 * So the accept time outlives the queue. Written once per accepted send, read on attach, and that
 * makes the position identical on every device and across a reload — which a client-side memory of
 * the same fact could never be.
 *
 * SPEC invariant 1 holds: the loom never writes anything Claude Code reads. This is loom's own file.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Accept {
  text: string;
  at: number;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

/** How many accepts one session keeps. A long session is still a few hundred sends, not thousands. */
const KEEP = 500;

export function acceptsPath(stateDir: string, sessionId: string): string | null {
  if (!SAFE_ID.test(sessionId)) return null;
  return join(stateDir, "accepts", `${sessionId}.json`);
}

export async function readAccepts(stateDir: string, sessionId: string): Promise<Accept[]> {
  const path = acceptsPath(stateDir, sessionId);
  if (path === null) return [];
  try {
    const raw: unknown = await Bun.file(path).json();
    if (!Array.isArray(raw)) return [];
    const out: Accept[] = [];
    for (const value of raw) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as { text?: unknown; at?: unknown };
      if (typeof v.text !== "string" || typeof v.at !== "number") continue;
      out.push({ text: v.text, at: v.at });
    }
    return out.sort((a, b) => a.at - b.at);
  } catch {
    return []; // No file yet is the normal case: every session starts without one.
  }
}

/**
 * Record one accepted send. Fire-and-forget by design — a failed write costs a message its anchor,
 * never the send itself, so this must not be able to reject a POST that already reached the child.
 */
export async function addAccept(stateDir: string, sessionId: string, accept: Accept): Promise<void> {
  const path = acceptsPath(stateDir, sessionId);
  if (path === null) return;
  try {
    const accepts = await readAccepts(stateDir, sessionId);
    accepts.push(accept);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify(accepts.slice(-KEEP)));
  } catch {
    /* an unanchored message still sends */
  }
}
