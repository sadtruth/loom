/**
 * Pure translator from Google Antigravity (agy) stream-json frames to Claude transcript JSONL rows.
 *
 * PURE: no filesystem, no process, no network, no clock dependency.
 *
 * The rest of loom never learns a second format: this module converts agy output frames
 * (`init`, `step_update`, `result`) into standard transcript JSONL rows that `server/transcript.ts`
 * parses identically to Claude Code transcripts.
 */

import { randomUUID } from "node:crypto";

export interface TranslatorOptions {
  sessionId?: string;
  cwd?: string;
  userPrompt?: string;
  model?: string;
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

export class AgyFrameTranslator {
  private sessionId: string;
  private cwd: string;
  private model: string;
  private lastUuid: string | null = null;
  private pendingUserPrompts: string[] = [];
  private turnTextDeltas: string[] = [];
  private pendingTools = new Map<number, { name: string; parameters: Record<string, unknown> }>();
  private lastUsage: AgyUsage | null = null;
  private cumulativeUsage = {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
  };
  private hasEmittedTurnText = false;
  private conversationId: string | null = null;

  constructor(options?: TranslatorOptions) {
    this.sessionId = options?.sessionId ?? "agy-session";
    this.cwd = options?.cwd ?? "";
    this.model = options?.model ?? "gemini";
    if (options?.userPrompt !== undefined) {
      this.pendingUserPrompts.push(options.userPrompt);
    }
  }

  /** Supply user prompt text for the current or upcoming turn. */
  feedUserPrompt(text: string): void {
    this.pendingUserPrompts.push(text);
  }

  /** Set / update the loom session id. */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /** Set / update cwd. */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Get agy conversation ID if known. */
  getConversationId(): string | null {
    return this.conversationId;
  }

  /**
   * Feed one or more agy frames (as JSON string, raw string chunk, or parsed object).
   * Returns an array of formatted JSONL strings (each a complete Claude-format transcript row).
   */
  feed(frameOrChunk: string | Record<string, unknown>): string[] {
    if (typeof frameOrChunk === "string") {
      const out: string[] = [];
      const lines = frameOrChunk.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Malformed frame is dropped silently, never throws.
          continue;
        }
        if (isRecord(parsed)) {
          out.push(...this.consumeRow(parsed));
        }
      }
      return out;
    }

    if (isRecord(frameOrChunk)) {
      return this.consumeRow(frameOrChunk);
    }

