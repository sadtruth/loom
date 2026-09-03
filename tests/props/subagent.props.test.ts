import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { parseSubagentLines, parseBackgroundLines, inspectAgentState } from "../../server/subagent-parser.ts";

describe("Subagent properties (SPEC 2)", () => {
  test("A subagent's rows are derived purely from its file's frames", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ type: fc.constant("assistant"), stop_reason: fc.constant("end_turn") }),
            fc.record({ type: fc.constant("user"), message: fc.constant("hello") }),
            fc.record({ type: fc.constant("assistant"), tool_use: fc.constant({}) }),
            fc.record({ type: fc.constant("unknown"), something: fc.constant(1) })
          )
        ),
        (frames) => {
          const lines = frames.map((f) => JSON.stringify(f));
          // Split randomly to simulate chunks
          const { ownEndTurn, rowCount } = parseSubagentLines(lines);
          expect(rowCount).toBe(frames.length);

          // If the last frame that matters is assistant with end_turn, ownEndTurn is true
          let expectedEndTurn = false;
          for (const f of frames) {
            if (f.type === "assistant") {
              expectedEndTurn = (f as any).stop_reason === "end_turn";
            } else if (f.type === "user") {
              expectedEndTurn = false;
            }
          }
          expect(ownEndTurn).toBe(expectedEndTurn);
        }
      )
    );
  });

  test("A finished agent never renders as running", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }), // now
        fc.integer({ min: 0, max: 100_000 }), // mtimeMs
        (now, mtimeMs) => {
          const state = inspectAgentState(
            "agent-1",
            now,
            mtimeMs,
            mtimeMs - 1000,
            null,
            "test",
            "test",
            null,
            null,
            1,
            true, // ownEndTurn is true (FINISHED)
            false,
            false
          );
          expect(state.verdict).toBe("FINISHED");
        }
      )
    );
  });

  test("A silent-but-alive agent and a dead one are distinguishable (STALE/DEAD)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 35_000, max: 100_000 }), // idle > 30s
        fc.boolean(), // parentTerminal
        (idleMs, parentTerminal) => {
          const now = 100_000;
          const mtimeMs = now - idleMs;
          const state = inspectAgentState(
            "agent-2",
            now,
            mtimeMs,
            mtimeMs - 1000,
            null,
            "test",
            "test",
            null,
            null,
            1,
            false,
            false,
            parentTerminal
          );
          expect(state.verdict).toBe(parentTerminal ? "DEAD" : "STALE / POSSIBLY DEAD");
        }
      )
    );
  });

  test("A truncated or malformed frame does not throw and does not lose the rows before it", () => {
    const lines = [
      JSON.stringify({ type: "assistant", tool_use: {} }),
      JSON.stringify({ type: "user" }),
      '{"type":"assistant","stop_reason":"en', // Malformed line
      JSON.stringify({ type: "assistant", stop_reason: "end_turn" })
    ];
    const { rowCount, ownEndTurn } = parseSubagentLines(lines);
    expect(rowCount).toBe(3); // 3 valid lines parsed
    expect(ownEndTurn).toBe(true);
  });

  test("Tailing a background command's output file yields the same text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 })),
        (lines) => {
          const { label, rowCount } = parseBackgroundLines(lines);
          const validLines = lines.filter(l => l.trim().length > 0);
          expect(rowCount).toBe(validLines.length);
          if (validLines.length > 0) {
            expect(label).toBe(validLines[validLines.length - 1] ?? null);
          } else {
            expect(label).toBeNull();
          }
        }
      )
    );
  });
});
