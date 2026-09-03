/**
 * `hasUnfinishedBackgroundWork` — the predicate the idle timer and the child cap both consult
 * before cutting a session (`server/background-work.ts`).
 *
 * Every row shape below is copied off a real transcript in
 * `~/.claude/projects/-home-user-resilio-docs-Projects-Personal-Claude/`, not imagined. That is
 * the point of the file: the first build of this predicate passed 563 tests and answered FALSE
 * while a background command was running, because a `run_in_background` Bash gets a `tool_result`
 * back IMMEDIATELY — the acknowledgement, not the output — and the code cleared its pending entry
 * on that result. The completion arrives much later, as a user row whose `message.content` is a
 * plain STRING holding `<task-notification>`.
 *
 * So the load-bearing pins are the two that bracket that mistake: "ack only ⇒ true" and "ack then
 * notification ⇒ false". Delete the ack handling and the first goes red; delete the notification
 * handling and the second does.
 */

import { describe, expect, test } from "bun:test";
import { hasUnfinishedBackgroundWork } from "../../server/background-work.ts";

type Row = Record<string, unknown>;

const bashLaunch = (id: string): Row => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 3600", run_in_background: true } }],
  },
});

const foregroundBash = (id: string): Row => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] },
});

const agentLaunch = (id: string): Row => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: "fs", prompt: "look" } }] },
});

const toolResult = (id: string, content: unknown): Row => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});

/** The literal text a background Bash gets back the instant it starts. */
const bashAck = (taskId: string) =>
  `Command running in background with ID: ${taskId}. Output is being written to: /tmp/${taskId}.output. You will be notified when it completes.`;

/** The literal text an async Agent launch gets back, as a content BLOCK rather than a string. */
const agentAck = (agentId: string) => [
  { type: "text", text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)` },
];

/** The completion, as a user row whose content is a bare string. */
const notification = (body: string): Row => ({
  type: "user",
  message: { role: "user", content: `<task-notification>\n${body}\n</task-notification>` },
});

describe("a background Bash command", () => {
  test("its immediate acknowledgement is NOT its completion", () => {
    const rows = [bashLaunch("toolu_1"), toolResult("toolu_1", bashAck("b3z634l9z"))];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(true);
  });

  test("the notification naming its task id ends it", () => {
    const rows = [
      bashLaunch("toolu_1"),
      toolResult("toolu_1", bashAck("b3z634l9z")),
      notification("<task-id>b3z634l9z</task-id>\n<status>completed</status>"),
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });

  test("a notification for a DIFFERENT task leaves it running", () => {
    const rows = [
      bashLaunch("toolu_1"),
      toolResult("toolu_1", bashAck("b3z634l9z")),
      notification("<task-id>someone-else</task-id>\n<status>completed</status>"),
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(true);
  });

  test("a notification carrying only the tool-use id ends it too", () => {
    const rows = [
      bashLaunch("toolu_1"),
      toolResult("toolu_1", bashAck("b3z634l9z")),
      notification("<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>"),
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });

  test("a launch whose result has not even arrived yet is in flight", () => {
    expect(hasUnfinishedBackgroundWork([bashLaunch("toolu_1")])).toBe(true);
  });

  test("an ordinary foreground Bash is never tracked at all", () => {
    const rows = [foregroundBash("toolu_1"), toolResult("toolu_1", "total 4\ndrwxr-xr-x 1 user users")];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });
});

describe("a spawned agent", () => {
  test("an async launch is in flight on its acknowledgement", () => {
    const rows = [agentLaunch("toolu_a"), toolResult("toolu_a", agentAck("af5a961b55876de66"))];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(true);
  });

  test("its notification ends it", () => {
    const rows = [
      agentLaunch("toolu_a"),
      toolResult("toolu_a", agentAck("af5a961b55876de66")),
      notification("<task-id>af5a961b55876de66</task-id>\n<tool-use-id>toolu_a</tool-use-id>\n<status>completed</status>"),
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });

  test("a FOREGROUND agent's report IS its completion — that result really is the answer", () => {
    const rows = [agentLaunch("toolu_a"), toolResult("toolu_a", [{ type: "text", text: "Found it at line 40." }])];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });

  test("`failed` and `stopped` are endings as much as `completed` is", () => {
    for (const status of ["failed", "stopped"]) {
      const rows = [
        agentLaunch("toolu_a"),
        toolResult("toolu_a", agentAck("af59")),
        notification(`<task-id>af59</task-id>\n<status>${status}</status>`),
      ];
      expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
    }
  });

  /**
   * The shape that made matching on `<tool-use-id>` alone insufficient: work orphaned by a previous
   * session is reported in ONE notification carrying several `<task-id>`s and no tool-use id —
   * *"No completion record was found for 3 background agents from the previous session"*.
   */
  test("one notification can end several agents at once, by task id and with no tool-use id", () => {
    const rows = [
      agentLaunch("toolu_a"),
      toolResult("toolu_a", agentAck("a381")),
      agentLaunch("toolu_b"),
      toolResult("toolu_b", agentAck("a9a3")),
      notification("<task-id>a381</task-id>\n<task-id>a9a3</task-id>\n<status>stopped</status>"),
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });
});

describe("rows that say nothing", () => {
  test("an empty transcript has nothing in flight", () => {
    expect(hasUnfinishedBackgroundWork([])).toBe(false);
  });

  test("plain conversation is not background work", () => {
    const rows: Row[] = [
      { type: "user", message: { role: "user", content: "finish the project" } },
      { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } },
      { type: "summary", summary: "…" },
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });

  test("malformed rows are ignored rather than thrown on", () => {
    const rows: Row[] = [
      {},
      { type: "assistant" },
      { type: "assistant", message: { content: null } },
      { type: "assistant", message: { content: [null, 7, "text", { type: "tool_use" }] } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "user", message: { content: 42 } },
    ];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(false);
  });

  test("a result for a tool nobody is waiting on is harmless", () => {
    const rows = [bashLaunch("toolu_1"), toolResult("toolu_1", bashAck("b1")), toolResult("toolu_other", "whatever")];
    expect(hasUnfinishedBackgroundWork(rows)).toBe(true);
  });
});
