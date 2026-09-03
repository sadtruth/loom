/**
 * The incremental JSONL -> model machine. PURE: no filesystem, no clock, no network.
 *
 * That purity is the point. The tailer feeds this the same way the poller does, so the byte-split
 * property (VERIFY §Properties 1) drives the real code path without touching a disk. Every rule this
 * file implements is written down in SPEC.md — change the SPEC first.
 *
 * `message.usage` is captured onto `Message` as `MessageUsage` (usage-bar, 2026-08-26): a call's
 * weighted cost, computed here with `block.ts`'s own `barOf`/`family` so the weights live in
 * exactly one place. A transcript writes ONE RECORD PER CONTENT BLOCK, all sharing a `requestId`
 * — the same batching `server/bar.ts` accounts for — so only the FIRST row for a `requestId`
 * carries `usage`; every later row in the same batch carries none, or a turn's total would count
 * one API call several times over.
 */

import { barOf, family } from "./block.ts";

export type Role = "user" | "assistant" | "system";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; forId: string; text: string; isError: boolean }
  | { kind: "image"; mediaType: string; data: string };

/** One API call's cost, attached to the first `Message` row that reports it (see file header). */
export interface MessageUsage {
  /** Dedupe key. One API call writes one transcript record PER CONTENT BLOCK, all sharing this. */
  requestId: string;
  /** Weighted units, computed with block.ts's W/MODEL_W via `barOf`. */
  units: number;
  /** Cache-read tokens. */
  read: number;
  /** Cache-WRITE tokens. Carried separately from `ctx` so the client can say what share of the
   *  prompt was reused — `read / (read + write)` — without a second endpoint (2026-08-29). */
  write: number;
  /** read + cache_creation + input — the whole prompt this call paid for. */
  ctx: number;
  /** Which ephemeral bucket this call WROTE, as a lifetime in ms: 1h, 5m, or null when it wrote
   *  none. The badge counts down from the message's own `ts` plus this, so the cache clock works
   *  for any open session rather than only for one loom is driving (2026-08-29). */
  ttlMs: number | null;
}

export interface Message {
  uuid: string;
  parentUuid: string | null;
  role: Role;
  ts: string;
  blocks: Block[];
  isSidechain: boolean;
  isMeta: boolean;
  /** Did this row END the turn — `endsTurn` below. The answer glyph is drawn on it (SPEC 190). */
  endsTurn: boolean;
  usage?: MessageUsage;
}

/**
 * Sum usage across a set of messages, deduped by `requestId` — the same arithmetic the client
 * repeats over a turn (`usage.units` times `scale` for cost, `read`/`ctx` for the cache-hit
 * ratio). Exported PURE so the dedupe-and-sum rule can be pinned on its own
 * (`tests/props/turn-usage.props.test.ts`) without a transcript file in sight. Messages with no
 * `usage` (most rows) are simply skipped; a repeated `requestId` — which should not happen once
 * `TranscriptParser` has deduped at parse time, but costs nothing to guard here too — counts only
 * once, first occurrence wins.
 */
export function sumUsage(messages: readonly { usage?: MessageUsage }[]): { units: number; read: number; ctx: number } {
  const seen = new Set<string>();
  let units = 0;
  let read = 0;
  let ctx = 0;
  for (const m of messages) {
    const u = m.usage;
    if (u === undefined || seen.has(u.requestId)) continue;
    seen.add(u.requestId);
    units += u.units;
    read += u.read;
    ctx += u.ctx;
  }
  return { units, read, ctx };
}

/**
 * Did this assistant message END the turn, or is it a word said on the way through?
 *
 * The transcript already carries the answer: the API's `stop_reason`. `tool_use` means the CLI is
 * about to run something and keep going; everything else means the model stopped and the floor is
 * back with User. Stated as "not `tool_use`" rather than "is `end_turn`" because the real files
 * carry `stop_sequence` too (13 of 146 finished turns in the store, measured 2026-08-07), and a
 * stop reason nobody has seen yet still cannot be continued without a tool call. A row with no
 * `stop_reason` at all is a row the CLI never finished writing — not a fact.
 *
 * ONE definition, used twice: the tree's envelope reads it through `server/activity.ts` and the
 * transcript's answer glyph through the field above, so the two agree by construction rather than
 * by two functions that happen to say the same thing today (SPEC 111, 190).
 */
