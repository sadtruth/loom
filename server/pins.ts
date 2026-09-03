/**
 * Pin sidecar. SPEC §15 — state/pins/<session-id>.json, shape { "<uuid>": { note, ts } }.
 *
 * SPEC invariant 1: the loom never writes anything Claude Code reads. Pins therefore live here,
 * never in the transcript.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Pin {
  note: string | null;
  ts: string;
}

export type PinMap = Record<string, Pin>;

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function pinsPath(stateDir: string, sessionId: string): string | null {
  // A session id reaches this from a URL; anything that could escape state/ is refused outright.
  if (!SAFE_ID.test(sessionId)) return null;
  return join(stateDir, "pins", `${sessionId}.json`);
}

export async function readPins(stateDir: string, sessionId: string): Promise<PinMap> {
  const path = pinsPath(stateDir, sessionId);
  if (path === null) return {};
  try {
    const raw: unknown = await Bun.file(path).json();
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: PinMap = {};
    for (const [uuid, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as { note?: unknown; ts?: unknown };
      out[uuid] = {
        note: typeof v.note === "string" ? v.note : null,
        ts: typeof v.ts === "string" ? v.ts : "",
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function setPin(
  stateDir: string,
  sessionId: string,
  uuid: string,
  pinned: boolean,
  note: string | null,
  now: string,
): Promise<PinMap> {
  const path = pinsPath(stateDir, sessionId);
  if (path === null) throw new Error("unsafe session id");
  const pins = await readPins(stateDir, sessionId);
  if (pinned) pins[uuid] = { note, ts: now };
  else delete pins[uuid];
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(pins, null, 2)}\n`);
  return pins;
}
