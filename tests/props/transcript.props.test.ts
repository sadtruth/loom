/**
 * PROPERTY PINS for the transcript parser + tailer. The machine invents the cases.
 *
 * WHY THIS FILE EXISTS. The tailer's entire correctness claim is "reading the file in arbitrary
 * chunks gives the same answer as reading it whole", and that claim has two independent ways to fail
 * that hand-written cases systematically miss: a UTF-8 character split across a read boundary, and a
 * JSON line split across a read boundary. Both only show up at specific byte offsets that nobody
 * thinks to pick. Property 1 is metamorphic — it asserts a RELATIONSHIP between two runs rather than
 * a claim about one output, which is what makes it immune to my imagination.
 *
 * The generators deliberately carry Cyrillic and emoji. A Latin-only generator can never split a
 * multibyte character, so it would pass on a decoder with no streaming state at all — i.e. it would
 * be a property that cannot fail, which is worse than no property.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { TranscriptParser, aggregate, parseTranscript, type Touch } from "../../server/transcript.ts";
import { feedChunks } from "../../server/tail.ts";

const encoder = new TextEncoder();

/** Text that actually exercises the decoder: Latin, Cyrillic, emoji, escapes. */
const textArb = fc.stringMatching(/^[a-z А-я—"'\n]{0,80}$/u);

const richText = fc.oneof(
  textArb,
  fc.constant("путь: /Users/serbir/docs/Заметки/файл.md"),
  fc.constant("emoji 🌒🜂 and a tab\tinside"),
  fc.constant('quote "внутри" and a backslash \\ here'),
);

const uuidArb = fc.uuid();

const toolUseArb = fc.record({
  type: fc.constant("tool_use"),
  id: fc.string({ minLength: 3, maxLength: 12 }).map((s) => `toolu_${s.replace(/[^a-zA-Z0-9]/g, "x")}`),
  name: fc.constantFrom("Bash", "Read", "Write", "Edit", "Grep", "NotebookEdit"),
  input: fc.oneof(
    fc.record({ file_path: fc.constantFrom("/Users/s/a.md", "/home/b/резюме.txt", "/tmp/x.ts") }),
    fc.record({ command: richText }),
  ),
});

const blockArb = fc.oneof(
  fc.record({ type: fc.constant("text"), text: richText }),
  fc.record({ type: fc.constant("thinking"), thinking: richText }),
  toolUseArb,
  fc.record({
    type: fc.constant("tool_result"),
    tool_use_id: fc.string({ minLength: 3, maxLength: 10 }),
    content: fc.oneof(richText, fc.array(fc.record({ type: fc.constant("text"), text: richText }), { maxLength: 3 })),
    is_error: fc.boolean(),
  }),
);

const rowArb = fc.oneof(
  fc.record({
    type: fc.constantFrom("user", "assistant", "system"),
    uuid: uuidArb,
    parentUuid: fc.oneof(uuidArb, fc.constant(null)),
    timestamp: fc.constantFrom("2026-07-30T08:00:00.000Z", "2026-07-31T15:00:00.000Z"),
    sessionId: fc.constant("s1"),
    cwd: fc.constant("/Users/serbir/docs"),
    isSidechain: fc.boolean(),
    message: fc.record({ content: fc.array(blockArb, { maxLength: 4 }) }),
  }),
  fc.record({ type: fc.constant("ai-title"), aiTitle: richText, sessionId: fc.constant("s1") }),
  fc.record({
    type: fc.constant("file-history-delta"),
    trackingPath: fc.constantFrom("tools/loom/SPEC.md", "заметки/файл.md"),
    messageId: uuidArb,
    timestamp: fc.constant("2026-07-30T08:10:00.000Z"),
    backup: fc.record({ realParentDir: fc.constant("/Users/serbir/docs/Projects/Personal Claude/tools") }),
  }),
  fc.record({ type: fc.constant("queue-operation"), operation: fc.constant("x") }),
  fc.record({ type: fc.constant("some-future-row-type"), whatever: richText }),
);

/** A transcript buffer: JSONL, optionally with blank lines and a truncated tail. */
const transcriptArb = fc
  .array(rowArb, { minLength: 1, maxLength: 12 })
  .map((rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

describe("byte-split invariance (the tailer's whole claim)", () => {
  test("chunked feed equals whole feed, for any split points", () => {
    fc.assert(
      fc.property(transcriptArb, fc.array(fc.nat({ max: 4000 }), { maxLength: 12 }), (text, splits) => {
        const bytes = encoder.encode(text);
        const chunked = feedChunks(bytes, splits).model();
        const whole = parseTranscript(text);
        expect(JSON.stringify(chunked)).toBe(JSON.stringify(whole));
      }),
      { numRuns: 400 },
    );
  });

  test("byte-by-byte feed equals whole feed", () => {
    fc.assert(
      fc.property(transcriptArb, (text) => {
        const bytes = encoder.encode(text);
        const everyByte = [...bytes.keys()];
        expect(JSON.stringify(feedChunks(bytes, everyByte).model())).toBe(JSON.stringify(parseTranscript(text)));
      }),
      { numRuns: 60 },
    );
  });

  test("a multibyte character split across chunks survives", () => {
    // Explicit regression-shaped case: without a streaming decoder this yields U+FFFD.
    const text = `${JSON.stringify({ type: "ai-title", aiTitle: "Резюме 🌒", sessionId: "s" })}\n`;
    const bytes = encoder.encode(text);
    for (let cut = 1; cut < bytes.byteLength; cut += 1) {
      expect(feedChunks(bytes, [cut]).model().meta.title).toBe("Резюме 🌒");
    }
  });
});

describe("total parser", () => {
  test("never throws on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (junk) => {
        expect(() => parseTranscript(junk)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  test("never throws on truncated JSON lines", () => {
    fc.assert(
      fc.property(transcriptArb, fc.nat({ max: 3000 }), (text, cut) => {
        expect(() => parseTranscript(text.slice(0, cut))).not.toThrow();
      }),
      { numRuns: 400 },
    );
  });

  test("every emitted message has a non-empty uuid", () => {
    fc.assert(
      fc.property(transcriptArb, (text) => {
        for (const message of parseTranscript(text).messages) {
          expect(message.uuid.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("trailing partial line is not a message", () => {
  test("a buffer with an unterminated last line equals the same buffer cut at its last newline", () => {
    fc.assert(
      fc.property(transcriptArb, fc.string({ maxLength: 120 }), (text, tail) => {
        const withTail = text + tail.replace(/\n/g, "");
        expect(JSON.stringify(parseTranscript(withTail).messages)).toBe(
          JSON.stringify(parseTranscript(text).messages),
        );
      }),
      { numRuns: 300 },
    );
  });

  test("the held-back line is emitted once its newline arrives", () => {
    const row = JSON.stringify({ type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "hi" }] } });
    const parser = new TranscriptParser();
    parser.push(row.slice(0, 10));
    expect(parser.messageCount).toBe(0);
    parser.push(row.slice(10));
    expect(parser.messageCount).toBe(0);
    parser.push("\n");
    expect(parser.messageCount).toBe(1);
  });
});

describe("touch aggregation", () => {
  const touchArb: fc.Arbitrary<Touch> = fc.record({
    path: fc.constantFrom("/a/x.md", "/a/y.ts", "/b/z.py"),
    op: fc.constantFrom<Touch["op"]>("read", "write", "edit"),
    ts: fc.constantFrom("2026-07-30T08:00:00Z", "2026-07-30T09:00:00Z"),
    msgUuid: fc.constantFrom("m1", "m2"),
  });

  test("path/kind/count is invariant under permutation of arrival order", () => {
    fc.assert(
      fc.property(fc.array(touchArb, { maxLength: 25 }), (touches) => {
        const shape = (list: readonly Touch[]): string =>
          JSON.stringify(aggregate(list).map((a) => [a.path, a.kind, a.count]));
        const shuffled = [...touches].reverse();
        expect(shape(shuffled)).toBe(shape(touches));
      }),
      { numRuns: 300 },
    );
  });

  test("a written file outranks a later read of the same path", () => {
    const written = aggregate([
      { path: "/a/x.md", op: "read", ts: "2026-07-30T08:00:00Z", msgUuid: "m1" },
      { path: "/a/x.md", op: "write", ts: "2026-07-30T07:00:00Z", msgUuid: "m2" },
    ]);
    expect(written[0]?.kind).toBe("write");
    expect(written[0]?.count).toBe(2);
  });
});

/**
 * A message he typed while a turn was running (SPEC 235).
 *
 * The CLI writes it as `type: "attachment"` with `attachment.type: "queued_command"`, never as a
 * `user` row, and the parser used to count every attachment as skipped. Measured on his own store,
 * 2026-08-23: 1,118 of them across 140 of 251 sessions, 1,117 of which existed only as that row.
 */
describe("a queued command is his message", () => {
  const row = (over: Record<string, unknown>): string =>
    JSON.stringify({
      parentUuid: "p-1",
      isSidechain: false,
      type: "attachment",
      uuid: "q-1",
      timestamp: "2026-08-23T10:00:00.000Z",
      ...over,
    });

  test("`commandMode: prompt` reads as a user turn, from either prompt shape", () => {
    for (const prompt of ["typed while it worked", [{ type: "text", text: "typed while it worked" }]]) {
      const model = parseTranscript(
        `${row({ attachment: { type: "queued_command", prompt, commandMode: "prompt" } })}\n`,
      );
      expect(model.messages).toHaveLength(1);
      expect(model.messages[0]?.role).toBe("user");
      expect(model.messages[0]?.isMeta).toBe(false);
      expect(model.messages[0]?.blocks[0]).toEqual({ kind: "text", text: "typed while it worked" });
    }
  });

  test("what the harness queued is kept, but marked meta so it hides with every other reminder", () => {
    const model = parseTranscript(
      `${row({
        attachment: {
          type: "queued_command",
          prompt: "<task-notification>\nan agent finished\n</task-notification>",
          commandMode: "task-notification",
        },
      })}\n`,
    );
    expect(model.messages).toHaveLength(1);
    expect(model.messages[0]?.isMeta).toBe(true);
  });

  test("every other attachment kind stays skipped, not drawn", () => {
    for (const type of ["output_style", "hook_success", "todo_reminder", "edited_text_file", "file"]) {
      const model = parseTranscript(`${row({ attachment: { type, prompt: "not a message" } })}\n`);
      expect(model.messages).toHaveLength(0);
      expect(model.skipped).toBe(1);
    }
  });

  test("a queued row with nothing in it is not a message", () => {
    for (const attachment of [
      { type: "queued_command", prompt: "", commandMode: "prompt" },
      { type: "queued_command", prompt: [], commandMode: "prompt" },
      { type: "queued_command", commandMode: "prompt" },
    ]) {
      const model = parseTranscript(`${row({ attachment })}\n`);
      expect(model.messages).toHaveLength(0);
    }
  });

  test("it lands in file order, between the turns it was typed between", () => {
    const before = JSON.stringify({
      type: "user",
      uuid: "u-1",
      timestamp: "2026-08-23T09:00:00.000Z",
      message: { role: "user", content: "before" },
    });
    const after = JSON.stringify({
      type: "assistant",
      uuid: "a-1",
      timestamp: "2026-08-23T11:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "after" }] },
    });
    const queued = row({ attachment: { type: "queued_command", prompt: "in between", commandMode: "prompt" } });
    const model = parseTranscript(`${before}\n${queued}\n${after}\n`);
    expect(model.messages.map((m) => m.uuid)).toEqual(["u-1", "q-1", "a-1"]);
  });
});
