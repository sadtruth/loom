/**
 * Process-side harness for Google's Antigravity CLI (agy).
 *
 * Drives agy turn-by-turn over an open stdin FIFO with stream-json format.
 * Maps loom session UUIDs to agy conversation IDs, and manages shadow transcripts
 * at ~/.loom/agy/projects/<escaped-cwd>/<sessionId>.jsonl so that Gemini sessions
 * are visible to loom while keeping ~/.claude/projects/ clean for Anthropic usage tracking.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { escapeCwd, type StartRequest } from "./input.ts";
import { specFor } from "./models.ts";

/** The launcher script that wraps agy with proxy, self-heal, and timeout settings. */
export const AGY_LAUNCHER =
  process.env["AGY_BIN"] ?? "/home/user/resilio/docs/Projects/other-models/gemini-for-cheap/agy.sh";

/**
 * The shadow transcript root for agy sessions.
 *
 * Must NEVER be placed under ~/.claude/projects/ — server/bar.ts walks that tree
 * to compute Anthropic's 5-hour spend, and Gemini turns there would corrupt the limits bar.
 */
export const AGY_PROJECTS_ROOT =
  Bun.env["LOOM_AGY_PROJECTS_ROOT"] ?? join(homedir(), ".loom", "agy", "projects");

const DEFAULT_STATE_DIR = Bun.env["LOOM_STATE"] ?? join(import.meta.dir, "..", "state");

/** Build the argv array to launch agy for a given loom start request. */
export function agyArgs(req: StartRequest, conversationId?: string | null): string[] {
  const spec = specFor(req.model);
  const args = [
    AGY_LAUNCHER,
    "--add-dir",
    req.cwd,
    ...(spec.arg !== undefined ? ["--model", spec.arg] : []),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--mode",
    "accept-edits",
    "--dangerously-skip-permissions",
  ];

  if (req.resume && conversationId !== undefined && conversationId !== null && conversationId.length > 0) {
    args.push("--conversation", conversationId);
  }

  return args;
}

/** Build one NDJSON input line for agy stdin in the accepted shape. */
export function agyStdinLine(text: string): string {
  return JSON.stringify({ event: "user", message: { content: text } });
}

/** Get the shadow transcript file path for a session. */
export function agyTranscriptPath(cwd: string, sessionId: string, root: string = AGY_PROJECTS_ROOT): string {
  return join(root, escapeCwd(cwd), `${sessionId}.jsonl`);
}

/** Append translated transcript lines to the shadow transcript file. */
export async function appendShadowTranscript(
  cwd: string,
  sessionId: string,
  lines: readonly string[],
  root: string = AGY_PROJECTS_ROOT,
): Promise<void> {
  if (lines.length === 0) return;
  const path = agyTranscriptPath(cwd, sessionId, root);
  await mkdir(dirname(path), { recursive: true });
  const payload = lines.map((l) => `${l.trim()}\n`).join("");
  await appendFile(path, payload, "utf8");
}

/** Synchronous version of appendShadowTranscript for fast event-loop spool pumping. */
export function appendShadowTranscriptSync(
  cwd: string,
  sessionId: string,
  lines: readonly string[],
  root: string = AGY_PROJECTS_ROOT,
): void {
  if (lines.length === 0) return;
  const path = agyTranscriptPath(cwd, sessionId, root);
  mkdirSync(dirname(path), { recursive: true });
  const payload = lines.map((l) => `${l.trim()}\n`).join("");
  appendFileSync(path, payload, "utf8");
}

/** Path to the conversation ID mapping file in STATE_DIR. */
export function agyConversationsPath(stateDir: string = DEFAULT_STATE_DIR): string {
  return join(stateDir, "agy-conversations.json");
}

/** Read all loom session -> agy conversation mappings. */
export async function readAgyConversations(stateDir: string = DEFAULT_STATE_DIR): Promise<Record<string, string>> {
  const path = agyConversationsPath(stateDir);
  try {
    const raw = await readFile(path, "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Synchronous version of readAgyConversations. */
export function readAgyConversationsSync(stateDir: string = DEFAULT_STATE_DIR): Record<string, string> {
  const path = agyConversationsPath(stateDir);
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf8");
    const data: unknown = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      return data as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Look up an agy conversation ID for a loom session ID. */
export function getAgyConversation(sessionId: string, stateDir: string = DEFAULT_STATE_DIR): string | null {
  const all = readAgyConversationsSync(stateDir);
  return all[sessionId] ?? null;
}

/** Persist a loom session -> agy conversation mapping. */
export async function writeAgyConversation(
  sessionId: string,
  conversationId: string,
  stateDir: string = DEFAULT_STATE_DIR,
): Promise<void> {
  const all = await readAgyConversations(stateDir);
  all[sessionId] = conversationId;
  await mkdir(stateDir, { recursive: true });
  const tmp = `${agyConversationsPath(stateDir)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(all, null, 2), "utf8");
  await rename(tmp, agyConversationsPath(stateDir));
}

/** Synchronous version of writeAgyConversation. */
export function writeAgyConversationSync(
  sessionId: string,
  conversationId: string,
  stateDir: string = DEFAULT_STATE_DIR,
): void {
  const all = readAgyConversationsSync(stateDir);
  if (all[sessionId] === conversationId) return;
  all[sessionId] = conversationId;
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${agyConversationsPath(stateDir)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  renameSync(tmp, agyConversationsPath(stateDir));
}
