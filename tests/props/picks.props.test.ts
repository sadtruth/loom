import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { readAllPicks, readPick, writePick, type SessionPick } from "../../server/picks.ts";
import { attachPicks, type SessionInfo } from "../../server/sessions.ts";
import { MODEL_IDS } from "../../server/models.ts";

describe("picks memory", () => {
  const effortGen = fc.constantFrom("default", "low", "medium", "high", "xhigh", "max");
  const modeGen = fc.constantFrom("auto" as const, "cards" as const);
  const modelGen = fc.constantFrom(...MODEL_IDS);

  test("writing a pick then reading it back returns the same pick", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        modelGen,
        effortGen,
        modeGen,
        async (sessionId, model, effort, mode) => {
          const dir = await mkdtemp(join(tmpdir(), "loom-picks-"));
          try {
            await writePick(dir, sessionId, { model, effort, mode });
            const pick = await readPick(dir, sessionId);
            expect(pick).not.toBeNull();
            expect(pick?.model).toBe(model);
            expect(pick?.effort).toBe(effort);
            expect(pick?.mode).toBe(mode);
            expect(typeof pick?.at).toBe("number");
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
    );
  });

  test("reading a session that was never written returns null (including weird ids)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (sessionId: string) => {
        const dir = await mkdtemp(join(tmpdir(), "loom-picks-"));
        try {
          const pick = await readPick(dir, sessionId);
          expect(pick).toBeNull();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
    );
  });

  test("concurrent writes: writing pick A for session 1 and pick B for session 2 leaves both readable", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        async (s1, s2) => {
          fc.pre(s1 !== s2);
          const dir = await mkdtemp(join(tmpdir(), "loom-picks-race-"));
          try {
            await Promise.all([
              writePick(dir, s1, { model: "default", effort: "default", mode: "auto" }),
              writePick(dir, s2, { model: "opus", effort: "high", mode: "cards" }),
            ]);
            const all = await readAllPicks(dir);
            expect(all[s1]?.model).toBe("default");
            expect(all[s2]?.model).toBe("opus");
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe("attachPicks", () => {
  test("decorates sessions with their pick without overriding family", () => {
    const sessions = [
      { id: "s1", family: "claude" } as SessionInfo,
      { id: "s2", family: "google" } as SessionInfo,
      { id: "s3", family: "claude" } as SessionInfo,
    ];
    const picks: Record<string, SessionPick> = {
      "s1": { model: "opus", effort: "default", mode: "auto", at: 0 },
      "s2": { model: "g1:gemini-3.7-flash-high", effort: "high", mode: "cards", at: 0 },
    };

    const decorated = attachPicks(sessions, picks);

    expect(decorated[0]!.pick).toEqual(picks["s1"]!);
    expect(decorated[0]!.family).toBe("claude");

    expect(decorated[1]!.pick).toEqual(picks["s2"]!);
    expect(decorated[1]!.family).toBe("google");

    expect(decorated[2]!.pick).toBeUndefined();
    expect(decorated[2]!.family).toBe("claude");
  });

  test("decorates exactly as summarise initialized", () => {
    const sessions = [
      { id: "s1", pick: null, family: "claude" } as SessionInfo,
      { id: "s2", pick: null, family: "google" } as SessionInfo,
      { id: "s3", pick: null, family: "claude" } as SessionInfo,
    ];
    const picks: Record<string, SessionPick> = {
      "s1": { model: "opus", effort: "default", mode: "auto", at: 0 },
      "s2": { model: "default", effort: "high", mode: "cards", at: 0 },
    };

    const decorated = attachPicks(sessions, picks);

    expect(decorated[0]!.pick).toEqual(picks["s1"]!);
    expect(decorated[0]!.family).toBe("claude");

    expect(decorated[1]!.pick).toEqual(picks["s2"]!);
    expect(decorated[1]!.family).toBe("google");

    expect(decorated[2]!.pick).toBeNull();
    expect(decorated[2]!.family).toBe("claude");
  });
});
