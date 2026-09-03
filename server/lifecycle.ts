/**
 * A project record's OWN status — the third region loom may write (SPEC 65–66).
 *
 * `server/tasks.ts` closes work items; this module closes the project holding them. Two edits, each
 * one line span: the `status:` field inside the frontmatter, and a `**Verdict …**` paragraph at the
 * end of `## Where it stands`. Everything else is copied byte-for-byte, the same confinement rule
 * the task writes live under, hunted by `tests/props/lifecycle.props.test.ts`.
 *
 * The states are not invented here — they are the `project` skill's lifecycle table, and `done`
 * carries its rule with it: a project closes on a VERDICT, never on a finished task list. That gate
 * is enforced at the route, so a `done` cannot arrive without one.
 */

/** The `project` skill's lifecycle table, borrowed rather than minted. */
export const PROJECT_STATUSES = ["framing", "active", "parked", "done", "abandoned"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

const HEADING = /^#{1,6}\s/;
/** `## Where it stands — 2026-08-06`: the skill lets the heading carry a date. */
const STANDS_HEADING = /^#{2,3}\s+Where it stands\b/i;
const STATUS_FIELD = /^status:[ \t]*/;
const TYPE_FIELD = /^type:[ \t]*/;
const VERDICT_LEAD = /^\*\*Verdict\b/i;

/** Index of the frontmatter's closing `---`, or -1 when the file has no frontmatter. */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") return -1;
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === "---") return i;
  return -1;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Rewrite the record's `status:` field. A record without one gets it under `type:`, where the
 * skill's own template puts it — the alternative, refusing, would strand exactly the hand-written
 * records this is most useful on.
 */
export function setProjectStatus(text: string, status: ProjectStatus): string {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end < 0) throw new Error("this file has no frontmatter — it is not a project record");

  const line = `status: ${status}`;
  for (let i = 1; i < end; i += 1) {
    if (STATUS_FIELD.test(lines[i] ?? "")) {
      return [...lines.slice(0, i), line, ...lines.slice(i + 1)].join("\n");
    }
  }

  let at = 1;
  for (let i = 1; i < end; i += 1) if (TYPE_FIELD.test(lines[i] ?? "")) at = i + 1;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n");
}

/**
 * Write the verdict into `## Where it stands`, replacing the one already there.
 *
 * Replacing rather than appending is what makes a second close idempotent — the same rule a task's
 * `result:` follows. A record with no such section is refused: loom does not invent sections in
 * User's vault, and the section is one the skill's linter requires anyway.
 */
export function setVerdict(text: string, verdict: string, date: string): string {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => STANDS_HEADING.test(line));
  if (heading < 0) {
    throw new Error("this record has no `Where it stands` section — the verdict has nowhere to go");
  }

  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (HEADING.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  const body = `**Verdict — ${date}.** ${oneLine(verdict)}`;

  for (let i = heading + 1; i < end; i += 1) {
    if (!VERDICT_LEAD.test(lines[i] ?? "")) continue;
    // The old verdict's whole paragraph goes, so a rewritten one cannot leave half of the previous.
    let to = i + 1;
    while (to < end && (lines[to] ?? "").trim().length > 0) to += 1;
    return [...lines.slice(0, i), body, ...lines.slice(to)].join("\n");
  }

  // Otherwise it lands at the section's end, past the blank lines that separate it from the next.
  let at = end;
  while (at > heading + 1 && (lines[at - 1] ?? "").trim().length === 0) at -= 1;
  return [...lines.slice(0, at), "", body, ...lines.slice(at)].join("\n");
}
