/**
 * What HE said, as distinct from what the app put in front of it (requirement 210).
 *
 * A queued message is drawn until the transcript shows it, and "shows it" is decided by comparing
 * the row's text with the queue entry's. The recap breaks that comparison from the inside: it rides
 * as a second text block INSIDE his first message (requirement 175), so the row's text is the
 * reminder plus his sentence, matches nothing, and the queued copy is drawn forever beside the real
 * one. He saw it on 2026-08-14: "here is what im seeing here after a recap - a doubling of my
 * message".
 *
 * The metamorphic property is the one that matters and the one that fails on the old rule: putting
 * a reminder in front of a message must not change what the message SAYS.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { spokenText, type Message } from "../../client/render.ts";

function said(...texts: string[]): Message {
  return {
    uuid: "u",
    parentUuid: null,
    role: "user",
    ts: "2026-08-14T17:50:00.000Z",
    blocks: texts.map((text) => ({ kind: "text" as const, text })),
    isSidechain: false,
    isMeta: false,
  };
}

const reminder = (body: string) => `<system-reminder>\n${body}\n</system-reminder>`;

describe("requirement 210 — a message says what he typed", () => {
  test("the recap in front of his first message is not part of it", () => {
    const message = said(reminder("Recap of the previous session\n\n## State\n\nx"), "fix the doubling");
    expect(spokenText(message)).toBe("fix the doubling");
  });

  test("adding a reminder does not change what the message says", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 120 }).filter((s) => s.trim().length > 0),
        fc.string({ maxLength: 400 }),
        (typed, body) => {
          // The same message, once alone and once behind a reminder. The app must read them the same.
          expect(spokenText(said(reminder(body), typed))).toBe(spokenText(said(typed)));
        },
      ),
      { numRuns: 200 },
    );
  });

  test("a message that is ONLY a reminder says nothing, rather than saying the reminder", () => {
    // Otherwise an injected block could retire a queued message he really did type.
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (body) => {
        expect(spokenText(said(reminder(body)))).toBe("");
      }),
      { numRuns: 100 },
    );
  });

  test("a sentence that merely mentions a reminder is still his", () => {
    // The rule is the block's own opening, not the substring: this project talks about reminders
    // constantly, and losing a message for quoting one is the same bug wearing the other costume.
    const message = said("why is the <system-reminder> block doubling my message?");
    expect(spokenText(message)).toBe("why is the <system-reminder> block doubling my message?");
  });

  test("several things he typed in one row stay joined, in order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.trimStart().startsWith("<")), {
          minLength: 1,
          maxLength: 4,
        }),
        (parts) => {
          expect(spokenText(said(...parts))).toBe(parts.join("").trim());
        },
      ),
      { numRuns: 120 },
    );
  });
});
