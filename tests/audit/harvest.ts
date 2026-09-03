/**
 * Harvest every message the assistant ever posted, out of the Claude Code transcript store.
 *
 * Pure apart from the file reads, so the properties can hunt malformed rows without a store. It
 * deliberately does NOT decide what a link is: that judgement belongs to loom's own
 * `renderMarkdown`, running in a browser (see `link-audit.ts`). All this does is find the text and
 * the two facts a chip needs around it — the session it was written in, and the cwd it was written
 * from, which is what a relative path resolves against.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseTranscript } from "../../server/transcript.ts";

export interface Posted {
  /** Transcript file stem — the session id. */
  session: string;
  /** The project directory the session lived in, as the store names it. */
  project: string;
  /** ISO timestamp of the message, or "" when the row carried none. */
  when: string;
  /** The session's cwd, which is what `base` is for a relative chip. */
  cwd: string | null;
  text: string;
}

/**
 * A message worth rendering. Rendering every assistant turn in a browser costs hours and answers
 * nothing for a turn that cannot contain a link, so the cheap pre-filter is: a path has a slash and
 * a wiki link has `[[`. This is a COVERAGE decision, not a correctness one — nothing here decides
 * whether a link is good, only whether the text is worth handing to loom — and the report prints
 * how many messages it skipped for this reason.
 */
export function mightCarryALink(text: string): boolean {
  return text.includes("/") || text.includes("[[");
}

/** Every assistant text block in one transcript file's text. */
export function postedIn(session: string, project: string, jsonl: string): Posted[] {
  const model = parseTranscript(jsonl);
  const cwd = model.meta.cwd;
  const out: Posted[] = [];
  for (const message of model.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.kind !== "text") continue;
      const text = block.text;
      if (typeof text !== "string" || text.length === 0) continue;
      out.push({ session, project, when: message.ts, cwd, text });
    }
  }
  return out;
}

export interface HarvestStats {
  projects: number;
  sessions: number;
  messages: number;
  /** Skipped by `mightCarryALink` — reported, never hidden. */
  skipped: number;
  /** Transcript files that could not be read or parsed at all. */
  unreadable: number;
}

/**
 * Walk the whole store. `onSession` is called per transcript so a caller can stream rather than
 * hold 1.3 GB of messages, and the stats come back at the end as the coverage witness. Returning
 * `false` from it ends the walk — without that, a `--limit` run still reads every remaining
 * transcript and the flag saves nothing.
 */
export async function harvest(
  root: string,
  onSession: (posted: Posted[]) => Promise<boolean | void> | boolean | void,
): Promise<HarvestStats> {
  const stats: HarvestStats = { projects: 0, sessions: 0, messages: 0, skipped: 0, unreadable: 0 };
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return stats;
  }

  for (const project of dirs.sort()) {
    let files: string[];
    try {
      files = (await readdir(join(root, project))).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue; // not a project directory
    }
    if (files.length === 0) continue;
    stats.projects += 1;

    for (const file of files.sort()) {
      const session = file.replace(/\.jsonl$/, "");
      let text: string;
      try {
        text = await Bun.file(join(root, project, file)).text();
      } catch {
        stats.unreadable += 1;
        continue;
      }
      let posted: Posted[];
      try {
        posted = postedIn(session, project, text);
      } catch {
        stats.unreadable += 1;
        continue;
      }
      stats.sessions += 1;
      stats.messages += posted.length;
      const worth = posted.filter((p) => mightCarryALink(p.text));
      stats.skipped += posted.length - worth.length;
      if (worth.length > 0 && (await onSession(worth)) === false) return stats;
    }
  }
  return stats;
}
