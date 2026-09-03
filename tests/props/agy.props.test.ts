/**
 * Property-based and fixture tests for the agy (Google Antigravity) runner.
 *
 * Covers:
 * 1. Frame-to-transcript translation text fidelity (parsed back via server/transcript.ts).
 * 2. Tool calls preservation (tool name, parameters, and output intact).
 * 3. Resilience against malformed or unknown frames (never throws, safely dropped).
 * 4. agyArgs argv construction and shadow transcript path separation.
 * 5. Defect 1: Resumed session with missing conversation ID emits error and writes break.
 * 6. Defect 2: FIFO prompt queue across multiple queued turns before user_input frames.
 * 7. Defect 3: Cumulative result.usage differences across multiple turns.
 * 8. Defect 4: is_error is not asserted when agy does not report it.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgyFrameTranslator, translateAgyFrames } from "../../server/agy-frames.ts";
import {
  AGY_LAUNCHER,
  AGY_PROJECTS_ROOT,
  agyArgs,
  agyStdinLine,
  agyTranscriptPath,
} from "../../server/agy.ts";
import { Runner, type JobEvent, type StartRequest } from "../../server/input.ts";
import { TranscriptParser } from "../../server/transcript.ts";

/** Helper to feed lines into TranscriptParser */
function parseLines(lines: readonly string[]): ReturnType<TranscriptParser["model"]>["messages"] {
  const parser = new TranscriptParser();
  for (const line of lines) {
    parser.push(`${line}\n`);
  }
  return parser.model().messages;
}

const TWO_TURN_FIXTURE_PATH = join(import.meta.dir, "../fixtures/agy-two-turn.jsonl");
const TOOLS_FIXTURE_PATH = join(import.meta.dir, "../fixtures/agy-tools.jsonl");

const FIXTURE_TWO_TURN_FRAMES = readFileSync(TWO_TURN_FIXTURE_PATH, "utf8")
  .trim()
  .split("\n")
  .filter((l) => l.trim().length > 0);

const FIXTURE_TOOL_FRAMES = readFileSync(TOOLS_FIXTURE_PATH, "utf8")
  .trim()
  .split("\n")
  .filter((l) => l.trim().length > 0);

describe("AgyFrameTranslator with recorded fixtures", () => {
  test("translates real tool use fixture with tool names, parameters, and outputs intact", () => {
    const lines = translateAgyFrames(FIXTURE_TOOL_FRAMES, {
      sessionId: "test-tools",
      userPrompt: "run shell and view file",
    });
    expect(lines.length).toBeGreaterThan(3);

    const messages = parseLines(lines);

    // Check tool_use blocks in assistant messages
    const toolUseBlocks = messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.kind === "tool_use") as Array<{
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;

    expect(toolUseBlocks.length).toBe(2);
    expect(toolUseBlocks[0]?.name).toBe("run_command");
    expect(toolUseBlocks[0]?.input).toEqual({ CommandLine: "echo hello > /tmp/agyprobe/a.txt" });
    expect(toolUseBlocks[1]?.name).toBe("view_file");
    expect(toolUseBlocks[1]?.input).toEqual({ AbsolutePath: "/tmp/agyprobe/a.txt" });

    // Check tool_result blocks in user messages
    const toolResultBlocks = messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.kind === "tool_result") as Array<{
      kind: "tool_result";
      forId: string;
      text: string;
      isError: boolean;
    }>;

    expect(toolResultBlocks.length).toBe(2);
    expect(toolResultBlocks[0]?.forId).toBe(toolUseBlocks[0]?.id);
    expect(toolResultBlocks[1]?.forId).toBe(toolUseBlocks[1]?.id);
    expect(toolResultBlocks[1]?.text).toBe("2 lines, 6 bytes");

    // Final assistant text matches
    const finalAsst = messages[messages.length - 1];
    expect(finalAsst).toBeDefined();
    expect(finalAsst?.role).toBe("assistant");
    const asstText = (finalAsst?.blocks ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(asstText).toContain("The command has executed and written to");
  });

  test("translates real two-turn fixture into distinct turns", () => {
    const translator = new AgyFrameTranslator({ sessionId: "test-multiturn" });

    // Feed Turn 1 (frames 0 through 4)
    translator.feedUserPrompt("say the word ONE and nothing else");
    const turn1Lines: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const frame = FIXTURE_TWO_TURN_FRAMES[i];
      if (frame !== undefined) turn1Lines.push(...translator.feed(frame));
    }

    // Feed Turn 2 (frames 5 through 7)
    translator.feedUserPrompt("now repeat exactly the word you just said, and nothing else");
    const turn2Lines: string[] = [];
    for (let i = 5; i < FIXTURE_TWO_TURN_FRAMES.length; i++) {
      const frame = FIXTURE_TWO_TURN_FRAMES[i];
      if (frame !== undefined) turn2Lines.push(...translator.feed(frame));
    }

    const allLines = [...turn1Lines, ...turn2Lines];
    const messages = parseLines(allLines);

    const userMessages = messages.filter((m) => m.role === "user");
    const asstMessages = messages.filter((m) => m.role === "assistant");

    expect(userMessages.length).toBe(2);
    expect(asstMessages.length).toBe(2);

    const asst1Text = (asstMessages[0]?.blocks ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const asst2Text = (asstMessages[1]?.blocks ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => (b as { text: string }).text)
      .join("");

    expect(asst1Text).toBe("ONE\n");
    expect(asst2Text).toBe("ONE\n");
  });
});

