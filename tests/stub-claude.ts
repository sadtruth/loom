#!/usr/bin/env bun
/**
 * A stand-in for the `claude` binary, injected via LOOM_CLAUDE_BIN so the driven input test is
 * hermetic — no network, no cost, no real model. It mimics the contract the Runner relies on
 * (VERIFY §Input path): appends real-format rows to the transcript file a real `claude` would
 * write, and emits one `result` frame per turn on stdout.
 *
 * PERSISTENT, since 2026-08-06. It reads stdin as a STREAM of newline-delimited frames and stays
 * alive between turns, because that is now the contract — one long-lived child per session, stdin
 * held open (SPEC 105). A stub that exited after one message could not exercise the two
 * behaviours the rewrite exists for: a message queued mid-turn, and an interrupt.
 *
 * Faithful to the real binary as recorded by spike-persistent.ts:
 *   - one `result` frame per user message, in order;
 *   - a `control_request` with subtype `interrupt` gets a `control_response` naming its request_id,
 *     and the turn in flight ends as `error_during_execution`;
 *   - the process exits 0 when stdin closes.
 *
 * A message containing "permission" exercises the permit loop the way the real hook does; a message
 * containing "slow" takes long enough that a test can send another message or interrupt mid-turn.
 *
 * A message containing "[hold]" does NOT end until the test says so — it waits for the file named by
 * `LOOM_STUB_HOLD` to appear. "slow" is six seconds of wall clock, which is a bet that the machine
 * is not busy, and under full-gate load that bet loses: journey2's queued-echo case failed a land on
 * 2026-08-19 and again on 2026-08-24, passing solo both times (loom item 58). VERIFY's rule is that
 * a pin must not own a clock, and the only way to keep one is to take the clock out — so a test that
 * needs a turn held open holds it, and releases it, instead of hoping six seconds is enough.
 *
 * INTERMEDIATE FRAMES, since 2026-08-07 (SPEC 96). The working indication reads the frames a turn
 * emits on its way through, so the stub emits them — and emits them in the shape the REAL binary
 * uses, copied off `tests/fixture/real-stdout-frames.jsonl` rather than imagined: one content block
 * per `assistant` frame (a parallel batch arrives as N frames, not one frame with N blocks), and a
 * `system`/`thinking_tokens` counter that resets per thinking block. Two keywords drive the two lies
 * the indication must not tell: `burst` fires ten calls inside a second (must not strobe) and
 * `quiet` starts one step and then says nothing at all (must not look like it is moving).
 */

import { mkdir } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { escapeCwd } from "../server/input.ts";

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

/**
 * The recap child (SPEC §Recap) is a different animal: `--print`, no session id, prompt on stdin,
 * answer on stdout, exit. It writes no transcript — that is requirement 177, and a stub that wrote
 * one would hide exactly the bug the pin is looking for. Answered before anything else is set up,
 * because none of the session machinery below applies to it.
 */
