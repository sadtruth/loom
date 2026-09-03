#!/usr/bin/env bun
/**
 * Capture the REAL `claude` stdout frame stream, once, into a committed fixture.
 *
 * Why this exists (build skill, "never build the fixture from the code's own assumption"): the
 * working indication reads the child's intermediate stdout frames to name the step in flight. Every
 * field it touches — `type`, `message.content[].type`, `name`, `input`, `parent_tool_use_id` — is
 * the real binary's wire format, not ours. A stub shaped from what we ASSUME that format is would
 * let the parser and its test agree with each other while both disagree with the CLI.
 *
 * So: run this once against the real binary, keep the output, and pin the parser against it
 * (`tests/props/step.props.test.ts` §real-sample). Re-run it when the CLI's output format changes.
 *
 *     bun tests/fixture/capture-frames.ts                  # writes real-stdout-frames.jsonl
 *
 * It costs one cheap turn on haiku. The prompt is written to force the three shapes the label logic
 * has to survive: a lone tool call, a PARALLEL burst in one assistant frame, and plain text.
 */

import { join } from "node:path";

const BIN = Bun.env["LOOM_CLAUDE_BIN"] ?? "claude";
const OUT = join(import.meta.dir, "real-stdout-frames.jsonl");
const CWD = join(import.meta.dir, "capture-scratch");

await Bun.write(join(CWD, "alpha.txt"), "alpha\n");
await Bun.write(join(CWD, "beta.txt"), "beta\n");

const proc = Bun.spawn(
  [
    BIN,
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--model",
    "haiku",
    "--settings",
    JSON.stringify({ permissions: { defaultMode: "auto" } }),
    "--session-id",
    crypto.randomUUID(),
  ],
  { cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

const stdin = proc.stdin as Bun.FileSink;
stdin.write(
  `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Read alpha.txt and beta.txt in one parallel batch of two Read calls. " +
            "Then run the bash command `echo hi`. Then say the word done. Nothing else.",
        },
      ],
    },
  })}\n`,
);
stdin.flush();

const lines: string[] = [];
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    lines.push(line);
    const row = JSON.parse(line) as Record<string, unknown>;
    console.log(`frame: ${String(row["type"])}`);
    if (row["type"] === "result") {
      void stdin.end();
    }
  }
}

await Bun.write(OUT, `${lines.join("\n")}\n`);
console.log(`\nwrote ${lines.length} frames → ${OUT}`);
