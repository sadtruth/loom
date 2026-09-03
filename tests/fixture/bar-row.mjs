/**
 * One assistant record in the shape the CLI writes — the block meter's fixture atom.
 *
 * Plain .mjs with NO imports on purpose: it is used both by `make-fixture.ts` (Bun) and by the
 * drive spec (Playwright's node runtime), and importing make-fixture from the spec drags in
 * `server/input.ts`, whose `import.meta.dir` is a Bun-ism that is undefined under node.
 */
export function barRow(at, requestId, read, output) {
  return (
    JSON.stringify({
      type: "assistant",
      requestId,
      timestamp: new Date(at).toISOString(),
      sessionId: "bar-fixture",
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "." }],
        usage: {
          cache_read_input_tokens: read,
          cache_creation_input_tokens: 0,
          input_tokens: 1,
          output_tokens: output,
        },
      },
    }) + "\n"
  );
}
