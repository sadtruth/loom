/**
 * The recap filter (SPEC §Recap, requirements 170 and 178).
 *
 * Turns a session transcript into the brief a cheap model reads. No model runs here and nothing is
 * summarised: this is a projection, so the same transcript always yields the same brief.
 *
 * Why the shape it has — measured on a real 4.8 MB transcript before any of this was written:
 * user turns were 0.6% of the file, assistant text 0.4%, tool_use inputs 7%, and tool_result
 * bodies 15%. Dropping the results and keeping the conversation whole took a 1.38 MB session to
 * 115 KB. The expensive part of a transcript is the part with the least in it.
 *
 * Reading is `TranscriptParser`'s job, not ours (SPEC invariants 2 and 4): it holds back a
 * half-written final line, so a session recapped while its writer is still appending cannot
 * materialise a phantom row.
 */
import type { Block, Message, Model, Touch } from "../transcript.ts";

/** The verb whose argument is worth keeping, per tool. Anything absent contributes only its name. */
const LEDGER_ARG: Record<string, string> = {
  Bash: "command",
  Glob: "pattern",
  Grep: "pattern",
  WebFetch: "url",
  WebSearch: "query",
  Task: "description",
  Agent: "description",
  Skill: "skill",
};

const MAX_ASSISTANT = 3000;
const MAX_COMMANDS = 40;
const MAX_READS = 25;
const MAX_ARG = 180;

export interface BriefStats {
  userTurns: number;
  assistantTurns: number;
  writes: number;
  commands: number;
  bytes: number;
}

export interface Brief {
  /** What the recap agent is handed. */
  text: string;
  stats: BriefStats;
}

function textBlocks(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "text") continue;
    const t = b.text.trim();
    if (t.length > 0) out.push(t);
  }
  return out;
}

/**
 * A reminder block is context the harness injected, not something he typed — and from requirement
 * 175 onward one of them IS a previous recap. `detectMeta` already drops rows that are ENTIRELY
 * reminders; this drops the block when it rides alongside real text in the same row, which is the
 * shape that would otherwise let recap N+1 quote recap N in full (requirement 178).
 */
function isReminder(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder>");
}

function human(msg: Message): string[] {
  return textBlocks(msg.blocks).filter((t) => !isReminder(t));
}

/** Conversational rows only: his words and my replies, in order, with everything else removed. */
export function conversation(model: Model): string {
  const parts: string[] = [];
  for (const msg of model.messages) {
    if (msg.isMeta || msg.isSidechain) continue;
    if (msg.role === "system") continue;
    const texts = human(msg);
    if (texts.length === 0) continue;
    const body = texts.join("\n\n");
    if (msg.role === "user") parts.push(`[USER] ${body}`);
    else parts.push(`[CLAUDE] ${body.slice(0, MAX_ASSISTANT)}`);
  }
  return parts.join("\n\n");
}

function countRoles(model: Model): { user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  for (const msg of model.messages) {
    if (msg.isMeta || msg.isSidechain) continue;
    if (human(msg).length === 0) continue;
    if (msg.role === "user") user += 1;
    else if (msg.role === "assistant") assistant += 1;
  }
  return { user, assistant };
}

interface Ledger {
  writes: string[];
  reads: Array<{ path: string; n: number }>;
  commands: string[];
  agents: string[];
  skills: string[];
}

