/**
 * The recap agent (SPEC §Recap, requirements 171, 172, 177).
 *
 * The agent's own correctness is the model's, which no test here can assert. What IS testable is
 * everything around it: that the prompt carries the contract, that no failure path throws, and that
 * a dropped section is detected rather than assumed. Scenario 4 — the recap fails and the session
 * stays usable — is a claim about this file, so it is stated over generated failures.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { agentArgs, buildPrompt, missingSections, runRecap, SECTIONS, TIMEOUT_MS } from "../../server/recap/agent.ts";
import type { Brief } from "../../server/recap/filter.ts";
import { NO_WINDOW, type Window } from "../../server/recap/window.ts";
import { reminderFor } from "../../server/recap/service.ts";
import { hiddenReminder } from "../../client/render.ts";

const brief: Brief = {
  text: "## conversation\n\n[USER] make the thing smaller\n\n[CLAUDE] done",
  stats: { userTurns: 1, assistantTurns: 1, writes: 2, commands: 3, bytes: 60 },
};
const win: Window = { repo: "/repo", since: "a", until: "b", log: "abc123 2026-08-12 01:00 a commit\nfile.ts" };

describe("requirement 171 — the contract is in the prompt, not in hope", () => {
  test("every promised section is named", () => {
    const p = buildPrompt(brief, win, "a session");
    for (const s of SECTIONS) expect(p).toContain(`## ${s}`);
  });

  test("the brief and the window both reach the model", () => {
    const p = buildPrompt(brief, win, "a session");
    expect(p).toContain("make the thing smaller");
    expect(p).toContain("abc123");
  });

  test("a dropped section is detected", () => {
    const full = SECTIONS.map((s) => `## ${s}\n\nsomething`).join("\n\n");
    expect(missingSections(full)).toEqual([]);
    for (const drop of SECTIONS) {
      const partial = SECTIONS.filter((s) => s !== drop).map((s) => `## ${s}\n\nx`).join("\n\n");
      expect(missingSections(partial)).toEqual([drop]);
    }
  });
});

describe("requirement 172 — no window is stated, never implied", () => {
  test("a missing window says so in the prompt", () => {
    const p = buildPrompt(brief, null, "a session");
    expect(p).toContain(NO_WINDOW);
    expect(p).toContain("Claimed but unconfirmed");
  });

  test("an empty window is not the same as no window", () => {
    const p = buildPrompt(brief, { ...win, log: "" }, "a session");
    expect(p).toContain("The window is empty");
    expect(p).not.toContain(NO_WINDOW);
  });
});

describe("requirement 177 — the child is cheap, toolless, and not a session", () => {
  test("it runs the cheapest model with no MCP", () => {
    const args = agentArgs("/bin/claude");
    expect(args).toContain("--model");
    expect(args).toContain("haiku");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--print");
    // it is never resumed and never given a session id — it is not a session
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--session-id");
  });

  test("it is spawned in the scratch directory it was given, not the record's", async () => {
    let sawCwd = "";
    await runRecap({
      bin: "claude", scratchDir: "/var/loom/recap-scratch", brief, window: win, title: "t",
      spawn: async (_a, o) => { sawCwd = o.cwd; return { code: 0, stdout: "## State\nx", stderr: "" }; },
    });
    expect(sawCwd).toBe("/var/loom/recap-scratch");
  });
});

describe("scenario 4 — a failing recap leaves the session usable", () => {
  test("no failure path throws, whatever the child does", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -3, max: 9 }),
        fc.string({ maxLength: 50 }),
        fc.boolean(),
        async (code, out, blowUp) => {
          const res = await runRecap({
            bin: "claude", scratchDir: "/tmp", brief, window: win, title: "t",
            spawn: async () => {
              if (blowUp) throw new Error("spawn exploded");
              return { code, stdout: out, stderr: "why" };
            },
          });
          expect(typeof res.ok).toBe("boolean");
          expect(res.text.length).toBeGreaterThan(0);
          if (res.ok) {
            expect(code).toBe(0);
            expect(out.trim().length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  test("an empty answer is a failure, not an empty recap", async () => {
    const res = await runRecap({
      bin: "claude", scratchDir: "/tmp", brief, window: win, title: "t",
      spawn: async () => ({ code: 0, stdout: "   \n ", stderr: "" }),
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("empty");
  });
});

describe("requirement 209 — a recap that runs out of time says so", () => {
  test("the limit is a clock he can read, not a signal number", async () => {
    const res = await runRecap({
      bin: "claude", scratchDir: "/tmp", brief, window: win, title: "t",
      timeoutMs: 180_000,
      // What the kill actually produces: a nonzero exit and nothing on stderr, which used to reach
      // the block as "the recap failed (exit 143):" with nothing after the colon. He read that as
      // the clock anyway, and was wrong — so the message has to say which one it was.
      spawn: async () => ({ code: 143, stdout: "", stderr: "", timedOut: true }),
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("ran out of time");
    expect(res.text).toContain("3:00");
    expect(res.text).not.toContain("143");
  });

  test("whatever the limit is, it is named as m:ss", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 59 }), fc.integer({ min: 0, max: 59 }), async (m, s) => {
        const res = await runRecap({
          bin: "claude", scratchDir: "/tmp", brief, window: win, title: "t",
          timeoutMs: (m * 60 + s) * 1000,
          spawn: async () => ({ code: 143, stdout: "", stderr: "", timedOut: true }),
        });
        expect(res.text).toContain(`${m}:${String(s).padStart(2, "0")}`);
      }),
      { numRuns: 60 },
    );
  });

  test("a failure that is NOT the clock still reports what the child said", async () => {
    const res = await runRecap({
      bin: "claude", scratchDir: "/tmp", brief, window: win, title: "t",
      spawn: async () => ({ code: 1, stdout: "", stderr: "Credit balance is too low" }),
    });
    expect(res.ok).toBe(false);
    expect(res.text).toContain("exit 1");
    expect(res.text).toContain("Credit balance is too low");
    expect(res.text).not.toContain("ran out of time");
  });

  test("the limit itself leaves room for the biggest session in the project", () => {
    // Measured 2026-08-14 on `36d2862c`, 2.6 MB, the largest transcript here: 45 s end to end.
    // 90 s was not what failed that night — but 45 s of headroom is thin on a slow one.
    expect(TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });
});

describe("the real recap this code produced", () => {
  test("a real Haiku answer satisfies the section contract", () => {
    const real = readFileSync(join(import.meta.dir, "../fixtures/recap/recap-live.md"), "utf8");
    expect(missingSections(real)).toEqual([]);
  });

  test("it used depth 1, which is why depth is not part of the contract", () => {
    const real = readFileSync(join(import.meta.dir, "../fixtures/recap/recap-live.md"), "utf8");
    expect(real).toContain("# State");
    expect(real).not.toContain("## State");
  });
});

describe("requirement 175 — what the model is actually handed", () => {
  test("only the two carried sections travel, and the rest stays in the ledger", () => {
    const real = readFileSync(join(import.meta.dir, "../fixtures/recap/recap-live.md"), "utf8");
    const text = reminderFor({
      sessionId: "s", title: "the research run", writtenAt: "2026-08-12T18:00:00.000Z",
      atTurn: 42, supersedes: null, body: real,
    });
    expect(text).toContain("## State");
    expect(text).toContain("## Open threads");
    expect(text).not.toContain("## Traps");
    expect(text).not.toContain("## Landed");
  });

  test("it is a reminder end to end, which is what keeps it out of the next recap", () => {
    const text = reminderFor({
      sessionId: "s", title: "t", writtenAt: "2026-08-12T18:00:00.000Z",
      atTurn: 1, supersedes: null, body: "# State\n\nwhere things stand\n\n# Traps\n\nnone",
    });
    expect(text.trimStart().startsWith("<system-reminder>")).toBe(true);
    expect(text.trimEnd().endsWith("</system-reminder>")).toBe(true);
    expect(text).toContain("not an instruction");
  });
});

describe("requirement 175 — in the turn, off the screen", () => {
  test("a reminder is held back, his own words never are", () => {
    const recap = reminderFor({
      sessionId: "s", title: "t", writtenAt: "2026-08-12T18:00:00.000Z",
      atTurn: 1, supersedes: null, body: "# State\n\nwhere you left off",
    });
    expect(hiddenReminder(recap, false)).toBe(true);
    expect(hiddenReminder("right, lets build the centre column", false)).toBe(false);
  });

  test("hidden is not gone — the meta toggle still reaches it", () => {
    const recap = reminderFor({
      sessionId: "s", title: "t", writtenAt: "2026-08-12T18:00:00.000Z",
      atTurn: 1, supersedes: null, body: "# State\n\nwhere you left off",
    });
    expect(hiddenReminder(recap, true)).toBe(false);
  });

  test("what the filter drops and what the screen drops are the same rule", () => {
    // If these ever diverge, a recap is either visible to him or quoted into the next recap.
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        const asBlock = `<system-reminder>\n${text}\n</system-reminder>`;
        expect(hiddenReminder(asBlock, false)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});

describe("the last section is a section too", () => {
  test("a recap whose final section is the carried one still carries it", () => {
    // `$` under /m ends at the first line break, and `\Z` is not a JS escape — both bugs made the
    // block render empty while every other test passed, because every other body had a heading after.
    const text = reminderFor({
      sessionId: "s", title: "t", writtenAt: "2026-08-12T18:00:00.000Z", atTurn: 1, supersedes: null,
      body: "# State\n\nthe centre column is settled\n\n# Open threads\n\n1. build it",
    });
    expect(text).toContain("the centre column is settled");
    expect(text).toContain("1. build it");
  });
});
