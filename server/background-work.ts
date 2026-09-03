/**
 * Is this session waiting on work it started and has not been told about yet?
 *
 * The idle timer and the child cap both used to answer "nobody is using it" for a session that had
 * launched an hour-long sweep and was sitting quietly waiting for the completion notification. On
 * 2026-09-01 that killed a session mid-investigation — SIGKILL took the background subprocess with
 * it, so the output never landed at all, and the resume re-wrote 174,202 tokens. User: *"this is
 * a catastrophe!"*
 *
 * Pure over parsed transcript rows, so the policy can be pinned without a clock, a process or a
 * file. The Runner owns the reading (`input.ts`, `backgroundWork`); this owns the judgement.
 *
 * ## What the transcript actually looks like, which is the whole difficulty
 *
 * A `run_in_background` Bash call's `tool_result` comes back IMMEDIATELY, and it is not the
 * command's output — it is an acknowledgement, `Command running in background with ID: b3z634l9z.`
 * An async `Agent` launch has the same shape: `Async agent launched successfully. … agentId: af59…`.
 * So a predicate that clears a pending entry on its `tool_result`, which is the obvious way to
 * write this, reports "nothing in flight" the instant the work starts. That is the bug the first
 * build shipped with all 563 tests green.
 *
 * The real completion arrives much later as a separate USER row whose `message.content` is a plain
 * STRING, not an array of blocks:
 *
 * ```
 * <task-notification>
 * <task-id>af5a961b55876de66</task-id>
 * <tool-use-id>toolu_01XM5vW8tE937qkyh7eRB6pB</tool-use-id>
 * <status>completed</status>
 * ```
 *
 * Both ids are matched, because neither is always present: a notification for work orphaned by a
 * previous session carries several `<task-id>`s and no `<tool-use-id>` at all, under
 * `<status>stopped</status>` — *"No completion record was found for 3 background agents from the
 * previous session"*.
 */

/** One launched-and-unreported piece of work, keyed by the `tool_use` id that started it. */
interface Pending {
  /** A background Bash never clears on its `tool_result`; only a notification ends it. */
  kind: "bash" | "agent";
  /** The background task / agent id, learned from the acknowledgement text. */
  taskId: string | null;
}

/** The acknowledgement a `run_in_background` Bash gets back the moment it starts. */
const BASH_ACK = /background with ID: ([A-Za-z0-9_-]+)/;
/** The acknowledgement an async `Agent` gets back the moment it starts. */
const AGENT_ACK = /agentId: ([A-Za-z0-9_-]+)/;

const TASK_ID = /<task-id>([^<]+)<\/task-id>/g;
const TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

/** A row's text, whether the CLI wrote it as a bare string or as a list of content blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (typeof block === "string") out += block;
    else if (block !== null && typeof block === "object") {
      const text = (block as Record<string, unknown>)["text"];
      if (typeof text === "string") out += text;
    }
  }
  return out;
}

function allMatches(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) if (m[1] !== undefined) out.add(m[1]);
  return out;
}

/**
 * True when the session has launched background work that has not reported back. `rows` are the
 * transcript's parsed JSONL lines, oldest first; the caller drops the unparseable ones.
 */
export function hasUnfinishedBackgroundWork(rows: Array<Record<string, unknown>>): boolean {
  const pending = new Map<string, Pending>();

  for (const row of rows) {
    const message = row["message"] as Record<string, unknown> | undefined;
    if (message === undefined || message === null) continue;

    if (row["type"] === "assistant") {
      const content = message["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_use") continue;
        const id = b["id"];
        if (typeof id !== "string") continue;
        const name = b["name"];
        const input = b["input"] as Record<string, unknown> | undefined;
        if (name === "Bash" && input?.["run_in_background"] === true) {
          pending.set(id, { kind: "bash", taskId: null });
        } else if (name === "Agent" || name === "Task") {
          pending.set(id, { kind: "agent", taskId: null });
        }
      }
      continue;
    }

    if (row["type"] !== "user") continue;
    const content = message["content"];

    // A completion notification ends every piece of work it names, by whichever id it carries.
    const text = textOf(content);
    if (text.includes("<task-notification>")) {
      const taskIds = allMatches(text, TASK_ID);
      const toolUseIds = allMatches(text, TOOL_USE_ID);
      for (const [id, entry] of pending) {
        if (toolUseIds.has(id) || (entry.taskId !== null && taskIds.has(entry.taskId))) pending.delete(id);
      }
    }

    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b["type"] !== "tool_result") continue;
      const forId = b["tool_use_id"];
      if (typeof forId !== "string") continue;
      const entry = pending.get(forId);
      if (entry === undefined) continue;

      const ack = (entry.kind === "bash" ? BASH_ACK : AGENT_ACK).exec(textOf(b["content"]));
      if (ack !== null && ack[1] !== undefined) {
        // The launch acknowledgement, not the answer — keep it pending, and remember the id the
        // notification will name it by.
        entry.taskId = ack[1];
      } else if (entry.kind === "agent") {
        // A foreground agent hands back its whole report here; that IS its completion.
        pending.delete(forId);
      }
      // A background Bash's tool_result is always the acknowledgement, so it never clears here.
    }
  }

  return pending.size > 0;
}
