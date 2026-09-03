/**
 * The standing `permissions.ask` rules, read from the CLI's own settings (SPEC 219).
 *
 * WHY THIS EXISTS. Loom's permit hook is registered on `PreToolUse` with no matcher, so it sees
 * every tool and can answer with a `permissionDecision` that overrides the CLI's own verdict. On an
 * `auto` turn — the default for every send — it exits immediately instead: `LOOM_PERMIT_POLICY` is
 * `defer`, which meant "no cards at all". The CLI is then holding a rule it cannot put on screen,
 * because loom runs it headless with `skipAutoPermissionPrompt`, so it refuses. User, 2026-08-17:
 * *"when a session needs to ask for my permission to edit something i dont get a prompt to
 * approve"*; and on 2026-08-16, deleting 48 GB took six refused calls and ended by hand.
 *
 * So `defer` has to mean "no card for what would have been allowed anyway" — which requires knowing
 * what the CLI would have ASKED about. LOOM DOES NOT DECIDE THAT. The patterns are his, read from
 * the settings the child runs under; this module only recognises a match so the question reaches a
 * screen. Nothing here can widen what is permitted: an unmatched tool is left entirely to the CLI,
 * exactly as today.
 *
 * THE SYNTAX, and the one case that is not decoration. A rule is `Tool(specifier)` or a bare `Tool`.
 * For `Bash` the specifier is a command prefix, with a trailing `:*` meaning "and anything after".
 * `Bash(rm -rf:*)` must therefore match `rm -rf /tmp/x` and NOT match `rm -r /tmp/x` — that exact
 * pair is why this module has properties instead of a table: the rule matched a SPELLING, and `rm -r`
 * walked through it while `rm -rf` was refused, on the same directory, in the same session. A
 * substring test would also match `echo rm -rf`, which is a different way to be wrong.
 */

/** One parsed rule. `spec === null` is a bare `Tool`, which matches every use of that tool. */
export interface AskRule {
  tool: string;
  spec: string | null;
}

/** Tools whose specifier is a PATH glob rather than a command prefix. */
const PATH_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);

/**
 * `Tool(spec)` → `{tool, spec}`; `Tool` → `{tool, spec: null}`. Anything that is not one of those two
 * shapes is DROPPED rather than guessed at: a half-understood rule that silently matches nothing is
 * indistinguishable from no rule, and one that silently matches everything is a card per tool call.
 */
export function parseAskRules(list: readonly string[]): AskRule[] {
  const out: AskRule[] = [];
  for (const raw of list) {
    const rule = raw.trim();
    if (rule.length === 0) continue;
    const open = rule.indexOf("(");
    if (open < 0) {
      if (/^[A-Za-z_][\w-]*$/.test(rule)) out.push({ tool: rule, spec: null });
      continue;
    }
    if (!rule.endsWith(")")) continue;
    const tool = rule.slice(0, open).trim();
    const spec = rule.slice(open + 1, -1).trim();
    if (!/^[A-Za-z_][\w-]*$/.test(tool) || spec.length === 0) continue;
    out.push({ tool, spec });
  }
  return out;
}

/**
 * A segment-aware glob: `**` crosses `/`, `*` and `?` do not.
 *
 * A doubled star FOLLOWED BY A SLASH compiles to "any number of WHOLE directories, including none",
 * never to a bare "anything". The difference is not pedantry: with the loose version, the rule
 * `.mcp.json` — which is matched as a doubled star, a slash, then the name — also matched
 * `/any/where/not-.mcp.json`, because "anything" ate the slash and the `not-` along with it. Found
 * by this module's own property on its first run, which is the only reason it is not shipped.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        out += "(?:.*/)?";
      } else {
        out += ".*";
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Does this path match the rule's glob? A rule without a leading `/` or `~` is RELATIVE and matches
 * anywhere in the tree — `Edit(.claude/skills/**)` is about every skills directory, not one. That is
 * the reading that makes his standing list mean what he wrote it to mean; an absolute rule stays
 * absolute and is compared whole.
 */
export function matchesPath(spec: string, path: string, home: string): boolean {
  const expanded = spec.startsWith("~/") ? `${home}/${spec.slice(2)}` : spec;
  if (expanded.startsWith("/")) return globToRegExp(expanded).test(path);
  return globToRegExp(`**/${expanded}`).test(path) || globToRegExp(expanded).test(path);
}

/**
 * Does this command match the rule's prefix?
 *
 * `cmd:*` is a prefix that must end ON A BOUNDARY — the end of the command, or whitespace. Without
 * the boundary, `rm -rf:*` matches `rm -rfx`; with a substring test instead of a prefix, it matches
 * `echo rm -rf`. Both are the same class of mistake as the one that let `rm -r` through.
 */
export function matchesCommand(spec: string, command: string): boolean {
  const cmd = command.trim();
  if (!spec.endsWith(":*")) return cmd === spec.trim();
  const prefix = spec.slice(0, -2).trim();
  if (prefix.length === 0) return true;
  if (!cmd.startsWith(prefix)) return false;
  const next = cmd[prefix.length];
  return next === undefined || /\s/.test(next);
}

/** The field each tool's specifier is compared against. */
function subjectOf(tool: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const rec = input as Record<string, unknown>;
  const field = tool === "Bash" ? "command" : "file_path";
  const value = rec[field];
  return typeof value === "string" ? value : null;
}

/**
 * Would the CLI ask about this call? Loom raises a card exactly when this says yes.
 *
 * Unknown shapes answer FALSE — no card, the CLI decides as it does today. That direction is
 * deliberate: a wrong `true` interrupts him for nothing, and 2026-08-05 already measured what a card
 * per tool call does to a working session.
 */
export function matchesAsk(
  rules: readonly AskRule[],
  toolName: string,
  toolInput: unknown,
  home: string,
): boolean {
  for (const rule of rules) {
    if (rule.tool !== toolName) continue;
    if (rule.spec === null) return true;
    const subject = subjectOf(toolName, toolInput);
    if (subject === null) continue;
    if (toolName === "Bash") {
      if (matchesCommand(rule.spec, subject)) return true;
    } else if (PATH_TOOLS.has(toolName)) {
      if (matchesPath(rule.spec, subject, home)) return true;
    }
  }
  return false;
}

/**
 * The `ask` list out of a settings file. Unreadable, absent or malformed all answer "no rules",
 * never a throw: losing the file must degrade to today's behaviour rather than taking a send down.
 */
export async function readAskRules(settingsPath: string): Promise<AskRule[]> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(settingsPath).text());
    if (typeof parsed !== "object" || parsed === null) return [];
    const perms = (parsed as Record<string, unknown>)["permissions"];
    if (typeof perms !== "object" || perms === null) return [];
    const ask = (perms as Record<string, unknown>)["ask"];
    if (!Array.isArray(ask)) return [];
    return parseAskRules(ask.filter((a): a is string => typeof a === "string"));
  } catch {
    return [];
  }
}