if (args.includes("--print") && flag("--resume") === null && flag("--session-id") === null) {
  const prompt = await new Response(Bun.stdin.stream()).text();
  // A real `claude --print` still writes a transcript, into the store for ITS cwd. The stub must too,
  // or requirement 177 ("the recap child is not a car") is asserted against a child that could never
  // have become one — a check that cannot fail. With this, spawning the recap in the record's
  // directory really does put a phantom session in the picker, and the pin really does catch it.
  const printRoot = process.env["LOOM_PROJECTS_ROOT"];
  if (printRoot !== undefined) {
    const store = join(printRoot, escapeCwd(process.cwd()));
    await mkdir(store, { recursive: true });
    const id = crypto.randomUUID();
    appendFileSync(
      join(store, `${id}.jsonl`),
      `${JSON.stringify({
        type: "user",
        sessionId: id,
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        uuid: crypto.randomUUID(),
        parentUuid: null,
        isSidechain: false,
        message: { role: "user", content: [{ type: "text", text: "recap request" }] },
      })}\n`,
    );
  }
  // The real child takes about a minute, and requirement 180's whole claim is about what the screen
  // says WHILE it runs — a stub that answered instantly left the running block on screen for a few
  // hundred milliseconds, so a pin asserting the clock ticks could only ever be racy or vacuous.
  // Only the recap child waits, and only for as long as it takes to read the line twice.
  await Bun.sleep(Number(process.env["LOOM_STUB_RECAP_MS"] ?? 4000));
  const titled = /## The session — "([^"]*)"/.exec(prompt)?.[1] ?? "the previous session";
  process.stdout.write(
    [
      "# State",
      "",
      `Stubbed recap of ${titled}. The centre column is settled in prototype and not built.`,
      "",
      "# Open threads",
      "",
      "1. Build it — the prototype is the whole result so far.",
      "",
      "# Decisions made (with the why)",
      "",
      "Tabs left the centre, because chrome is what made the column feel small.",
      "",
      "# Decided but never written down",
      "",
      "Nothing.",
      "",
      "# Landed (git-confirmed)",
      "",
      "Nothing in the window.",
      "",
      "# Claimed but unconfirmed",
      "",
      "Nothing.",
      "",
      "# Traps",
      "",
      "Nothing.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const sessionId = flag("--resume") ?? flag("--session-id") ?? "stub-session";
const root = process.env["LOOM_PROJECTS_ROOT"];
if (root === undefined) {
  console.error("stub-claude: LOOM_PROJECTS_ROOT required");
  process.exit(1);
}

const dir = join(root, escapeCwd(process.cwd()));
await mkdir(dir, { recursive: true });
const file = join(dir, `${sessionId}.jsonl`);

let stamp = 0;
function row(role: "user" | "assistant", body: string | unknown[]): string {
  stamp += 1;
  return `${JSON.stringify({
    type: role,
    uuid: `stub-${sessionId.slice(0, 8)}-${Date.now()}-${stamp}`,
    parentUuid: null,
    timestamp: new Date().toISOString(),
    sessionId,
    cwd: process.cwd(),
    isSidechain: false,
    message: { role, content: typeof body === "string" ? [{ type: "text", text: body }] : body },
  })}\n`;
}

function emit(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** Set while a turn is in flight so an interrupt can cut it short, the way the real CLI does. */
let interrupted = false;

// ── the intermediate frames, in the real binary's shape (SPEC 96) ──

let toolSeq = 0;

/** One `assistant` frame carrying exactly ONE tool_use block — the real wire shape. */
function emitCall(name: string, input: Record<string, unknown>): string {
  toolSeq += 1;
  const id = `toolu_stub${toolSeq}`;
  emit({
    type: "assistant",
    message: {
      model: "stub-model",
      id: `msg_stub${toolSeq}`,
      type: "message",
      role: "assistant",
      content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  return id;
}

function emitResult(id: string): void {
  emit({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: "stub" }] },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}

/** The thinking counter, which resets per block exactly as the real one does. */
function emitThinking(deltas: number[]): void {
  let total = 0;
  for (const delta of deltas) {
    total += delta;
    emit({ type: "system", subtype: "thinking_tokens", estimated_tokens: total, estimated_tokens_delta: delta, session_id: sessionId });
  }
}

async function runTurn(message: { content?: Array<Record<string, unknown>> }): Promise<void> {
  const content = message.content ?? [];
  const text = String(content.find((b) => b["type"] === "text")?.["text"] ?? "");
  const imageCount = content.filter((b) => b["type"] === "image").length;

  // The real CLI stores the user message VERBATIM, image blocks included — the stub must too, or
  // the driven test can never see an image render through the read path.
  appendFileSync(file, row("user", content.length > 0 ? content : text));

  if (text.includes("permission")) {
    const url = process.env["LOOM_PERMIT_URL"];
    if (url === undefined) {
      appendFileSync(file, row("assistant", "stub error: no LOOM_PERMIT_URL"));
      emit({ type: "result", subtype: "error_during_execution", is_error: true });
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        toolName: "Write",
        toolInput: { file_path: "/tmp/stub-target.txt", content: "stub" },
      }),
    });
    const { verdict } = (await res.json()) as { verdict: "allow" | "deny" };
    appendFileSync(file, row("assistant", `stub verdict: ${verdict}`));
    emit({ type: "result", subtype: "success", total_cost_usd: 0.01, is_error: false, usage: USAGE });
    return;
  }

  // Ten calls inside a second: the strobe case. Same kind on purpose, so the quieting rule has to
  // collapse them into one counted line instead of drawing ten labels in a row.
  if (text.includes("burst")) {
    emitThinking([30, 80]);
    for (let i = 0; i < 10 && !interrupted; i += 1) {
      const id = emitCall("Grep", { pattern: `needle-${i}`, path: "." });
      await Bun.sleep(60);
      emitResult(id);
    }
    await Bun.sleep(1200); // let the last window flush before the turn ends
    appendFileSync(file, row("assistant", "stub: burst done"));
    emit({ type: "result", subtype: "success", total_cost_usd: 0.01, is_error: false, usage: USAGE });
    return;
  }

  // One step, then nothing: the hang case. A spinner alone would keep spinning here, which is the
  // whole reason the label has to start admitting how long it has been held.
  if (text.includes("quiet")) {
    emitThinking([12, 40]);
    // Deliberately long: this is also the phone case (SPEC 96) — a tool target is a long string and
    // the composer toolbar is the tightest row loom has, so the label must clip rather than push the
    // send button off the screen.
    emitCall("Bash", {
      command: "sleep 1000",
      description: "the thing that hangs and never comes back, not once, not ever",
    });
    for (let i = 0; i < 400 && !interrupted; i += 1) await Bun.sleep(100);
    appendFileSync(file, row("assistant", interrupted ? "stub: interrupted" : "stub: quiet done"));
    emit({
      type: "result",
      subtype: interrupted ? "error_during_execution" : "success",
      is_error: interrupted,
      usage: USAGE,
    });
    return;
  }

  // A turn that leaves TOOL ROWS in the transcript file. Everything above emits calls on stdout
  // only — that is the working indication's material and it never reaches disk — so without this
  // branch the driven specs have no real disclosure to open, and what a reader has UNFOLDED cannot
  // be tested at all. Three calls on purpose: that is `FOLD_AT`, so the turn carries both a strip
  // and the tool rows inside it.
  if (text.includes("tools")) {
    const calls = [
      { name: "Read", input: { file_path: "/tmp/stub-one.txt" } },
      { name: "Grep", input: { pattern: "needle", path: "." } },
      { name: "Bash", input: { command: "echo stub" } },
    ].map((call) => ({ ...call, id: `toolu_row${(toolSeq += 1)}` }));
    appendFileSync(
      file,
      row("assistant", calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }))),
    );
    appendFileSync(
      file,
      row("user", calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: `output of ${c.name}` }))),
    );
    appendFileSync(file, row("assistant", "stub: tools done"));
    emit({ type: "result", subtype: "success", total_cost_usd: 0.01, is_error: false, usage: USAGE });
    return;
  }

  // `[hold]` — the turn ends when the TEST releases it, never on a timer. The marker is bracketed
  // because "hold" as a bare word already appears in a prompt another spec sends ("slow one holding
  // the turn"), and a keyword that fires on a substring of somebody else's sentence is the next
  // flake rather than the end of this one.
  if (text.includes("[hold]")) {
    const gate = process.env["LOOM_STUB_HOLD"];
    // 60s cap: a spec that forgets to release must fail on its own assertion, not hang the suite.
    if (gate !== undefined && gate.length > 0) {
      for (let i = 0; i < 1200 && !interrupted && !existsSync(gate); i += 1) await Bun.sleep(50);
    }
  } else if (text.includes("slow")) {
    // Long enough for a test to queue another message or press stop, short enough not to drag.
    for (let i = 0; i < 60 && !interrupted; i += 1) await Bun.sleep(100);
  }
  if (interrupted) {
    appendFileSync(file, row("assistant", "stub: interrupted"));
    emit({ type: "result", subtype: "error_during_execution", is_error: true, usage: USAGE });
    return;
  }

  const suffix = imageCount > 0 ? ` [saw ${imageCount} image${imageCount === 1 ? "" : "s"}]` : "";
  // The flags the picker asked for, echoed through the transcript — that is how the driven spec
  // sees the whole path (select → POST → allowlist → argv) instead of one end of it (SPEC 49).
  // `mcp` used to read the browser switch, off the ABSENCE of `--strict-mcp-config`. That flag
  // became unconditional on 2026-09-01 when the browsers went always-on (1f3f1af retired
  // `req.browser` from `childArgs` and the fingerprint), so the reading could only ever say "off"
  // and this spec has been red since. What is worth pinning now is that every child is handed an
  // MCP config at all — the browsers reaching the child is the thing that breaks silently.
  const flags =
    ` [model=${flag("--model") ?? "-"} effort=${flag("--effort") ?? "-"}` +
    ` mcp=${args.includes("--mcp-config") ? "on" : "off"}]`;
  appendFileSync(file, row("assistant", `stub reply: ${text}${suffix}${flags}`));
  emit({ type: "result", subtype: "success", total_cost_usd: 0.01, is_error: false, usage: USAGE });
}