export function endsTurn(message: object): boolean {
  const reason = (message as { stop_reason?: unknown }).stop_reason;
  return typeof reason === "string" && reason.length > 0 && reason !== "tool_use";
}

export type TouchOp = "read" | "write" | "edit";

export interface Touch {
  path: string;
  op: TouchOp;
  ts: string;
  msgUuid: string;
}

export interface SessionMeta {
  id: string | null;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
}

export interface Model {
  meta: SessionMeta;
  messages: Message[];
  touches: Touch[];
  skipped: number;
}

/** Aggregated drawer entry — SPEC §10/§11. */
export interface Artifact {
  path: string;
  name: string;
  kind: TouchOp;
  ops: TouchOp[];
  count: number;
  firstTs: string;
  lastTs: string;
  msgUuids: string[];
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);
const KIND_RANK: Record<TouchOp, number> = { write: 3, edit: 2, read: 1 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** tool_result content is either a string or an array of text blocks (SPEC 7). */
function flattenResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") parts.push(item);
      else if (isRecord(item) && typeof item["text"] === "string") parts.push(item["text"]);
    }
    return parts.join("\n");
  }
  return "";
}

/** `message.usage` -> `MessageUsage`, priced with `block.ts`'s own weights so this file never
 *  carries a copy of them. */
function messageUsageOf(requestId: string, modelName: unknown, usage: Record<string, unknown>): MessageUsage {
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const read = n(usage["cache_read_input_tokens"]);
  const write = n(usage["cache_creation_input_tokens"]);
  const input = n(usage["input_tokens"]);
  const output = n(usage["output_tokens"]);
  const units = barOf({ ts: 0, model: family(str(modelName) ?? "?"), read, write, input, output });
  // Same reading `train.ts`'s `readCache` takes, taken here so it rides with every call instead of
  // only with the last row of a record's train.
  const buckets = usage["cache_creation"];
  let ttlMs: number | null = null;
  if (isRecord(buckets)) {
    if (n(buckets["ephemeral_1h_input_tokens"]) > 0) ttlMs = 60 * 60 * 1000;
    else if (n(buckets["ephemeral_5m_input_tokens"]) > 0) ttlMs = 5 * 60 * 1000;
  }
  return { requestId, units, read, write, ctx: read + write + input, ttlMs };
}

function toolOp(name: string): TouchOp {
  if (name === "Read") return "read";
  if (name === "Write") return "write";
  return "edit";
}

function parseBlocks(content: unknown): Block[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: Block[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = str(raw["type"]);
    if (type === "text") {
      const text = str(raw["text"]);
      if (text !== null) blocks.push({ kind: "text", text });
    } else if (type === "thinking") {
      const text = str(raw["thinking"]) ?? str(raw["text"]);
      if (text !== null) blocks.push({ kind: "thinking", text });
    } else if (type === "tool_use") {
      const id = str(raw["id"]);
      const name = str(raw["name"]);
      if (id !== null && name !== null) blocks.push({ kind: "tool_use", id, name, input: raw["input"] });
    } else if (type === "tool_result") {
      const forId = str(raw["tool_use_id"]);
      if (forId !== null) {
        blocks.push({
          kind: "tool_result",
          forId,
          text: flattenResult(raw["content"]),
          isError: raw["is_error"] === true,
        });
      }
    } else if (type === "image") {
      // Pasted/attached images: {source: {type: "base64", media_type, data}} — stored verbatim by
      // the CLI, rendered inline by loom. A malformed source degrades to "no block", as ever.
      const source = raw["source"];
      if (isRecord(source) && source["type"] === "base64") {
        const mediaType = str(source["media_type"]);
        const data = str(source["data"]);
        if (mediaType !== null && mediaType.startsWith("image/") && data !== null) {
          blocks.push({ kind: "image", mediaType, data });
        }
      }
    }
  }
  return blocks;
}