describe("Defect 1: Resumed session with missing conversation ID", () => {
  test("resuming an agy session with missing conversation id emits error event and writes break to shadow transcript", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "loom-agy-state-"));
    const spoolDir = await mkdtemp(join(tmpdir(), "loom-agy-spool-"));
    const cwd = await mkdtemp(join(tmpdir(), "loom-agy-cwd-"));
    const origSpool = process.env["LOOM_SPOOL"];
    process.env["LOOM_SPOOL"] = spoolDir;

    const events: JobEvent[] = [];
    const runner = new Runner("/bin/true", "http://127.0.0.1:1/no-permit", 0, (e) => events.push(e), stateDir);

    const sessionId = "session-missing-conv-" + Date.now();
    const req: StartRequest = {
      sessionId,
      resume: true,
      cwd,
      text: "hello",
      mode: "auto",
      model: "g1:gemini-3.7-flash-high",
      effort: "default",
      browser: false,
      images: [],
    };

    try {
      runner.send(req);

      // Event should be emitted
      const errEvent = events.find((e) => e.sessionId === sessionId && e.state === "error");
      expect(errEvent).toBeDefined();
      expect(errEvent?.detail).toBe(
        "this Gemini session's conversation id is missing — starting a new conversation, so it will not remember what came before",
      );

      // Shadow transcript should carry the break
      const transcriptFile = agyTranscriptPath(cwd, sessionId);
      expect(existsSync(transcriptFile)).toBe(true);
      const content = readFileSync(transcriptFile, "utf8");
      expect(content).toContain(
        "this Gemini session's conversation id is missing — starting a new conversation, so it will not remember what came before",
      );
    } finally {
      runner.shutdown();
      if (origSpool !== undefined) process.env["LOOM_SPOOL"] = origSpool;
      else delete process.env["LOOM_SPOOL"];
      await rm(stateDir, { recursive: true, force: true });
      await rm(spoolDir, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      const transDir = dirname(agyTranscriptPath(cwd, sessionId));
      if (existsSync(transDir)) {
        await rm(transDir, { recursive: true, force: true });
      }
    }
  });
});

