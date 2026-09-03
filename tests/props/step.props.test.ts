/**
 * The working indication's contract (SPEC 96).
 *
 * Two nets here, and they catch different things. The REAL-SAMPLE pin at the bottom is the one that
 * stops the parser and its test from agreeing with each other while both disagree with the CLI: it
 * runs `tests/fixture/real-stdout-frames.jsonl`, captured from the actual binary, through the actual
 * Stepper. It already earned itself — the capture showed that a parallel batch of two Reads arrives
 * as TWO assistant frames with a tool_result between them, not as one frame with two blocks, which
 * is why the collapse rule is temporal and not per-frame.
 *
 * The properties above it hunt the two lies the project exists to prevent, stated as rules rather
 * than as cases: a burst must not strobe (the floor between emits), and a label must not grow
 * without bound or leak a whole path into the tightest row loom has.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { HOLD_MS, Stepper, describeCall, describeGroup, readSignal, type Clock } from "../../server/step.ts";

/** A clock the test drives by hand: nothing happens between `tick`s, so schedules are exact. */
function virtualClock(): Clock & { tick(ms: number): void } {
  let t = 0;
  let seq = 0;
  const booked = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    after(ms, fn) {
      const id = seq++;
      booked.set(id, { at: t + ms, fn });
      return () => booked.delete(id);
    },
    tick(ms) {
      const target = t + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, b] of booked) {
          if (b.at <= target && b.at < nextAt) {
            nextAt = b.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const due = booked.get(nextId);
        booked.delete(nextId);
        t = nextAt;
        due?.fn();
      }
      t = target;
    },
  };
}

const TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Task", "WebFetch", "TodoWrite", "Skill"];

function callFrame(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name, input }] } };
}

function thinkFrame(delta: number): Record<string, unknown> {
  return { type: "system", subtype: "thinking_tokens", estimated_tokens: delta, estimated_tokens_delta: delta };
}

describe("the label names an act, and fits", () => {
  test("never empty, never multiline, never longer than the row can take", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...TOOLS), fc.string({ minLength: 1, maxLength: 40 })),
        fc.dictionary(
          fc.constantFrom("file_path", "command", "pattern", "url", "query", "description", "subagent_type", "skill"),
          fc.string({ maxLength: 400 }),
        ),
        (tool, input) => {
          const label = describeCall(tool, input);
          expect(label.length).toBeGreaterThan(0);
          expect(label).not.toContain("\n");
          expect(label.length).toBeLessThanOrEqual(64);
        },
      ),
      { numRuns: 400 },
    );
  });

  test("a file act carries the file's NAME, never its path", () => {
    // The row this lands in is 390px wide on the phone. A full vault path is the whole line and
    // then some, and the part that identifies the file is the part that gets ellipsed away.
    fc.assert(
      fc.property(
        fc.constantFrom("Read", "Write", "Edit", "NotebookEdit"),
        // Bounded so the assertion is about the basename and not about truncation, and non-blank
        // because a blank segment is not a name — that case is pinned separately below.
        fc.array(fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0 && !s.includes("/")), {
          minLength: 1,
          maxLength: 4,
        }),
        (tool, parts) => {
          const label = describeCall(tool, { file_path: `/${parts.join("/")}` });
          expect(label).not.toContain("/");
          // Compared against the name AS ONE LINE. The label collapses whitespace on purpose — a
          // file called `a\nb` must not break the row — so a literal comparison would be asserting
          // the wrong thing. Found flaky at case 197 on the name `"!  !"`.
          expect(label).toContain((parts[parts.length - 1] ?? "").replace(/\s+/g, " ").trim());
        },
      ),
      { numRuns: 300 },
    );
  });

  test("a path with no name in it still reads as a sentence", () => {
    // The shrunk counterexample from the property above: `"/ "` used to give the label `reading`.
    for (const path of ["/ ", "", "/", "///", "  "]) {
      expect(describeCall("Read", { file_path: path })).toBe("reading a file");
    }
  });

  test("a burst of same-kind calls collapses to ONE line that counts them", () => {
    fc.assert(
      fc.property(fc.constantFrom("Read", "Grep", "Bash"), fc.integer({ min: 2, max: 40 }), (tool, n) => {
        const calls = Array.from({ length: n }, (_, i) => ({ tool, label: describeCall(tool, { file_path: `f${i}.ts`, pattern: `p${i}`, command: `c${i}` }) }));
        const group = describeGroup(calls);
        expect(group).toContain(String(n));
        expect(group).not.toContain("\n");
      }),
      { numRuns: 200 },
    );
  });
});

