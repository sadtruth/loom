/**
 * The recap agent (SPEC §Recap, requirements 171, 172, 177).
 *
 * One `claude --print` child, cheapest model, no tools, no MCP. It is handed everything it needs in
 * its prompt — the brief and the git window — so it never reads the repository and cannot wander.
 *
 * Requirement 177 is the reason for `scratchDir`: Claude Code derives a transcript store slug from
 * the child's CWD, and `server/train.ts` lists EVERY `.jsonl` in a record's store as one of its
 * sessions. A recap child spawned in the record's directory would therefore show up in the session
 * picker as a car nobody started. Spawning it somewhere else is the whole fix.
 */
import { mkdir } from "node:fs/promises";
import type { Brief } from "./filter.ts";
import { NO_WINDOW, type Window } from "./window.ts";

export const SECTIONS = [
  "State",
  "Open threads",
  "Decisions made (with the why)",
  "Decided but never written down",
  "Landed (git-confirmed)",
  "Claimed but unconfirmed",
  "Traps",
] as const;

/**
 * Measured 2026-08-14 on the largest transcript in the project (`36d2862c`, 2.6 MB): the brief comes
 * to 53 KB and the answer lands in 45 s. 90 s was the limit on the night he read a failure as the
 * clock running out — it was not the clock, but 45 s of headroom is thin when the API is slow, and
 * the block already shows a running count, so a longer wait is visible rather than silent.
 */
export const TIMEOUT_MS = 180_000;

/** The limit as he would say it — `3:00`. A recap that hits one says WHICH one it hit. */
export function clock(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The instructions. Fixed, because the sections are a contract (requirement 171) and because the
 * one section worth having — what was decided and never written — is the one a model will quietly
 * drop if the prompt lets it.
 */
export function buildPrompt(brief: Brief, window: Window | null, title: string): string {
  return [
    "You are writing a HANDOFF RECAP of a finished work session, for the person and the assistant",
    "who open the NEXT session on the same project. They have none of this context. Your recap is",
    "the only thing they get.",
    "",
    "The failure this exists to prevent is NOT that the next session forgets the plot. It is that",
    "something was decided or discovered in conversation and never written into any file, so it",
    "evaporated. Hunt for those specifically.",
    "",
    "## Rules",
    "",
    "1. His own words are the ground truth for intent. When he stated a requirement, a correction or",
    "   a preference, QUOTE HIM verbatim, in quotes. Never paraphrase a correction — the paraphrase",
    "   is where the meaning dies.",
    "2. Never claim something landed unless the git window below shows the file changed. If the",
    "   conversation says it was done and git does not confirm it, it goes under 'Claimed but",
    "   unconfirmed'.",
    "3. Under 'Decided but never written down', an item may NOT name a file that appears in the",
    "   brief's own ledger of files written — if a file records it, it was written down. Say so",
    "   plainly when the section is empty rather than padding it.",
    "4. Prefer WHY over WHAT. 'Changed X to Y' is worthless without 'because Z'. If the why is not in",
    "   the brief, say so rather than inventing one.",
    "5. No praise, no narrative, no summary of how productive the session was.",
    "6. Mark anything floated but not concluded as '(floated, not decided)'.",
    "",
    "## Output — exactly these sections, in this order, markdown, no preamble",
    "",
    ...SECTIONS.map((s) => `## ${s}`),
    "",
    "Every section appears even when it is empty; an empty one says it is empty. Under 700 words.",
    "Density over completeness: cut anything that would not change what the next session does.",
    "",
    `## The session — "${title}"`,
    "",
    brief.text,
    "",
    "## The git window",
    "",
    window === null ? NO_WINDOW : window.log.length === 0 ? "The window is empty: nothing was committed in it." : window.log,
  ].join("\n");
}

export interface RecapResult {
  ok: boolean;
  /** The recap markdown when ok, the reason when not. */
  text: string;
}

export type Spawn = (
  args: readonly string[],
  opts: { cwd: string; stdin: string; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;

const defaultSpawn: Spawn = async (args, opts) => {
  const proc = Bun.spawn([...args], {
    cwd: opts.cwd,
    stdin: new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    // NOT isolated with CLAUDE_CONFIG_DIR, though it keeps the store clean: a fresh config dir has
    // no credentials, and the child exits 1 with nothing on stderr. The store the child does create
    // is removed by the caller instead (requirement 177).
  });
  // The kill is the ONLY thing that knows a timeout happened: what reaches the caller afterwards is
  // an ordinary nonzero exit with an empty stderr, indistinguishable from a child that died on its
  // own. Remembering it here is what lets the block say "it ran out of time" instead of "exit 143".
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

export function agentArgs(bin: string): string[] {
  return [bin, "--print", "--model", "haiku", "--strict-mcp-config"];
}

/**
 * Never throws: scenario 4 says a failing recap leaves the session usable and writes nothing, so
 * every failure path returns `ok: false` with something a human can read on the block.
 */
export async function runRecap(opts: {
  bin: string;
  scratchDir: string;
  brief: Brief;
  window: Window | null;
  title: string;
  spawn?: Spawn;
  timeoutMs?: number;
}): Promise<RecapResult> {
  const spawn = opts.spawn ?? defaultSpawn;
  // The scratch directory is where the child is spawned, and a cwd that does not exist fails the
  // spawn with a bare ENOENT that reads like a missing binary. Cheap to make, once per recap.
  try {
    await mkdir(opts.scratchDir, { recursive: true });
  } catch {
    // A directory that cannot be made will surface as the spawn failure below, with its own message.
  }
  const prompt = buildPrompt(opts.brief, opts.window, opts.title);
  const limit = opts.timeoutMs ?? TIMEOUT_MS;
  let res: { code: number; stdout: string; stderr: string; timedOut?: boolean };
  try {
    res = await spawn(agentArgs(opts.bin), {
      cwd: opts.scratchDir,
      stdin: prompt,
      timeoutMs: limit,
    });
  } catch (error) {
    return { ok: false, text: `the recap could not start: ${String(error)}` };
  }
  const out = res.stdout.trim();
  // The clock first: a killed child also exits nonzero, so the exit branch below would swallow it.
  if (res.timedOut === true) return { ok: false, text: `the recap ran out of time after ${clock(limit)}` };
  if (res.code !== 0) return { ok: false, text: `the recap failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}` };
  if (out.length === 0) return { ok: false, text: "the recap came back empty" };
  return { ok: true, text: out };
}

/**
 * Which promised sections a recap actually has — requirement 171, checkable rather than hoped for.
 *
 * Heading DEPTH is not part of the contract. The prompt asks for `## State`; the first real run
 * against Haiku came back with `# State` for all seven, and a depth-strict check called a complete
 * recap completely empty. A gate that rejects every valid answer is worse than no gate.
 */
export function missingSections(recap: string): string[] {
  return SECTIONS.filter(
    (s) => !new RegExp(`^#{1,3}\\s+${s.replace(/[()]/g, "\\$&")}\\s*$`, "m").test(recap),
  );
}
