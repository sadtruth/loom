/**
 * The one line that says what a tool call actually DID.
 *
 * Pure and DOM-free so it can be property-tested, same reasoning as `paths.ts`. The bug it exists to
 * fix: every Bash row in a real session reads
 * `cd "/home/user/resilio/docs/Projects/Personal Claude" && …` and truncates before the part that
 * distinguishes it, so eight consecutive calls render as eight identical rows.
 */

/** `cd <dir> && rest` — the dir may be quoted, and several may be chained. */
const CD_PREFIX = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/;

/** A heredoc body is payload, not command: `cat > f <<'EOF' … EOF`. */
const HEREDOC = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

/**
 * Strip shell boilerplate from a command so the informative part survives truncation.
 *
 * Metamorphic rule this must satisfy (pinned in `tests/props/gist.props.test.ts`): prefixing any
 * command with `cd <anywhere> && ` must not change its gist. That is exactly the defect above,
 * stated as a relationship between two runs rather than a claim about one output.
 */
export function commandGist(command: string): string {
  let rest = command;
  // Chained cds (`cd a && cd b && real`) peel one at a time; bounded so a pathological input cannot
  // spin here.
  for (let i = 0; i < 8; i += 1) {
    const stripped = rest.replace(CD_PREFIX, "");
    if (stripped === rest) break;
    rest = stripped;
  }

  // A heredoc's body is many lines of content; the command is the line that opens it.
  const heredoc = HEREDOC.exec(rest);
  if (heredoc !== null) {
    const firstLine = rest.slice(0, rest.indexOf("\n") === -1 ? rest.length : rest.indexOf("\n"));
    rest = firstLine;
  }

  const flat = rest.replace(/\s+/g, " ").trim();
  // Peeling everything off (`cd /somewhere` alone) leaves nothing — then the original IS the gist.
  return flat.length > 0 ? flat : command.replace(/\s+/g, " ").trim();
}

/** The verb of a call, for the folded-run summary: `bash ×5 · read ×2`. */
export function toolVerb(name: string): string {
  return name.toLowerCase();
}

/**
 * Summarise a run of folded tool calls: `7 steps · bash ×5 · read ×2`.
 *
 * Counts in first-appearance order, so the summary reads in the order the work happened. Kept pure
 * for the same reason as the gist: it is the label a reader trusts without expanding.
 */
export function summariseRun(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const verb = toolVerb(name);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [verb, n] of counts) parts.push(n > 1 ? `${verb} ×${n}` : verb);
  const step = names.length === 1 ? "step" : "steps";
  return `${names.length} ${step} · ${parts.join(" · ")}`;
}
