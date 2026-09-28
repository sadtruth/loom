/**
 * The permit broker's contract (SPEC 34–35): an answer resolves the held ask, the
 * timeout resolves "deny" (the fail-safe direction), and a settled or invented id is refused.
 * Plain cases, not properties — the state space is enumerable, and an invented property to feel
 * covered is worse than none.
 */

import { describe, expect, test } from "bun:test";
import { PermitBroker, readAnswers } from "../../server/permits.ts";

function makeBroker(timeoutMs: number): { broker: PermitBroker; changes: string[] } {
  const changes: string[] = [];
  const broker = new PermitBroker((sessionId) => changes.push(sessionId), timeoutMs);
  return { broker, changes };
}

describe("PermitBroker", () => {
  test("answer resolves the held ask with the given verdict", async () => {
    const { broker, changes } = makeBroker(60_000);
    const asked = broker.ask("s1", "Write", { file_path: "/tmp/x" });
    const pending = broker.forSession("s1");
    expect(pending).toHaveLength(1);
    const id = pending[0]?.id ?? "";
    expect(broker.answer(id, "allow")).toBe(true);
    expect(await asked).toEqual({ verdict: "allow" });
    expect(broker.forSession("s1")).toHaveLength(0);
    // One change when registered, one when settled — each drives a WS broadcast.
    expect(changes).toEqual(["s1", "s1"]);
  });

  test("timeout resolves deny — the fail-safe direction", async () => {
    const { broker } = makeBroker(20);
    const asked = broker.ask("s1", "Bash", { command: "rm -rf /" });
    expect(await asked).toEqual({ verdict: "deny" });
    expect(broker.forSession("s1")).toHaveLength(0);
  });

  test("answer carries answers alongside the verdict, for a question card's allow", async () => {
    const { broker } = makeBroker(60_000);
    const asked = broker.ask("s1", "AskUserQuestion", { questions: [] });
    const id = broker.forSession("s1")[0]?.id ?? "";
    expect(broker.answer(id, "allow", { "red or blue?": "blue" })).toBe(true);
    expect(await asked).toEqual({ verdict: "allow", answers: { "red or blue?": "blue" } });
  });

  test("a settled or invented id is refused", async () => {
    const { broker } = makeBroker(60_000);
    const asked = broker.ask("s1", "Write", null);
    const id = broker.forSession("s1")[0]?.id ?? "";
    expect(broker.answer("no-such-id", "allow")).toBe(false);
    expect(broker.answer(id, "deny")).toBe(true);
    expect(broker.answer(id, "allow")).toBe(false); // double answer cannot flip a verdict
    expect(await asked).toEqual({ verdict: "deny" });
  });

  test("permits are scoped to their session", () => {
    const { broker } = makeBroker(60_000);
    void broker.ask("s1", "Write", null);
    void broker.ask("s2", "Bash", null);
    expect(broker.forSession("s1")).toHaveLength(1);
    expect(broker.forSession("s2")).toHaveLength(1);
    expect(broker.forSession("s1")[0]?.toolName).toBe("Write");
  });
});

/**
 * `/api/permit/answer`'s `answers` validation (plan `ask-user-in-loom`, item 3): absent is fine (an
 * ordinary allow/deny), a flat string map is fine, anything else is the 400 the route sends back.
 */
describe("readAnswers", () => {
  test("absent answers is ok, with none carried", () => {
    expect(readAnswers(undefined)).toEqual({ ok: true });
  });

  test("a flat string map is ok and carried through", () => {
    expect(readAnswers({ "format?": "Obsidian Base", "shelves?": "Personal, Research" })).toEqual({
      ok: true,
      answers: { "format?": "Obsidian Base", "shelves?": "Personal, Research" },
    });
  });

  test("an empty object is ok — zero answers is still a flat map", () => {
    expect(readAnswers({})).toEqual({ ok: true, answers: {} });
  });

  test("a non-string value is rejected", () => {
    expect(readAnswers({ "format?": 1 })).toEqual({ ok: false });
  });

  test("an array is rejected — not a flat object", () => {
    expect(readAnswers(["blue"])).toEqual({ ok: false });
  });

  test("null and a bare string are rejected", () => {
    expect(readAnswers(null)).toEqual({ ok: false });
    expect(readAnswers("blue")).toEqual({ ok: false });
  });
});
