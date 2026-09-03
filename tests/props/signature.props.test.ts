/**
 * `turnSignature` — the function a stale row would come through (SPEC 211).
 *
 * The redraw is still full, but it only REACHES the DOM for a turn whose signature changed. So the
 * one-directional rule is the whole safety argument, and it is stated as a property rather than as
 * a set of cases I thought of: **any change to any input the renderer reads must change the
 * signature.** The other direction is allowed to be wasteful and is not asserted.
 *
 * Metamorphic, deliberately: every property compares TWO runs — the same turn against itself, and a
 * turn against the same turn with one field moved. A naive "the signature is a non-empty string"
 * would pass on a function that returned a constant, which is the shape that makes this build
 * dangerous rather than merely slow.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mark, turnSignature } from "../../client/signature.ts";
import type { Block, Message, RenderOptions } from "../../client/render.ts";

function options(over: Partial<RenderOptions> = {}): RenderOptions {
  return {
    ctx: { cwd: null, records: [] },
    results: new Map<string, Block>(),
    pinned: false,
    showThinking: false,
    showMeta: false,
    onPin: () => undefined,
    stamp: "",
    ...over,
  };
}

const text = fc.string({ maxLength: 300 });

const block: fc.Arbitrary<Block> = fc.oneof(
  fc.record({ kind: fc.constant("text" as const), text }),
  fc.record({ kind: fc.constant("thinking" as const), text }),
  fc.record({
    kind: fc.constant("tool_use" as const),
    id: fc.string({ minLength: 1, maxLength: 8 }),
    name: fc.constantFrom("Bash", "Read", "Edit", "Grep"),
    input: fc.dictionary(fc.string({ maxLength: 6 }), text, { maxKeys: 3 }),
  }),
  fc.record({ kind: fc.constant("tool_result" as const), forId: fc.string({ maxLength: 8 }), text }),
  fc.record({ kind: fc.constant("image" as const), mediaType: fc.constant("image/png"), data: text }),
);

const message: fc.Arbitrary<Message> = fc.record({
  uuid: fc.uuid(),
  parentUuid: fc.constant(null),
  role: fc.constantFrom("user" as const, "assistant" as const),
  ts: fc.constant("2026-08-14T10:00:00.000Z"),
  blocks: fc.array(block, { minLength: 1, maxLength: 5 }),
  isSidechain: fc.constant(false),
  isMeta: fc.boolean(),
  endsTurn: fc.boolean(),
});

const turn = fc.array(message, { minLength: 1, maxLength: 4 });

describe("turnSignature (SPEC 211)", () => {
  test("the same turn always signs the same — otherwise nothing is ever reused", () => {
    fc.assert(
      fc.property(turn, (rows) => {
        expect(turnSignature(rows, options())).toBe(turnSignature(rows, options()));
      }),
      { numRuns: 300 },
    );
  });

  test("a changed BLOCK changes the signature", () => {
    fc.assert(
      fc.property(turn, fc.nat(), block, (rows, at, replacement) => {
        const first = rows[0];
        if (first === undefined) return;
        const index = at % first.blocks.length;
        const before = turnSignature(rows, options());
        const edited: Message[] = [
          { ...first, blocks: first.blocks.map((b, i) => (i === index ? replacement : b)) },
          ...rows.slice(1),
        ];
        const after = turnSignature(edited, options());
        // Only when the block really is different — fast-check will regenerate an identical one.
        if (JSON.stringify(first.blocks[index]) === JSON.stringify(replacement)) return;
        expect(after).not.toBe(before);
      }),
      { numRuns: 400 },
    );
  });

  test("a tool RESULT arriving, changing, or failing changes the signature", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 8 }), text, text, (id, one, two) => {
        const rows: Message[] = [
          {
            uuid: "u",
            parentUuid: null,
            role: "assistant",
            ts: "",
            blocks: [{ kind: "tool_use", id, name: "Bash", input: { command: "ls" } }],
            isSidechain: false,
            isMeta: false,
          },
        ];
        const withResult = (t: string, isError: boolean): RenderOptions =>
          options({ results: new Map([[id, { kind: "tool_result", forId: id, text: t, isError }]]) });

        const none = turnSignature(rows, options());
        const landed = turnSignature(rows, withResult(one, false));
        expect(landed).not.toBe(none); // a result arriving is a redraw
        expect(turnSignature(rows, withResult(one, true))).not.toBe(landed); // ok -> error is a redraw
        if (one !== two && mark(one) !== mark(two)) {
          expect(turnSignature(rows, withResult(two, false))).not.toBe(landed);
        }
      }),
      { numRuns: 300 },
    );
  });

  // `scale` is the one option that moves on its own: `/api/bar` repolls every 20s and the window
  // percent and the block's unit total both change, so a turn that will never change again still
  // renders a DIFFERENT cost figure. Nothing else in the signature notices, which is exactly the
  // stale-content failure this file exists to prevent (usage-bar, 2026-08-26).
  test("a moved `scale` is carried when the turn has usage, and ignored when it has none", () => {
    fc.assert(
      fc.property(turn, (rows) => {
        const priced = rows.map((row, i) => ({
          ...row,
          usage: { requestId: `req-${String(i)}`, units: 10_000 + i, read: 90, write: 10, ctx: 100, ttlMs: null },
        }));
        const base = turnSignature(priced, options({ scale: 0.00002 }));
        // A scale that moves the DISPLAYED figure must move the signature.
        expect(turnSignature(priced, options({ scale: 0.00004 }))).not.toBe(base);
        // And a turn with no usage draws no figure, so it must not churn when scale moves.
        expect(turnSignature(rows, options({ scale: 0.00004 }))).toBe(
          turnSignature(rows, options({ scale: 0.00002 })),
        );
      }),
      { numRuns: 200 },
    );
  });

  test("every option outside the turn is carried — stamp, meta, thinking, pinned", () => {
    fc.assert(
      fc.property(turn, fc.string({ maxLength: 20 }), (rows, stamp) => {
        const base = turnSignature(rows, options());
        if (stamp.length > 0) expect(turnSignature(rows, options({ stamp }))).not.toBe(base);
        expect(turnSignature(rows, options({ showMeta: true }))).not.toBe(base);
        expect(turnSignature(rows, options({ showThinking: true }))).not.toBe(base);
        expect(turnSignature(rows, options({ pinned: true }))).not.toBe(base);
      }),
      { numRuns: 200 },
    );
  });

  test("a turn cannot be confused with a different turn — uuid, order, length", () => {
    fc.assert(
      fc.property(turn, message, (rows, extra) => {
        const base = turnSignature(rows, options());
        expect(turnSignature([...rows, extra], options())).not.toBe(base); // a row appended
        const first = rows[0];
        if (first !== undefined) {
          const renamed = [{ ...first, uuid: `${first.uuid}x` }, ...rows.slice(1)];
          expect(turnSignature(renamed, options())).not.toBe(base);
          const flipped = [{ ...first, endsTurn: first.endsTurn !== true }, ...rows.slice(1)];
          expect(turnSignature(flipped, options())).not.toBe(base);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("mark keeps short text whole, and bounds long text without losing either end", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (value) => {
        const marked = mark(value);
        if (value.length <= 96) expect(marked).toBe(value);
        else {
          expect(marked).toContain(String(value.length));
          expect(marked).toContain(value.slice(0, 48));
          expect(marked).toContain(value.slice(-48));
          expect(marked.length).toBeLessThanOrEqual(value.length + 24);
        }
      }),
      { numRuns: 300 },
    );
  });
});
