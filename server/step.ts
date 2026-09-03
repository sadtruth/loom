/**
 * The step in flight — what the working indication says beside the spinner (SPEC §Working
 * indication).
 *
 * The frame is the project's: a spinner alone is a lie, because it spins just as happily on a hung
 * child. So the indication carries one fact that advances ONLY when the work advances, and this
 * module is where that fact is derived and then QUIETED so it stays legible.
 *
 * WHAT THE WIRE ACTUALLY LOOKS LIKE (captured from the real binary, not assumed —
 * `tests/fixture/real-stdout-frames.jsonl`, `tests/fixture/capture-frames.ts`). Two findings here
 * cost nothing to learn and would have cost a rewrite to discover later:
 *
 *   1. **One content block per `assistant` frame.** A parallel batch of two Reads did NOT arrive as
 *      one frame with two `tool_use` blocks; it arrived as two frames, with the first tool_result
 *      between them. So "collapse a burst of parallel calls" cannot be per-frame grouping — it has
 *      to be TEMPORAL, which is what the window below does.
 *   2. **`system`/`thinking_tokens` frames carry a live token counter** (`estimated_tokens_delta`),
 *      and it RESETS per thinking block. Summed across the turn it is the best answer this stream
 *      has to "the model is between tools and still working": a number that moves only because the
 *      model produced tokens. That is the honesty requirement, met by a counter rather than a clock.
 *
 * The clock is deliberately NOT the fact. User, 2026-08-07: *"elapsed since send is not very
 * useful. I suppose something about the tool or exact thing being done."* Elapsed comes back only in
 * the overstay rule, which lives in the client: the label freezes, and a frozen label starts
 * admitting how long it has been frozen. The mechanism that makes that honest is here — the overstay
 * clock resets on every label CHANGE, so a step that keeps changing can never look stalled, and a
 * step that stops changing always does.
 */

/** How long a shown label holds before a different one may replace it (SPEC 96). */
export const HOLD_MS = 800;

/** Labels are one line in the tightest row loom has; past this they are cut with an ellipsis. */
const MAX_LABEL = 64;

export interface Call {
  tool: string;
  label: string;
}

/** What one stdout frame means for the step. `null` = the frame says nothing about it. */
export type Signal =
  | { kind: "call"; call: Call }
  | { kind: "think"; delta: number }
  | { kind: "text" }
  | null;

function clip(text: string, max = MAX_LABEL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function base(path: unknown): string {
  const text = typeof path === "string" ? path : "";
  // Blank segments are dropped, not just empty ones: a whitespace-only name survived `length > 0`,
  // got collapsed by `clip`, and left the label reading `reading` with nothing after it. Found by
  // the basename property, shrunk to the path `"/ "`.
  const cut = text.split("/").filter((p) => p.trim().length > 0).pop();
  return cut ?? "a file";
}

function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function host(url: unknown): string {
  if (typeof url !== "string") return "a page";
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 30);
  }
}

/**
 * One tool call, phrased as an ACT rather than as its API name — `reading tasks.ts`, never `Read`.
 * User does not read loom's code and has no reason to know the tool vocabulary; what he is owed is
 * the sentence a person would say about what is happening.
 */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return clip(`reading ${base(input["file_path"] ?? input["notebook_path"])}`);
    case "Write":
      return clip(`writing ${base(input["file_path"])}`);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return clip(`editing ${base(input["file_path"] ?? input["notebook_path"])}`);
    case "Bash":
      // The CLI's own one-line description when the model wrote one, the command itself otherwise.
      return clip(`running ${str(input, "description") ?? str(input, "command") ?? "a command"}`);
    case "BashOutput":
    case "KillShell":
      return "checking a background command";
    case "Grep":
      return clip(`searching for ${str(input, "pattern") ?? "something"}`);
    case "Glob":
      return clip(`listing ${str(input, "pattern") ?? "files"}`);
    case "Task":
    case "Agent":
      return clip(`delegating to ${str(input, "subagent_type") ?? str(input, "description") ?? "an agent"}`);
    case "WebFetch":
      return clip(`fetching ${host(input["url"])}`);
    case "WebSearch":
      return clip(`searching the web for ${str(input, "query") ?? "something"}`);
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "updating the plan";
    case "Skill":
      return clip(`loading the ${str(input, "skill") ?? "skill"} skill`);
    case "ExitPlanMode":
      return "presenting the plan";
    case "ToolSearch":
      return "looking for a tool";
    default: {
      // MCP tools arrive as mcp__<server>__<tool>; the tool half is the only readable part.
      const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(tool);
      const name = (mcp?.[1] ?? tool).replace(/_/g, " ");
      return clip(`running ${name}`);
    }
  }
}