/**
 * Cache numbers shaped like the real thing: a turn READS the prefix its predecessor wrote. The
 * Runner turns this into the "cache N% reused" status line, so a stub reporting zeroes would leave
 * the one number this whole rewrite exists for untested.
 */
const USAGE = { cache_read_input_tokens: 20000, cache_creation_input_tokens: 250 };

// ── the stdin loop: frames arrive as they are written, turns run in order ──
const queue: Array<{ content?: Array<Record<string, unknown>> }> = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    interrupted = false;
    await runTurn(next);
  }
  draining = false;
}

/**
 * A LAST RESORT, since 2026-08-29. The stub's stdin is now a FIFO it holds open itself (SPEC 255),
 * so "loom went away" is not end-of-file here any more than it is for the real binary — which is
 * the property under test. The cost is that a stub whose loom is never coming back would sit there
 * forever, and a pin run leaves a few of those. Ten minutes is longer than any suite and shorter
 * than a lunch; the real binary needs no equivalent because a real loom adopts or sweeps it.
 */
const IDLE_EXIT_MS = 10 * 60 * 1000;
let lastFrameAt = Date.now();
setInterval(() => {
  if (!draining && queue.length === 0 && Date.now() - lastFrameAt > IDLE_EXIT_MS) process.exit(0);
}, 30_000).unref();

const decoder = new TextDecoder();
const stdin = Bun.stdin.stream().getReader();
let buffer = "";
for (;;) {
  const { done, value } = await stdin.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  lastFrameAt = Date.now();
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // Unparseable stdin is ignored, exactly as the real binary tolerates noise.
    }

    if (frame["type"] === "control_request") {
      const request = frame["request"] as Record<string, unknown> | undefined;
      if (request?.["subtype"] === "interrupt") {
        interrupted = true;
        emit({
          type: "control_response",
          response: { subtype: "success", request_id: frame["request_id"], response: { still_queued: [] } },
        });
      }
      continue;
    }

    if (frame["type"] === "user") {
      queue.push((frame["message"] ?? {}) as { content?: Array<Record<string, unknown>> });
      void drain();
    }
  }
}

// stdin closed: finish anything still queued, then exit like the real binary does.
while (draining || queue.length > 0) await Bun.sleep(50);
process.exit(0);
