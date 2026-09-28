import { describe, expect, test } from "bun:test";
import { parseAnswerText } from "../../client/question-card.ts";

// The CLI never persists `answers` into the transcript's tool_use input, so
// the "You answered" summary is read back from the tool_result text. These
// strings are copied from real 2026-09-25 transcripts.
describe("parseAnswerText", () => {
  test("one answer", () => {
    const m = parseAnswerText('Your questions have been answered: "Which color do you prefer?"="Blue". You can now continue with these answers in mind.');
    expect([...m]).toEqual([["Which color do you prefer?", "Blue"]]);
  });
  test("two answers, multi-select joined with comma", () => {
    const m = parseAnswerText('Your questions have been answered: "What is your favorite drink?"="Coffee, Tea", "What is your favorite pet?"="Dog". You can now continue.');
    expect(m.get("What is your favorite drink?")).toBe("Coffee, Tea");
    expect(m.get("What is your favorite pet?")).toBe("Dog");
  });
  test("escaped quotes inside an answer", () => {
    const m = parseAnswerText('answered: "Title?"="The \\"Big\\" one".');
    expect(m.get("Title?")).toBe('The "Big" one');
  });
  test("unrecognised text gives no pairs, so the caller shows the raw text", () => {
    expect(parseAnswerText("The user skipped the question card").size).toBe(0);
  });
});