/** SPEC §8 — hidden-by-default noise, still parsed. */
/**
 * A message he typed WHILE A TURN WAS RUNNING — SPEC 235.
 *
 * The CLI does not write one as a `user` row. It writes
 * `{"type":"attachment","attachment":{"type":"queued_command","prompt":[…],"commandMode":"prompt"}}`,
 * and every `attachment` row used to be counted as skipped and thrown away. User, 2026-08-23:
 * *"some messages are dropping from sessions - i cant see them, especially those i wrote while you
 * were working"*. Measured across his own store the same day: 1,118 of these in 140 of 251
 * sessions, and 1,117 existed ONLY as this row — two months of words, delivered once and then
 * invisible in every reading of the session afterwards.
 *
 * `commandMode` is what separates him from the harness, and it says so outright: 458 rows are
 * `prompt` — what he typed — and 661 are `task-notification`, the background-task text the harness
 * queued on its own. The second kind is parsed too, and marked meta, so it is hidden with every
 * other reminder rather than dropped: a message this parser cannot see is a message no later
 * question can ask about.
 *
 * `prompt` is a string in 664 rows and an array of content blocks in 455. Both are real.
 */
function queuedCommand(row: Record<string, unknown>): { blocks: Block[]; isMeta: boolean } | null {
  const attachment = row["attachment"];
  if (!isRecord(attachment) || attachment["type"] !== "queued_command") return null;
  const blocks = parseBlocks(attachment["prompt"]);
  if (blocks.length === 0) return null;
  const typed = attachment["commandMode"] === "prompt";
  return { blocks, isMeta: !typed || attachment["isMeta"] === true || detectMeta(row, blocks) };
}

function detectMeta(row: Record<string, unknown>, blocks: Block[]): boolean {
  if (row["isMeta"] === true) return true;
  const texts = blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text");
  if (texts.length === 0 || texts.length !== blocks.length) return false;
  return texts.every((b) => b.text.trimStart().startsWith("<system-reminder>"));
}

export class TranscriptParser {
  private lineBuf = "";
  private readonly msgs: Message[] = [];
  private readonly touchList: Touch[] = [];
  private meta: SessionMeta = { id: null, title: null, cwd: null, gitBranch: null };
  private skippedCount = 0;
  /** requestIds already given a `usage` — the rest of that call's content-block rows carry none. */
  private readonly seenRequestIds = new Set<string>();

  /**
   * Feed decoded text. Bytes after the final newline are held back (SPEC invariant 4) — the writer
   * appends non-atomically, so parsing a half-written line would materialise a phantom message.
   */
  push(chunk: string): void {
    this.lineBuf += chunk;
    let nl = this.lineBuf.indexOf("\n");
    while (nl !== -1) {
      const line = this.lineBuf.slice(0, nl);
      this.lineBuf = this.lineBuf.slice(nl + 1);
      this.consume(line);
      nl = this.lineBuf.indexOf("\n");
    }
  }

  /** Number of complete messages so far — lets the watcher send only what is new. */
  get messageCount(): number {
    return this.msgs.length;
  }

  get touchCount(): number {
    return this.touchList.length;
  }

  model(): Model {
    return { meta: { ...this.meta }, messages: this.msgs, touches: this.touchList, skipped: this.skippedCount };
  }

  /** Slice since a previous (messageCount, touchCount) watermark. */
  since(msgIndex: number, touchIndex: number): { messages: Message[]; touches: Touch[] } {
    return { messages: this.msgs.slice(msgIndex), touches: this.touchList.slice(touchIndex) };
  }

  private consume(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      this.skippedCount += 1;
      return;
    }
    if (!isRecord(row)) {
      this.skippedCount += 1;
      return;
    }

    const type = str(row["type"]);
    if (type === null) {
      this.skippedCount += 1;
      return;
    }

    if (this.meta.id === null) this.meta.id = str(row["sessionId"]);
    if (this.meta.cwd === null) this.meta.cwd = str(row["cwd"]);
    if (this.meta.gitBranch === null) this.meta.gitBranch = str(row["gitBranch"]);

    switch (type) {
      case "ai-title": {
        this.meta.title = str(row["aiTitle"]) ?? this.meta.title;
        return;
      }
      case "file-history-delta": {
        this.consumeDelta(row);
        return;
      }
      case "user":
      case "assistant":
      case "system":
        break;
      case "attachment":
        // Only ONE kind of attachment is a message; the other twenty-two are reminders, hook
        // output and tool bookkeeping, and they stay skipped.
        if (queuedCommand(row) === null) {
          this.skippedCount += 1;
          return;
        }
        break;
      default:
        this.skippedCount += 1;
        return;
    }

    const uuid = str(row["uuid"]);
    if (uuid === null || uuid.length === 0) {
      this.skippedCount += 1;
      return;
    }