describe("Defect 2: Prompt queue FIFO order across interleavings", () => {
  test("for any sequence of user prompts queued before user_input frames, the nth user_input frame carries the nth prompt", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 10 }),
        (prompts) => {
          const translator = new AgyFrameTranslator({ sessionId: "test-queue" });

          // Queue all prompts upfront before frames arrive (simulating rapid sends)
          for (const p of prompts) {
            translator.feedUserPrompt(p);
          }

          const producedLines: string[] = [];
          for (let i = 0; i < prompts.length; i++) {
            const frame = {
              event: "step_update",
              step_update: {
                step_index: i,
                state: "DONE",
                step_type: "user_input",
              },
            };
            producedLines.push(...translator.feed(frame));
          }

          const messages = parseLines(producedLines);
          const userMessages = messages.filter((m) => m.role === "user");

          expect(userMessages.length).toBe(prompts.length);
          for (let i = 0; i < prompts.length; i++) {
            const text = userMessages[i]?.blocks
              .filter((b) => b.kind === "text")
              .map((b) => (b as { text: string }).text)
              .join("");
            expect(text).toBe(prompts[i]);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("Defect 3: Cumulative result.usage differences across multiple turns", () => {
  test("feed three results with cumulative totals and assert the three recorded costs are the differences, not the totals", () => {
    const translator = new AgyFrameTranslator({ sessionId: "test-usage-cum" });

    // Turn 1
    translator.feedUserPrompt("prompt 1");
    const t1 = translator.feed({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "response 1",
        usage: { input_tokens: 10000, output_tokens: 100, thinking_tokens: 50, cache_read_tokens: 0, total_tokens: 10100 },
      },
    });

    // Turn 2
    translator.feedUserPrompt("prompt 2");
    const t2 = translator.feed({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "response 2",
        usage: { input_tokens: 25000, output_tokens: 250, thinking_tokens: 120, cache_read_tokens: 0, total_tokens: 25250 },
      },
    });

    // Turn 3
    translator.feedUserPrompt("prompt 3");
    const t3 = translator.feed({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "response 3",
        usage: { input_tokens: 45000, output_tokens: 450, thinking_tokens: 200, cache_read_tokens: 0, total_tokens: 45450 },
      },
    });

    const rawRows = [...t1, ...t2, ...t3].map((l) => JSON.parse(l));
    const asstRows = rawRows.filter((r) => r.type === "assistant");

    expect(asstRows.length).toBe(3);

    expect(asstRows[0].message.usage.input_tokens).toBe(10000);
    expect(asstRows[0].message.usage.output_tokens).toBe(100);

    expect(asstRows[1].message.usage.input_tokens).toBe(15000);
    expect(asstRows[1].message.usage.output_tokens).toBe(150);

    expect(asstRows[2].message.usage.input_tokens).toBe(20000);
    expect(asstRows[2].message.usage.output_tokens).toBe(200);
  });
});

describe("Defect 4: is_error is not asserted when agy does not report it", () => {
  test("tool_result row does not include is_error field", () => {
    const frames = [
      {
        event: "step_update",
        step_update: {
          step_index: 0,
          state: "DONE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: {}, output: "done" },
        },
      },
    ];

    const lines = translateAgyFrames(frames);
    const parsedRows = lines.map((l) => JSON.parse(l));
    const userRow = parsedRows.find((r) => r.type === "user");
    expect(userRow).toBeDefined();
    const toolResultBlock = userRow.message.content[0];
    expect(toolResultBlock.type).toBe("tool_result");
    expect(toolResultBlock.is_error).toBeUndefined();
  });
});

