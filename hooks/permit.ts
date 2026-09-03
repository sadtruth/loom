#!/usr/bin/env bun
/**
 * PreToolUse hook injected into loom-spawned `claude` children via --settings (SPEC 34).
 *
 * Reads the pending tool call on stdin, POSTs it to loom, and BLOCKS until the broker answers —
 * that held request is User's permission prompt. The verdict comes back as hookSpecificOutput.
 *
 * Every failure path exits 0 with no output: "no opinion", which in headless mode means the CLI's
 * own auto-deny stands. Deny-on-failure is the only acceptable direction for a permission gate —
 * this hook must never be the thing that silently allows.
 *
 * LOOM_PERMIT_URL is both the activation marker and the address. Absent (every session loom did
 * not spawn) the hook exits immediately; it is never installed globally, so that path is nearly
 * unreachable — kept because a hook this security-relevant gets belt and braces.
 */

import { matchesAsk, type AskRule } from "../server/askrules.ts";

const url = process.env["LOOM_PERMIT_URL"];
if (url === undefined || url.length === 0) process.exit(0);

/**
 * Read-only tools pass through silently (exit 0 = no opinion → the CLI's own flow, which allows
 * them). A card per Read would make loom-driven sessions unusable — measured on the first real
 * loom-driven build turn, 2026-08-05, where every tool call raised a card for User. Everything
 * not in this set (Write, Edit, Bash, NotebookEdit, unknown future tools) still asks.
 */
const READ_ONLY = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "ToolSearch",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
  "TaskOutput",
]);

/**
 * LOOM_PERMIT_POLICY=defer: the CLI's own flow decides ordinary work, and denials surface in the
 * result frame for loom to report. For turns User marks as trusted — which is every turn, because
 * `auto` is the default for every send.
 *
 * It used to mean NO CARDS AT ALL, and that was the bug (SPEC 219). A tool matching one of his own
 * `permissions.ask` rules cannot be decided by the CLI either: loom runs it headless with
 * `skipAutoPermissionPrompt`, so it has no way to put the question on a screen and refuses instead.
 * User, 2026-08-17: *"when a session needs to ask for my permission to edit something i dont get a
 * prompt to approve"*. So `defer` now means "no card for what the CLI would have allowed anyway",
 * and the rules that decide are HIS, passed in rather than invented here.
 */
const policy = process.env["LOOM_PERMIT_POLICY"] ?? "cards";
const home = process.env["LOOM_PERMIT_HOME"] ?? "";
let askRules: AskRule[] = [];
try {
  const parsed: unknown = JSON.parse(process.env["LOOM_PERMIT_ASK"] ?? "[]");
  if (Array.isArray(parsed)) askRules = parsed as AskRule[];
} catch {
  askRules = []; // an unreadable list is no list: back to the old defer, never a card per call
}
// Nothing he asked to be asked about: exactly the old behaviour, and the cheap path.
if (policy === "defer" && askRules.length === 0) process.exit(0);

try {
  const raw = await new Response(Bun.stdin.stream()).text();
  const payload = JSON.parse(raw) as {
    session_id?: unknown;
    tool_name?: unknown;
    tool_input?: unknown;
  };
  if (typeof payload.session_id !== "string" || typeof payload.tool_name !== "string") process.exit(0);
  if (READ_ONLY.has(payload.tool_name)) process.exit(0);
  // On a deferred turn, only what he asked to be asked about. `matchesAsk` answers false for
  // anything it does not understand, so the failure direction is "no card" — never a card per tool
  // call, which is the 2026-08-05 measurement that made loom-driven sessions unusable.
  if (policy === "defer" && !matchesAsk(askRules, payload.tool_name, payload.tool_input, home)) {
    process.exit(0);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      toolInput: payload.tool_input ?? null,
    }),
    // Just under the CLI-side hook timeout (3600s in the injected settings), so the broker's
    // answer — not an opaque hook kill — is what ends the wait.
    signal: AbortSignal.timeout(3_570_000),
  });
  if (!res.ok) process.exit(0);

  const body = (await res.json()) as { verdict?: unknown; reason?: unknown };
  if (body.verdict !== "allow" && body.verdict !== "deny") process.exit(0);

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: body.verdict,
        permissionDecisionReason:
          typeof body.reason === "string" ? body.reason : `loom: ${body.verdict}`,
      },
    }),
  );
} catch {
  process.exit(0);
}