/** Plural act for a burst of same-kind calls. Absent here, the group falls back to `+N more`. */
const PLURAL: Record<string, (n: number) => string> = {
  Read: (n) => `reading ${n} files`,
  Write: (n) => `writing ${n} files`,
  Edit: (n) => `editing ${n} files`,
  MultiEdit: (n) => `editing ${n} files`,
  NotebookEdit: (n) => `editing ${n} files`,
  Bash: (n) => `running ${n} commands`,
  Grep: (n) => `running ${n} searches`,
  Glob: (n) => `listing ${n} patterns`,
  WebFetch: (n) => `fetching ${n} pages`,
  WebSearch: (n) => `running ${n} web searches`,
  Task: (n) => `running ${n} agents`,
  Agent: (n) => `running ${n} agents`,
};

/**
 * What a whole window of calls collapses to. This is the "don't make it flicker" rule made concrete:
 * ten Greps fired in a second are ONE line, not ten. Same-kind bursts get a plural act; a mixed
 * burst names the first call and counts the rest, because the first is the stable one — describing
 * the last would make the line change every time another call landed inside the same window.
 */
export function describeGroup(calls: Call[]): string {
  const first = calls[0];
  if (first === undefined) return "working";
  if (calls.length === 1) return first.label;
  if (calls.every((c) => c.tool === first.tool)) {
    const plural = PLURAL[first.tool];
    if (plural !== undefined) return clip(plural(calls.length));
  }
  return clip(`${first.label} +${calls.length - 1} more`, MAX_LABEL);
}

/** Token counts are read at a glance or not at all: 842, then 1.2k. */
function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * One stdout frame → what it says about the step. Every field named here was read off the real
 * capture; nothing is inferred from the SDK's documentation.
 */
export function readSignal(row: Record<string, unknown>): Signal {
  const type = row["type"];

  if (type === "system" && row["subtype"] === "thinking_tokens") {
    const delta = Number(row["estimated_tokens_delta"] ?? 0);
    return Number.isFinite(delta) && delta > 0 ? { kind: "think", delta } : null;
  }

  if (type !== "assistant") return null;
  const message = row["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (!Array.isArray(content)) return null;

  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      const input = (block["input"] ?? {}) as Record<string, unknown>;
      return { kind: "call", call: { tool: block["name"], label: describeCall(block["name"], input) } };
    }
    if (block["type"] === "text") return { kind: "text" };
  }
  return null;
}

/** Undo a booked flush. */
type Cancel = () => void;

/**
 * Time, injected. Not ceremony: the floor is a rule ABOUT time, and a rule about time tested against
 * the real clock is tested a handful of times, slowly. Against a virtual one, `fast-check` can hunt
 * counterexamples over hundreds of arrival patterns in a second — which is the only way the strobe
 * rule gets checked on schedules nobody thought to write down.
 */
export interface Clock {
  now(): number;
  after(ms: number, fn: () => void): Cancel;
}

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};

/**
 * The quieting rule (SPEC 96), as one object per live child.
 *
 * A window collects everything that arrives since the last change. When the floor has passed, the
 * window collapses to ONE label and replaces what is shown. Inside a window a tool call OUTRANKS
 * thinking — a concrete act is the fact worth showing, and thinking is what fills the gaps between
 * acts, so a window that saw both names the act.
 *
 * The floor is a floor, never a ceiling: nothing here delays a label, it only refuses to replace one
 * too soon, and the turn's end (`reset`) is not floored at all.
 */
export class Stepper {
  private shown: string | null = null;
  private shownAt = 0;
  private calls: Call[] = [];
  private filler: string | null = null;
  private timer: Cancel | null = null;
  private thought = 0;

  constructor(
    private readonly emit: (label: string) => void,
    private readonly hold: number = HOLD_MS,
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  private now(): number {
    return this.clock.now();
  }

  /** The label currently shown, and how long it has been shown — what a late-joining device needs. */
  label(): string | null {
    return this.shown;
  }

  sinceMs(): number {
    return this.shown === null ? 0 : Math.max(0, this.now() - this.shownAt);
  }

  feed(row: Record<string, unknown>): void {
    const signal = readSignal(row);
    if (signal === null) return;
    if (signal.kind === "call") this.calls.push(signal.call);
    else if (signal.kind === "think") {
      this.thought += signal.delta;
      this.filler = `thinking · ${tokens(this.thought)}`;
    } else this.filler = "writing the reply";
    this.schedule();
  }

  /** End of turn: the label and the turn's thinking counter both belong to the turn that is over. */
  reset(): void {
    if (this.timer !== null) this.timer();
    this.timer = null;
    this.shown = null;
    this.calls = [];
    this.filler = null;
    this.thought = 0;
  }

  private schedule(): void {
    if (this.timer !== null) return; // a flush is already booked; this window rides along
    const waited = this.now() - this.shownAt;
    if (this.shown === null || waited >= this.hold) {
      this.flush();
      return;
    }
    this.timer = this.clock.after(this.hold - waited, () => {
      this.timer = null;
      this.flush();
    });
  }

  private flush(): void {
    const next = this.calls.length > 0 ? describeGroup(this.calls) : this.filler;
    this.calls = [];
    this.filler = null;
    if (next === null || next === this.shown) return;
    this.shown = next;
    this.shownAt = this.now();
    this.emit(next);
  }
}
