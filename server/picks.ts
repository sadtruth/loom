import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface SessionPick {
  model: string;
  effort: string;
  mode: "auto" | "cards";
  at: number;
}

/**
 * A stored entry in picks.json.
 */
type Entry = { session: string; pick: SessionPick };

function picksPath(stateDir: string): string {
  return join(stateDir, "picks.json");
}

function parseEntry(line: string): Entry | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    const session = obj["session"];
    if (typeof session !== "string" || session.length === 0) return null;
    const pickObj = obj["pick"] as Record<string, unknown>;
    if (typeof pickObj !== "object" || pickObj === null) return null;
    if (typeof pickObj["model"] !== "string") return null;
    if (typeof pickObj["effort"] !== "string") return null;
    if (pickObj["mode"] !== "auto" && pickObj["mode"] !== "cards") return null;
    if (typeof pickObj["at"] !== "number") return null;
    const pick: SessionPick = {
      model: pickObj["model"],
      effort: pickObj["effort"],
      mode: pickObj["mode"],
      at: pickObj["at"],
    };
    return { session, pick };
  } catch {
    return null;
  }
}

/**
 * Reads all picks. Unknown sessions read back `null`.
 * New format: append-only NDJSON. Last entry for a session wins.
 */
export async function readAllPicks(stateDir: string): Promise<Record<string, SessionPick>> {
  const out: Record<string, SessionPick> = Object.create(null);
  let raw: string;
  try {
    raw = await Bun.file(picksPath(stateDir)).text();
  } catch {
    return out;
  }
  const lines = raw.trim().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const entry = parseEntry(trimmed);
    if (entry === null) continue;
    out[entry.session] = entry.pick;
  }
  return out;
}

export async function readPick(stateDir: string, sessionId: string): Promise<SessionPick | null> {
  const all = await readAllPicks(stateDir);
  return Object.prototype.hasOwnProperty.call(all, sessionId) ? all[sessionId]! : null;
}

/**
 * Appends a pick.
 */
export async function writePick(
  stateDir: string,
  sessionId: string,
  pickData: Omit<SessionPick, "at">,
): Promise<void> {
  if (sessionId.length === 0) return;
  await mkdir(stateDir, { recursive: true });
  const pick: SessionPick = { ...pickData, at: Date.now() };
  const entry: Entry = { session: sessionId, pick };
  await appendFile(picksPath(stateDir), `${JSON.stringify(entry)}\n`, "utf8");
}