describe("Property 1: Text restoration property across arbitrary text_delta chunks", () => {
  test("for any sequence of text_delta chunks, parsed assistant text matches concatenated deltas", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (deltas, userPrompt) => {
          const frames: Record<string, unknown>[] = [
            { event: "init", conversation_id: "conv-1", init: { model: "gemini-3.7-flash-high" } },
            { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
          ];

          for (let i = 0; i < deltas.length - 1; i++) {
            frames.push({
              event: "step_update",
              step_update: {
                step_index: i + 1,
                state: "ACTIVE",
                step_type: "agent_response",
                text_delta: deltas[i],
              },
            });
          }

          // Last chunk with state DONE
          const lastIndex = deltas.length - 1;
          frames.push({
            event: "step_update",
            step_update: {
              step_index: lastIndex + 1,
              state: "DONE",
              step_type: "agent_response",
              text_delta: deltas[lastIndex],
              usage: { input_tokens: 100, output_tokens: 50, thinking_tokens: 10 },
            },
          });

          frames.push({
            event: "result",
            result: {
              status: "SUCCESS",
              response: deltas.join(""),
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          });

          const lines = translateAgyFrames(frames, { userPrompt });
          const messages = parseLines(lines);

          const asstMsg = messages.find((m) => m.role === "assistant");
          expect(asstMsg).toBeDefined();
          const parsedText = asstMsg!.blocks
            .filter((b) => b.kind === "text")
            .map((b) => (b as { text: string }).text)
            .join("");
          expect(parsedText).toBe(deltas.join(""));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 2: Tool call preservation", () => {
  test("any tool call survives translation with name, parameters, and output intact", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9_]{1,30}$/),
        fc.dictionary(fc.stringMatching(/^[a-zA-Z0-9_]{1,20}$/), fc.string({ maxLength: 50 })),
        fc.string({ maxLength: 200 }),
        (toolName, parameters, outputText) => {
          const frames: Record<string, unknown>[] = [
            { event: "init", conversation_id: "conv-tool", init: { model: "gemini-3.7-flash-high" } },
            { event: "step_update", step_update: { step_index: 0, state: "DONE", step_type: "user_input" } },
            {
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "ACTIVE",
                step_type: "tool",
                tool_name: toolName,
                tool_info: { name: toolName, parameters },
              },
            },
            {
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "tool",
                tool_name: toolName,
                tool_info: { name: toolName, parameters, output: outputText },
              },
            },
            {
              event: "step_update",
              step_update: {
                step_index: 2,
                state: "DONE",
                step_type: "agent_response",
                text_delta: "done",
              },
            },
            {
              event: "result",
              result: { status: "SUCCESS", response: "done" },
            },
          ];

          const lines = translateAgyFrames(frames, { userPrompt: "call tool" });
          const messages = parseLines(lines);

          const toolUse = messages
            .flatMap((m) => m.blocks)
            .find((b) => b.kind === "tool_use") as { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> } | undefined;

          const toolResult = messages
            .flatMap((m) => m.blocks)
            .find((b) => b.kind === "tool_result") as { kind: "tool_result"; forId: string; text: string; isError: boolean } | undefined;

          expect(toolUse).toBeDefined();
          expect(toolResult).toBeDefined();
          expect(toolUse!.name).toBe(toolName);
          expect(toolUse!.input).toEqual(parameters);
          expect(toolResult!.forId).toBe(toolUse!.id);
          expect(toolResult!.text).toBe(outputText);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 3: Resilience against malformed/unknown frames", () => {
  test("arbitrary malformed strings and unknown events never throw and produce valid JSON lines", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string(), // arbitrary junk string / non-JSON
            fc.constant(""),
            fc.constant("   "),
            fc.constant("agy.sh: rebuilding binary"),
            fc.constant("{\"broken json"),
            fc.constant("null"),
            fc.constant("123"),
            fc.constant("true"),
            fc.dictionary(fc.string(), fc.jsonValue()), // unknown JSON object
          ),
          { minLength: 1, maxLength: 30 },
        ),
        (garbageFrames) => {
          const translator = new AgyFrameTranslator();
          const producedLines: string[] = [];
          expect(() => {
            for (const item of garbageFrames) {
              const lines = translator.feed(item as string | Record<string, unknown>);
              producedLines.push(...lines);
            }
          }).not.toThrow();

          // Every line that was produced must be parseable JSON and accepted by TranscriptParser
          for (const line of producedLines) {
            expect(() => JSON.parse(line)).not.toThrow();
            const parser = new TranscriptParser();
            expect(() => parser.push(`${line}\n`)).not.toThrow();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 4: agyArgs and shadow transcript path separation", () => {
  test("agyArgs includes required flags and launcher", () => {
    const req: StartRequest = {
      sessionId: "session-123",
      resume: false,
      cwd: "/home/user/project",
      text: "hello",
      mode: "auto",
      model: "g1:gemini-3.7-flash-high",
      effort: "default",
      browser: false,
      images: [],
    };

    const args = agyArgs(req);
    expect(args[0]).toBe(AGY_LAUNCHER);
    expect(args).toContain("--add-dir");
    expect(args).toContain("/home/user/project");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.7-flash-high");
    expect(args).toContain("--input-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--mode");
    expect(args).toContain("accept-edits");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--conversation");

    // Resuming with conversationId
    const resumeArgs = agyArgs({ ...req, resume: true }, "conv-abc-456");
    expect(resumeArgs).toContain("--conversation");
    expect(resumeArgs).toContain("conv-abc-456");
  });

  test("agyStdinLine formats NDJSON user input correctly", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const line = agyStdinLine(text);
        const parsed = JSON.parse(line);
        expect(parsed).toEqual({ event: "user", message: { content: text } });
      }),
    );
  });

  test("shadow transcript path is always strictly under AGY_PROJECTS_ROOT and never under ~/.claude/projects", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\/[a-zA-Z0-9_\-\/]+$/),
        fc.uuid(),
        (cwd, sessionId) => {
          const path = agyTranscriptPath(cwd, sessionId);
          expect(path.startsWith(AGY_PROJECTS_ROOT)).toBe(true);
          expect(path).not.toContain(".claude/projects");
          expect(path.endsWith(`${sessionId}.jsonl`)).toBe(true);
        },
      ),
    );
  });
});