function ledgerOf(model: Model): Ledger {
  const writes: string[] = [];
  const readCount = new Map<string, number>();
  for (const t of model.touches as readonly Touch[]) {
    if (t.op === "read") readCount.set(t.path, (readCount.get(t.path) ?? 0) + 1);
    else writes.push(t.path);
  }
  const commands: string[] = [];
  const agents: string[] = [];
  const skills: string[] = [];
  for (const msg of model.messages) {
    if (msg.isSidechain) continue;
    for (const b of msg.blocks) {
      if (b.kind !== "tool_use") continue;
      const key = LEDGER_ARG[b.name];
      if (key === undefined) continue;
      const input = b.input;
      const raw =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)[key]
          : undefined;
      const arg = typeof raw === "string" ? raw.replace(/\s+/g, " ").slice(0, MAX_ARG) : "";
      if (arg.length === 0) continue;
      if (b.name === "Bash") commands.push(arg);
      else if (b.name === "Task" || b.name === "Agent") agents.push(arg);
      else if (b.name === "Skill") skills.push(arg);
    }
  }
  const reads = [...readCount.entries()]
    .map(([path, n]) => ({ path, n }))
    .sort((a, b) => b.n - a.n || a.path.localeCompare(b.path))
    .slice(0, MAX_READS);
  return { writes, reads, commands, agents, skills };
}

function uniq(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function section(title: string, lines: readonly string[]): string {
  const body = lines.length > 0 ? lines.map((l) => `  ${l}`).join("\n") : "  (none)";
  return `${title}\n${body}`;
}

/**
 * The brief. Its order is deliberate: the conversation first, because that is what carries intent,
 * and the mechanical ledger after, because it is evidence rather than meaning.
 */
/**
 * The rows that actually carry conversation, and therefore the session's own start and end.
 *
 * ONE definition, exported, because there were two: this one, and a looser copy in `service.ts` that
 * fed `windowFor`. The metamorphic property only ever saw the brief, so the fix that stopped an
 * injected row from setting the window landed in the copy under test and not in the copy the git
 * window was actually built from (found by the reviewer, 2026-08-13).
 */
export function spokenRows(model: Model): Model["messages"] {
  return model.messages.filter(
    (m) => !m.isMeta && !m.isSidechain && m.role !== "system" && human(m).length > 0,
  );
}

export function buildBrief(model: Model): Brief {
  const convo = conversation(model);
  const led = ledgerOf(model);
  const roles = countRoles(model);
  // The window comes from the rows that SURVIVE filtering, never from `messages[0]`. A meta row can
  // be first — and from requirement 175 onward the first row of a recapped session IS an injected
  // recap — so taking the raw ends would let an injected row set the session's start, and
  // requirement 172 derives the git window from these two values. Found by the metamorphic
  // property on its first run, counterexample: insert the meta row at index 0.
  const spoken = spokenRows(model);
  const first = spoken[0]?.ts ?? "";
  const last = spoken[spoken.length - 1]?.ts ?? "";

  const head = [
    `# session ${model.meta.id ?? "unknown"}`,
    `# ${first} -> ${last}`,
    `# cwd ${model.meta.cwd ?? "unknown"}`,
    model.meta.title === null ? "" : `# title ${model.meta.title}`,
  ].filter((l) => l.length > 0);

  const text = [
    head.join("\n"),
    "",
    "## conversation (his turns verbatim, mine truncated)",
    "",
    convo,
    "",
    "## mechanical ledger",
    "",
    section("files written or edited, in order:", led.writes),
    "",
    section(`files read (top ${MAX_READS} by count):`, led.reads.map((r) => `${r.n}x ${r.path}`)),
    "",
    `skills invoked: ${uniq(led.skills).join(", ") || "(none)"}`,
    `subagents spawned: ${uniq(led.agents).join("; ") || "(none)"}`,
    "",
    section(
      `commands (${led.commands.length} total, last ${MAX_COMMANDS}):`,
      led.commands.slice(-MAX_COMMANDS),
    ),
  ].join("\n");

  return {
    text,
    stats: {
      userTurns: roles.user,
      assistantTurns: roles.assistant,
      writes: led.writes.length,
      commands: led.commands.length,
      bytes: text.length,
    },
  };
}

/**
 * Requirement 174's floor and scenario 5's trigger, in one place: a session with nothing said in it
 * is not recapped at all. Counted AFTER filtering, because on a raw transcript almost every row is
 * a `user` row — 171 of 179 on a real file were tool results.
 */
export function worthRecapping(model: Model): boolean {
  return countRoles(model).user >= 2;
}