    const message = row["message"];
    // A queued command carries its words under `attachment.prompt`, and it is HIS turn: it is drawn
    // as a user message, in the place in the file where he typed it, which is where it belongs.
    const queued = type === "attachment" ? queuedCommand(row) : null;
    const blocks = queued !== null ? queued.blocks : isRecord(message) ? parseBlocks(message["content"]) : [];
    const ts = str(row["timestamp"]) ?? "";

    // Only the FIRST content-block row for a requestId carries usage — the rest of the same API
    // call's batch would otherwise count the same tokens several times over (file header).
    const requestId = str(row["requestId"]);
    let usage: MessageUsage | undefined;
    if (requestId !== null && !this.seenRequestIds.has(requestId) && isRecord(message) && isRecord(message["usage"])) {
      usage = messageUsageOf(requestId, message["model"], message["usage"]);
      this.seenRequestIds.add(requestId);
    }

    this.msgs.push({
      uuid,
      parentUuid: str(row["parentUuid"]),
      // An attachment only reaches this line when it IS a queued command, and that is his turn.
      role: type === "attachment" ? "user" : type,
      ts,
      blocks,
      isSidechain: row["isSidechain"] === true,
      isMeta: queued !== null ? queued.isMeta : detectMeta(row, blocks),
      endsTurn: type === "assistant" && isRecord(message) && endsTurn(message),
      ...(usage !== undefined ? { usage } : {}),
    });

    for (const block of blocks) {
      if (block.kind !== "tool_use") continue;
      if (!FILE_TOOLS.has(block.name)) continue;
      const input = block.input;
      if (!isRecord(input)) continue;
      const path = str(input["file_path"]);
      if (path === null || path.length === 0) continue;
      this.touchList.push({ path, op: toolOp(block.name), ts, msgUuid: uuid });
    }
  }

  /** file-history-delta rows record an edit Claude Code backed up — SPEC §9. */
  private consumeDelta(row: Record<string, unknown>): void {
    const tracking = str(row["trackingPath"]);
    if (tracking === null || tracking.length === 0) return;
    const backup = row["backup"];
    const parent = isRecord(backup) ? str(backup["realParentDir"]) : null;
    const path = tracking.startsWith("/")
      ? tracking
      : parent !== null
        ? `${parent}/${tracking.split("/").slice(-1)[0] ?? tracking}`
        : tracking;
    this.touchList.push({
      path,
      op: "edit",
      ts: str(row["timestamp"]) ?? "",
      msgUuid: str(row["messageId"]) ?? "",
    });
  }
}

/** Convenience for tests and one-shot reads — identical rules to the streaming path. */
export function parseTranscript(text: string): Model {
  const parser = new TranscriptParser();
  parser.push(text);
  return parser.model();
}

/** SPEC §10/§11 — aggregate to one row per path, precedence write > edit > read. */
export function aggregate(touches: readonly Touch[]): Artifact[] {
  const byPath = new Map<string, Artifact>();
  for (const touch of touches) {
    const existing = byPath.get(touch.path);
    if (existing === undefined) {
      byPath.set(touch.path, {
        path: touch.path,
        name: touch.path.split("/").slice(-1)[0] ?? touch.path,
        kind: touch.op,
        ops: [touch.op],
        count: 1,
        firstTs: touch.ts,
        lastTs: touch.ts,
        msgUuids: touch.msgUuid.length > 0 ? [touch.msgUuid] : [],
      });
      continue;
    }
    existing.count += 1;
    if (!existing.ops.includes(touch.op)) existing.ops.push(touch.op);
    if (KIND_RANK[touch.op] > KIND_RANK[existing.kind]) existing.kind = touch.op;
    if (touch.ts.length > 0 && (existing.firstTs.length === 0 || touch.ts < existing.firstTs)) {
      existing.firstTs = touch.ts;
    }
    if (touch.ts > existing.lastTs) existing.lastTs = touch.ts;
    if (touch.msgUuid.length > 0 && !existing.msgUuids.includes(touch.msgUuid)) {
      existing.msgUuids.push(touch.msgUuid);
    }
  }

  return [...byPath.values()].sort((a, b) => {
    const rank = KIND_RANK[b.kind] - KIND_RANK[a.kind];
    if (rank !== 0) return rank;
    if (a.lastTs !== b.lastTs) return a.lastTs < b.lastTs ? 1 : -1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}