    return [];
  }

  private nextMessage(): { uuid: string; parentUuid: string | null } {
    const uuid = randomUUID();
    const parentUuid = this.lastUuid;
    this.lastUuid = uuid;
    return { uuid, parentUuid };
  }

  private makeRequestId(): string {
    return `req_agy_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }

  private consumeRow(row: Record<string, unknown>): string[] {
    const event = str(row["event"]);
    if (event === null) return [];

    const convId = str(row["conversation_id"]);
    if (convId !== null && this.conversationId === null) {
      this.conversationId = convId;
    }

    switch (event) {
      case "init": {
        const init = row["init"];
        if (isRecord(init)) {
          const m = str(init["model"]);
          if (m !== null) this.model = m;
          const c = str(init["cwd"]);
          if (c !== null) this.cwd = c;
        }
        return [];
      }

      case "step_update": {
        const stepUpdate = row["step_update"];
        if (!isRecord(stepUpdate)) return [];
        return this.consumeStepUpdate(stepUpdate);
      }

      case "result": {
        const result = row["result"];
        if (!isRecord(result)) return [];
        return this.consumeResult(result);
      }

      default:
        return [];
    }
  }

  private consumeStepUpdate(su: Record<string, unknown>): string[] {
    const stepType = str(su["step_type"]);
    const state = str(su["state"]);
    const stepIndex = typeof su["step_index"] === "number" ? su["step_index"] : 0;
    const ts = new Date().toISOString();

    if (stepType === "user_input") {
      // User turn boundary
      const text = this.pendingUserPrompts.shift() ?? "";
      this.turnTextDeltas = [];
      this.hasEmittedTurnText = false;
      this.lastUsage = null;

      const { uuid, parentUuid } = this.nextMessage();
      const userRow = {
        sessionId: this.sessionId,
        uuid,
        parentUuid,
        type: "user",
        timestamp: ts,
        cwd: this.cwd,
        message: {
          role: "user",
          content: [{ type: "text", text }],
        },
      };
      return [JSON.stringify(userRow)];
    }

    if (stepType === "tool") {
      const toolName =
        str(su["tool_name"]) ?? (isRecord(su["tool_info"]) ? str(su["tool_info"]["name"]) : null) ?? "tool";
      const toolInfo = isRecord(su["tool_info"]) ? su["tool_info"] : {};
      const parameters = isRecord(toolInfo["parameters"]) ? toolInfo["parameters"] : {};

      if (state === "ACTIVE") {
        this.pendingTools.set(stepIndex, { name: toolName, parameters });
        return [];
      }

      if (state === "DONE") {
        const pending = this.pendingTools.get(stepIndex) ?? { name: toolName, parameters };
        this.pendingTools.delete(stepIndex);

        const rawOutput = toolInfo["output"];
        const outputText =
          typeof rawOutput === "string"
            ? rawOutput
            : rawOutput !== undefined && rawOutput !== null
              ? JSON.stringify(rawOutput)
              : "";

        const toolCallId = `toolu_agy_${stepIndex}`;

        // 1. Assistant tool_use message
        const asst = this.nextMessage();
        const asstRow = {
          sessionId: this.sessionId,
          uuid: asst.uuid,
          parentUuid: asst.parentUuid,
          type: "assistant",
          timestamp: ts,
          requestId: this.makeRequestId(),
          cwd: this.cwd,
          message: {
            role: "assistant",
            model: this.model,
            content: [
              {
                type: "tool_use",
                id: toolCallId,
                name: pending.name,
                input: pending.parameters,
              },
            ],
            stop_reason: "tool_use",
          },
        };

        // 2. User tool_result message
        const user = this.nextMessage();
        const userRow = {
          sessionId: this.sessionId,
          uuid: user.uuid,
          parentUuid: user.parentUuid,
          type: "user",
          timestamp: ts,
          cwd: this.cwd,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: outputText,
              },
            ],
          },
        };

        return [JSON.stringify(asstRow), JSON.stringify(userRow)];
      }

      return [];
    }

    if (stepType === "agent_response") {
      if (isRecord(su["usage"])) {
        this.lastUsage = su["usage"] as AgyUsage;
      }

      const textDelta = str(su["text_delta"]);
      if (textDelta !== null && textDelta.length > 0) {
        this.turnTextDeltas.push(textDelta);
      }

      if (state === "DONE") {
        if (this.turnTextDeltas.length > 0) {
          const fullText = this.turnTextDeltas.join("");
          this.turnTextDeltas = [];
          this.hasEmittedTurnText = true;

          const asst = this.nextMessage();
          const usage = this.lastUsage;
          let usageObj: Record<string, number> | undefined;
          if (usage) {
            usageObj = {
              input_tokens: num(usage.input_tokens),
              output_tokens: num(usage.output_tokens),
            };
            if (usage.cache_read_tokens !== undefined && num(usage.cache_read_tokens) > 0) {
              usageObj["cache_read_input_tokens"] = num(usage.cache_read_tokens);
            }
            if (usage.thinking_tokens !== undefined && num(usage.thinking_tokens) > 0) {
              usageObj["thinking_tokens"] = num(usage.thinking_tokens);
            }
            this.cumulativeUsage.input_tokens += num(usage.input_tokens);
            this.cumulativeUsage.output_tokens += num(usage.output_tokens);
            this.cumulativeUsage.thinking_tokens += num(usage.thinking_tokens);
            this.cumulativeUsage.cache_read_tokens += num(usage.cache_read_tokens);
          }

          const asstRow = {
            sessionId: this.sessionId,
            uuid: asst.uuid,
            parentUuid: asst.parentUuid,
            type: "assistant",
            timestamp: ts,
            requestId: this.makeRequestId(),
            cwd: this.cwd,
            message: {
              role: "assistant",
              model: this.model,
              content: [{ type: "text", text: fullText }],
              stop_reason: "end_turn",
              ...(usageObj !== undefined ? { usage: usageObj } : {}),
            },
          };
          return [JSON.stringify(asstRow)];
        }
      }

      return [];
    }

    return [];
  }

  private consumeResult(result: Record<string, unknown>): string[] {
    const ts = new Date().toISOString();
    const out: string[] = [];

    if (isRecord(result["usage"])) {
      const rUsage = result["usage"] as AgyUsage;
      if (this.hasEmittedTurnText) {
        this.cumulativeUsage.input_tokens = Math.max(this.cumulativeUsage.input_tokens, num(rUsage.input_tokens));
        this.cumulativeUsage.output_tokens = Math.max(this.cumulativeUsage.output_tokens, num(rUsage.output_tokens));
        this.cumulativeUsage.thinking_tokens = Math.max(this.cumulativeUsage.thinking_tokens, num(rUsage.thinking_tokens));
        this.cumulativeUsage.cache_read_tokens = Math.max(this.cumulativeUsage.cache_read_tokens, num(rUsage.cache_read_tokens));
      } else {
        this.lastUsage = rUsage;
      }
    }

    let usageObj: Record<string, number> | undefined;
    if (!this.hasEmittedTurnText && this.lastUsage) {
      const rawIn = num(this.lastUsage.input_tokens);
      const rawOut = num(this.lastUsage.output_tokens);
      const rawThinking = num(this.lastUsage.thinking_tokens);
      const rawCacheRead = num(this.lastUsage.cache_read_tokens);

      const inTok = Math.max(0, rawIn - this.cumulativeUsage.input_tokens);
      const outTok = Math.max(0, rawOut - this.cumulativeUsage.output_tokens);
      const thinkingTok = Math.max(0, rawThinking - this.cumulativeUsage.thinking_tokens);
      const cacheReadTok = Math.max(0, rawCacheRead - this.cumulativeUsage.cache_read_tokens);

      this.cumulativeUsage.input_tokens = Math.max(this.cumulativeUsage.input_tokens, rawIn);
      this.cumulativeUsage.output_tokens = Math.max(this.cumulativeUsage.output_tokens, rawOut);
      this.cumulativeUsage.thinking_tokens = Math.max(this.cumulativeUsage.thinking_tokens, rawThinking);
      this.cumulativeUsage.cache_read_tokens = Math.max(this.cumulativeUsage.cache_read_tokens, rawCacheRead);

      usageObj = {
        input_tokens: inTok,
        output_tokens: outTok,
      };
      if (this.lastUsage.cache_read_tokens !== undefined && cacheReadTok > 0) {
        usageObj["cache_read_input_tokens"] = cacheReadTok;
      }
      if (this.lastUsage.thinking_tokens !== undefined && thinkingTok > 0) {
        usageObj["thinking_tokens"] = thinkingTok;
      }
    }

    const status = str(result["status"]);
    const isError = status === "ERROR";
    const resp = str(result["response"]);
    const err = str(result["error"]);
    const finalResp = resp ?? (isError ? (err ?? "error") : "");

    // If agent_response text_delta was not emitted or empty, emit from result
    if (!this.hasEmittedTurnText && finalResp.length > 0) {
      const asst = this.nextMessage();
      const asstRow = {
        sessionId: this.sessionId,
        uuid: asst.uuid,
        parentUuid: asst.parentUuid,
        type: "assistant",
        timestamp: ts,
        requestId: this.makeRequestId(),
        cwd: this.cwd,
        message: {
          role: "assistant",
          model: this.model,
          content: [{ type: "text", text: finalResp }],
          stop_reason: isError ? "error_during_execution" : "end_turn",
          ...(usageObj !== undefined ? { usage: usageObj } : {}),
        },
      };
      out.push(JSON.stringify(asstRow));
    }

    // Reset turn-scoped state for next turn in multi-turn conversation
    this.turnTextDeltas = [];
    this.pendingTools.clear();
    this.lastUsage = null;
    this.hasEmittedTurnText = false;

    return out;
  }
}

/** Convenience pure translator for a batch of frames or JSON lines. */
export function translateAgyFrames(
  frames: ReadonlyArray<string | Record<string, unknown>>,
  options?: TranslatorOptions,
): string[] {
  const translator = new AgyFrameTranslator(options);
  const out: string[] = [];
  for (const frame of frames) {
    out.push(...translator.feed(frame));
  }
  return out;
}