describe("the quieting rule — a burst must not strobe (SPEC 96)", () => {
  /**
   * THE load-bearing property. Over any arrival pattern of any signals at any gaps, two consecutive
   * changes of the shown label are never closer together than the floor. A hand-written case can
   * only cover the burst shape I happened to imagine; ten parallel Greps and one call every 801ms
   * are the same rule and only one of them is obvious.
   */
  test("consecutive label changes are never closer together than HOLD_MS", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 3000 }),
            signal: fc.oneof(
              fc.record({ kind: fc.constant("call" as const), tool: fc.constantFrom(...TOOLS), n: fc.integer({ min: 0, max: 50 }) }),
              fc.record({ kind: fc.constant("think" as const), delta: fc.integer({ min: 1, max: 500 }) }),
            ),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (events) => {
          const clock = virtualClock();
          const at: number[] = [];
          const stepper = new Stepper(() => at.push(clock.now()), HOLD_MS, clock);
          for (const e of events) {
            clock.tick(e.gap);
            stepper.feed(
              e.signal.kind === "call"
                ? callFrame(e.signal.tool, { file_path: `f${e.signal.n}.ts`, pattern: `p${e.signal.n}`, command: `c${e.signal.n}` })
                : thinkFrame(e.signal.delta),
            );
          }
          clock.tick(HOLD_MS * 2); // let anything still booked land
          for (let i = 1; i < at.length; i += 1) {
            expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(HOLD_MS);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  test("the floor delays, it never drops: whatever ran last is what the label lands on", () => {
    // Any arrival pattern at all, then quiet, then one more act. The label must be that act. This is
    // the anti-freeze half of the rule — a quieting scheme that can wedge (a window that never
    // flushes, a timer that is never rebooked) leaves the reader watching a step that already ended.
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 30 }),
        fc.array(fc.integer({ min: 0, max: 2000 }), { maxLength: 10 }),
        (gaps, thinks) => {
          const clock = virtualClock();
          const stepper = new Stepper(() => {}, HOLD_MS, clock);
          gaps.forEach((gap, i) => {
            clock.tick(gap);
            stepper.feed(callFrame("Read", { file_path: `f${i}.ts` }));
          });
          thinks.forEach((gap) => {
            clock.tick(gap);
            stepper.feed(thinkFrame(3));
          });
          clock.tick(HOLD_MS * 2);
          stepper.feed(callFrame("Bash", { description: "the last thing" }));
          clock.tick(HOLD_MS * 2);
          expect(stepper.label()).toBe("running the last thing");
        },
      ),
      { numRuns: 200 },
    );
  });

  test("a concrete act outranks thinking inside one window", () => {
    // Thinking fills the gaps between acts, so a window that saw both must name the act — otherwise
    // the label says `thinking` almost always, since every tool result is followed by more of it.
    // Measured against the real capture, a thinking frame precedes its tool_use by 2–342ms, well
    // inside one floor, so this is the ordinary case and not a corner.
    const clock = virtualClock();
    const seen: string[] = [];
    const stepper = new Stepper((l) => seen.push(l), HOLD_MS, clock);
    stepper.feed(thinkFrame(20));
    clock.tick(342);
    stepper.feed(thinkFrame(20));
    stepper.feed(callFrame("Read", { file_path: "/a/b/tasks.ts" }));
    clock.tick(HOLD_MS + 10);
    expect(seen).toEqual(["thinking · 20", "reading tasks.ts"]);
  });

  test("the thinking counter only ever goes up within a turn, and resets with it", () => {
    // The CLI's own `estimated_tokens` RESETS per thinking block (real capture). Summed, it is a
    // number that moves only because the model produced tokens — which is the whole claim the
    // indication makes. Un-summed it would go backwards, and a fact that goes backwards is decoration.
    const clock = virtualClock();
    const seen: string[] = [];
    const stepper = new Stepper((l) => seen.push(l), HOLD_MS, clock);
    for (const d of [200, 300, 600]) {
      stepper.feed(thinkFrame(d));
      clock.tick(HOLD_MS + 1);
    }
    expect(seen).toEqual(["thinking · 200", "thinking · 500", "thinking · 1.1k"]);
    stepper.reset();
    stepper.feed(thinkFrame(7));
    clock.tick(HOLD_MS + 1);
    expect(stepper.label()).toBe("thinking · 7");
  });
});

// The captured stream is a box-only artifact (a real session's frames, not exported).
const FIXTURE = join(import.meta.dir, "..", "fixture", "real-stdout-frames.jsonl");
describe.skipIf(!existsSync(FIXTURE))("against the REAL binary's frames", () => {

  test("the captured stream produces the acts it actually performed", async () => {
    const rows = (await Bun.file(FIXTURE).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const clock = virtualClock();
    const seen: string[] = [];
    const stepper = new Stepper((l) => seen.push(l), HOLD_MS, clock);
    let understood = 0;
    for (const row of rows) {
      if (readSignal(row) !== null) understood += 1;
      if (row["type"] === "result") stepper.reset();
      else stepper.feed(row);
      clock.tick(HOLD_MS + 1); // one label per frame, so the mapping is what is under test
    }

    // A clean report needs a coverage witness: if the parser understood nothing, "no wrong labels"
    // would be trivially true. The capture is 34 frames, 20-odd of which say something.
    expect(understood).toBeGreaterThan(10);

    expect(seen).toContain("reading alpha.txt");
    expect(seen).toContain("reading beta.txt");
    expect(seen).toContain("running echo hi");
    expect(seen.some((l) => l.startsWith("thinking · "))).toBe(true);
    expect(seen).toContain("writing the reply");
    // Nothing raw leaks through: no API tool name, no absolute path, no JSON.
    for (const label of seen) {
      expect(label).not.toContain("/");
      expect(label).not.toContain("{");
      expect(label.length).toBeLessThanOrEqual(64);
    }
  });

  test("the turn's end clears the label", async () => {
    const rows = (await Bun.file(FIXTURE).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const clock = virtualClock();
    const stepper = new Stepper(() => {}, HOLD_MS, clock);
    for (const row of rows) {
      if (row["type"] === "result") stepper.reset();
      else stepper.feed(row);
      clock.tick(HOLD_MS + 1);
    }
    expect(stepper.label()).toBeNull();
  });
});
