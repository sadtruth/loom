/**
 * The recap filter (SPEC §Recap, requirements 170 and 178).
 *
 * Both properties are METAMORPHIC — each asserts a relation between two runs rather than a claim
 * about one output, because a claim about one output is how a filter test comes to restate the
 * filter. "Every user turn survives" is the trap: on a real transcript almost every row is a `user`
 * row (171 of 179 measured), so the honest statement is about what CHANGES when noise is added,
 * not about what is kept.
 *
 * The fixtures are real rows, copied unreshaped out of real transcripts, because a fixture built
 * from the code's own assumption proves the assumption, not the code. The one edit made to them is
 * `meta-row.jsonl`'s `sessionId`, rewritten to the session it is spliced into: a row lifted from
 * another transcript carries another session's identity, and a file containing it could not exist.
 * The property caught that too — it was the second counterexample, after the timestamps.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseTranscript } from "../../server/transcript.ts";
import { buildBrief, conversation, worthRecapping } from "../../server/recap/filter.ts";

const FIX = join(import.meta.dir, "../fixtures/recap");
const SESSION = readFileSync(join(FIX, "session-a.jsonl"), "utf8");
const META_ROW = readFileSync(join(FIX, "meta-row.jsonl"), "utf8").trim();

/** Splice extra rows into a transcript after row `at`, preserving JSONL shape. */
function splice(text: string, rows: readonly string[], at: number): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const head = lines.slice(0, at);
  const tail = lines.slice(at);
  return [...head, ...rows, ...tail].join("\n") + "\n";
}

function toolResultRow(id: string, body: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: body }] },
    uuid: `gen-${id}`,
    timestamp: "2026-08-12T10:00:00.000Z",
  });
}

describe("the real fixture", () => {
  test("it is real rows, not a shape this test invented", () => {
    const model = parseTranscript(SESSION);
    expect(model.messages.length).toBeGreaterThan(20);
    expect(model.skipped).toBe(0);
    // the noise this filter exists to drop is actually present
    const toolResults = model.messages.filter((m) =>
      m.blocks.some((b) => b.kind === "tool_result"),
    );
    expect(toolResults.length).toBeGreaterThan(5);
  });

  test("the brief is a fraction of the transcript it came from", () => {
    const brief = buildBrief(parseTranscript(SESSION));
    expect(brief.stats.bytes).toBeLessThan(SESSION.length / 2);
    expect(brief.stats.userTurns).toBeGreaterThan(0);
  });

  test("his words are reproduced, not paraphrased", () => {
    const model = parseTranscript(SESSION);
    const convo = conversation(model);
    const said = model.messages
      .filter((m) => m.role === "user" && !m.isMeta && !m.isSidechain)
      .flatMap((m) => m.blocks)
      .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text.trim())
      .filter((t) => t.length > 0 && !t.startsWith("<system-reminder>"));
    expect(said.length).toBeGreaterThan(0);
    for (const t of said) expect(convo).toContain(t);
  });
});

describe("requirement 170 — tool results carry nothing the conversation needs", () => {
  test("adding any number of tool_result rows does not change the conversation", () => {
    const base = conversation(parseTranscript(SESSION));
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 400 }), { minLength: 1, maxLength: 12 }),
        fc.nat({ max: 30 }),
        (bodies, at) => {
          const rows = bodies.map((b, i) => toolResultRow(`t${i}`, b));
          const grown = splice(SESSION, rows, at);
          expect(conversation(parseTranscript(grown))).toBe(base);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("requirement 178 — a recap never eats its own output", () => {
  test("a meta row changes nothing about the brief", () => {
    const without = buildBrief(parseTranscript(SESSION)).text;
    fc.assert(
      fc.property(fc.nat({ max: 30 }), (at) => {
        const grown = splice(SESSION, [META_ROW], at);
        expect(buildBrief(parseTranscript(grown)).text).toBe(without);
      }),
      { numRuns: 30 },
    );
  });

  test("a reminder riding alongside his own words drops the reminder and keeps the words", () => {
    const mine = "this sentence is his and must survive";
    const row = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: `<system-reminder>\nwhere you left off: everything\n</system-reminder>` },
          { type: "text", text: mine },
        ],
      },
      uuid: "gen-mixed",
      timestamp: "2026-08-12T10:00:00.000Z",
    });
    const convo = conversation(parseTranscript(splice(SESSION, [row], 4)));
    expect(convo).toContain(mine);
    expect(convo).not.toContain("where you left off");
  });

  test("a row that is ONLY a reminder — the shape loom itself writes — never reaches the brief", () => {
    const row = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>\nrecap of the previous session\n</system-reminder>" }],
      },
      uuid: "gen-recap",
      timestamp: "2026-08-12T10:00:00.000Z",
    });
    const before = buildBrief(parseTranscript(SESSION)).text;
    expect(buildBrief(parseTranscript(splice(SESSION, [row], 6))).text).toBe(before);
  });
});

describe("scenario 5 — a session with nothing said in it", () => {
  test("emptiness is counted after filtering, not on the raw file", () => {
    const noise = Array.from({ length: 40 }, (_, i) => toolResultRow(`n${i}`, "output"));
    expect(worthRecapping(parseTranscript(noise.join("\n") + "\n"))).toBe(false);
    expect(worthRecapping(parseTranscript(SESSION))).toBe(true);
  });
});
