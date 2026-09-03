/**
 * The recap ledger (SPEC §Recap, requirement 173).
 *
 * One file per project, beside its record, append-only. Nothing is ever edited or deleted: a re-run
 * appends a NEW entry naming the one it supersedes, and the reader shows the newest per session.
 * That is what lets scenario 7 (run it again) and scenario 6 (the session kept going after it was
 * recapped) coexist with an append-only file.
 */

export interface Entry {
  sessionId: string;
  title: string;
  /** ISO time the recap was written, not the session's own time. */
  writtenAt: string;
  /** Message count the session had when this was taken — how scenario 6's staleness is visible. */
  atTurn: number;
  supersedes: string | null;
  body: string;
}

const MARK = "<!-- recap:";
/**
 * The body may not contain the entry marker, or one entry becomes two on the way back in.
 *
 * A recap of a session about the recap ledger quotes that line — likely on this project, and
 * measured: the body was truncated at the quote and a PHANTOM entry appeared whose `written:` field
 * sorted newest, so it was the one the reader would be shown. Escaped on the way out and restored on
 * the way in, so the round trip is still byte-for-byte.
 */
const ESCAPED = "<!--\\ recap:";

export function render(entry: Entry): string {
  const meta = [
    `session: ${entry.sessionId}`,
    `written: ${entry.writtenAt}`,
    `at-turn: ${entry.atTurn}`,
    ...(entry.supersedes === null ? [] : [`supersedes: ${entry.supersedes}`]),
  ].join(" · ");
  const body = entry.body.trim().replaceAll(MARK, ESCAPED);
  return [`${MARK} ${meta} -->`, "", `## ${entry.title}`, "", body, ""].join("\n");
}

export function parse(text: string): Entry[] {
  const out: Entry[] = [];
  const parts = text.split(MARK);
  for (const part of parts.slice(1)) {
    const close = part.indexOf("-->");
    if (close < 0) continue;
    const head = part.slice(0, close);
    const rest = part.slice(close + 3);
    const field = (name: string): string | null => {
      const m = new RegExp(`${name}:\\s*([^·\\n]+)`).exec(head);
      return m?.[1]?.trim() ?? null;
    };
    const sessionId = field("session");
    if (sessionId === null) continue;
    const titleMatch = /^\s*##\s+(.+)$/m.exec(rest);
    out.push({
      sessionId,
      title: titleMatch?.[1]?.trim() ?? "(untitled)",
      writtenAt: field("written") ?? "",
      atTurn: Number(field("at-turn") ?? "0"),
      supersedes: field("supersedes"),
      body: rest.replace(/^\s*##\s+.+$/m, "").trim().replaceAll(ESCAPED, MARK),
    });
  }
  return out;
}

/**
 * What the reader shows: one entry per session, the newest kept. Superseded entries stay in the
 * file — the history of what we thought is part of the record — but never reach the screen twice.
 */
export function newestPerSession(entries: readonly Entry[]): Entry[] {
  const bySession = new Map<string, Entry>();
  for (const e of entries) {
    const prev = bySession.get(e.sessionId);
    if (prev === undefined || e.writtenAt >= prev.writtenAt) bySession.set(e.sessionId, e);
  }
  // sessionId tiebreak: writtenAt ties otherwise make the order input-dependent
  // (props requirement 173 caught the flake; first surfaced by a delegate, 2026-09-02).
  return [...bySession.values()].sort((a, b) => b.writtenAt.localeCompare(a.writtenAt) || a.sessionId.localeCompare(b.sessionId));
}

/** The entry a new session should show, or null when that session has never been recapped. */
export function entryFor(entries: readonly Entry[], sessionId: string): Entry | null {
  return newestPerSession(entries).find((e) => e.sessionId === sessionId) ?? null;
}

/** Append-only by construction: the previous text is never inspected, only extended. */
export function append(existing: string, entry: Entry): string {
  const head = existing.trimEnd();
  return head.length === 0 ? render(entry) : `${head}\n\n${render(entry)}`;
}
