/**
 * Property tests for multi-root session indexing and transcript path resolution (SPEC §Google Pro Models).
 *
 * 1. A session list built over both roots contains every file from each and no duplicates
 *    even if an id somehow appears in both.
 * 2. Resolving a session id to a transcript path returns the right root for each family.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachPicks,
  listSessions,
  listSessionsForProject,
  mergeSessionLists,
  transcriptPath,
  transcriptPathForFamily,
} from "../../server/sessions.ts";
import { assembleTrain, assembleTrainFor } from "../../server/train.ts";
import { mergeByLink } from "../../server/links.ts";

const ROW = (text: string, at: string): string =>
  `${JSON.stringify({ type: "user", timestamp: at, message: { content: text } })}\n`;

describe("Property 1: Session list built over both roots", () => {
  test("pure mergeSessionLists contains every file from each list and no duplicates", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            file: fc.string({ minLength: 5, maxLength: 50 }),
            bytes: fc.integer({ min: 1, max: 100000 }),
            mtime: fc.integer({ min: 1000, max: 2000000 }),
            startedAt: fc.integer({ min: 1000, max: 2000000 }),
            title: fc.constant(null),
            firstPrompt: fc.constant("hello"),
            gitBranch: fc.constant(null),
            pick: fc.constant(null),
            family: fc.constant("claude" as const),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        fc.array(
          fc.record({
            id: fc.uuid(),
            file: fc.string({ minLength: 5, maxLength: 50 }),
            bytes: fc.integer({ min: 1, max: 100000 }),
            mtime: fc.integer({ min: 1000, max: 2000000 }),
            startedAt: fc.integer({ min: 1000, max: 2000000 }),
            title: fc.constant(null),
            firstPrompt: fc.constant("hello google"),
            gitBranch: fc.constant(null),
            pick: fc.constant(null),
            family: fc.constant("google" as const),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (claudeSessions, agySessions) => {
          const merged = mergeSessionLists([claudeSessions, agySessions]);

          const allInputIds = new Set([...claudeSessions.map((s) => s.id), ...agySessions.map((s) => s.id)]);
          const outputIds = merged.map((s) => s.id);
          const outputIdSet = new Set(outputIds);

          // 1. Contains every file / id from both
          for (const id of allInputIds) {
            expect(outputIdSet.has(id)).toBe(true);
          }

          // 2. No duplicates
          expect(outputIds.length).toBe(outputIdSet.size);

          // 3. Sorted newest-first by mtime
          for (let i = 1; i < merged.length; i++) {
            expect(merged[i - 1]!.mtime).toBeGreaterThanOrEqual(merged[i]!.mtime);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("listSessionsForProject scans both roots, merges, and derives correct family from disk root", async () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), "loom-claude-root-"));
    const agyRoot = mkdtempSync(join(tmpdir(), "loom-agy-root-"));
    const projectKey = "-test-project";

    const claudeProjectDir = join(claudeRoot, projectKey);
    const agyProjectDir = join(agyRoot, projectKey);
    mkdirSync(claudeProjectDir, { recursive: true });
    mkdirSync(agyProjectDir, { recursive: true });

    const cId1 = "11111111-1111-1111-1111-111111111111";
    const cId2 = "22222222-2222-2222-2222-222222222222";
    const gId1 = "33333333-3333-3333-3333-333333333333";
    const dupId = "44444444-4444-4444-4444-444444444444";

    writeFileSync(join(claudeProjectDir, `${cId1}.jsonl`), ROW("claude session 1", "2026-08-20T10:00:00.000Z"));
    writeFileSync(join(claudeProjectDir, `${cId2}.jsonl`), ROW("claude session 2", "2026-08-21T10:00:00.000Z"));
    writeFileSync(join(agyProjectDir, `${gId1}.jsonl`), ROW("google session 1", "2026-08-22T10:00:00.000Z"));

    // Overlapping ID in both roots: agy is newer
    writeFileSync(join(claudeProjectDir, `${dupId}.jsonl`), ROW("dup in claude", "2026-08-19T10:00:00.000Z"));
    writeFileSync(join(agyProjectDir, `${dupId}.jsonl`), ROW("dup in agy", "2026-08-23T10:00:00.000Z"));

    try {
      const sessions = await listSessionsForProject(projectKey, claudeRoot, agyRoot);

      expect(sessions.length).toBe(4);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(cId1);
      expect(ids).toContain(cId2);
      expect(ids).toContain(gId1);
      expect(ids).toContain(dupId);

      // Unique ids only
      expect(new Set(ids).size).toBe(4);

      // Check family assignments
      const sC1 = sessions.find((s) => s.id === cId1);
      const sG1 = sessions.find((s) => s.id === gId1);
      const sDup = sessions.find((s) => s.id === dupId);

      expect(sC1?.family).toBe("claude");
      expect(sG1?.family).toBe("google");
      expect(sDup?.family).toBe("google"); // newer one from agy root was chosen
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(agyRoot, { recursive: true, force: true });
    }
  });
});

describe("Property 2: Resolving session ID to transcript path returns the right root for each family", () => {
  test("transcriptPathForFamily always returns path under requested family root", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,30}$/),
        fc.uuid(),
        fc.constantFrom("claude" as const, "google" as const),
        (projectKey, sessionId, family) => {
          const claudeRoot = "/tmp/mock-claude-root";
          const agyRoot = "/tmp/mock-agy-root";

          const path = transcriptPathForFamily(projectKey, sessionId, family, claudeRoot, agyRoot);
          expect(path).not.toBeNull();
          if (family === "claude") {
            expect(path!.startsWith(claudeRoot)).toBe(true);
          } else {
            expect(path!.startsWith(agyRoot)).toBe(true);
          }
          expect(path!.endsWith(`${projectKey}/${sessionId}.jsonl`)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("transcriptPath finds file in whichever root it exists on disk", async () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), "loom-claude-res-"));
    const agyRoot = mkdtempSync(join(tmpdir(), "loom-agy-res-"));
    const projectKey = "-res-project";

    const claudeProjectDir = join(claudeRoot, projectKey);
    const agyProjectDir = join(agyRoot, projectKey);
    mkdirSync(claudeProjectDir, { recursive: true });
    mkdirSync(agyProjectDir, { recursive: true });

    const cId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const gId = "gggggggg-gggg-gggg-gggg-gggggggggggg";

    writeFileSync(join(claudeProjectDir, `${cId}.jsonl`), ROW("claude", "2026-08-20T10:00:00.000Z"));
    writeFileSync(join(agyProjectDir, `${gId}.jsonl`), ROW("google", "2026-08-21T10:00:00.000Z"));

    try {
      const resolvedClaude = transcriptPath(projectKey, cId, claudeRoot, agyRoot);
      const resolvedGoogle = transcriptPath(projectKey, gId, claudeRoot, agyRoot);

      expect(resolvedClaude).toBe(join(claudeProjectDir, `${cId}.jsonl`));
      expect(resolvedGoogle).toBe(join(agyProjectDir, `${gId}.jsonl`));
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(agyRoot, { recursive: true, force: true });
    }
  });
});

describe("Property 3: The disk root decides the family across every reporting path", () => {
  test("a session whose transcript exists only under agy root is reported as google by EVERY path, and one only under claude root is reported as claude", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/),
        fc.uuid(),
        fc.uuid(),
        fc.constantFrom("default", "opus", "sonnet", "haiku", "g1:gemini-3.7-flash-high", "g2:gemini-3.7-flash-high", "gemini-3.7-flash-high", "unknown-model"),
        fc.constantFrom("default", "opus", "sonnet", "haiku", "g1:gemini-3.7-flash-high", "g2:gemini-3.7-flash-high", "gemini-3.7-flash-high", "unknown-model"),
        async (projectKey, claudeSessionId, agySessionId, claudePickModel, agyPickModel) => {
          fc.pre(claudeSessionId !== agySessionId);

          const claudeRoot = mkdtempSync(join(tmpdir(), "loom-claude-prop3-"));
          const agyRoot = mkdtempSync(join(tmpdir(), "loom-agy-prop3-"));

          const claudeProjectDir = join(claudeRoot, projectKey);
          const agyProjectDir = join(agyRoot, projectKey);
          mkdirSync(claudeProjectDir, { recursive: true });
          mkdirSync(agyProjectDir, { recursive: true });

          writeFileSync(join(claudeProjectDir, `${claudeSessionId}.jsonl`), ROW("claude only prompt", "2026-08-20T10:00:00.000Z"));
          writeFileSync(join(agyProjectDir, `${agySessionId}.jsonl`), ROW("agy only prompt", "2026-08-21T10:00:00.000Z"));

          const mockPicks: Record<string, { model: string; effort: string; mode: "auto" | "cards"; at: number }> = {
            [claudeSessionId]: { model: claudePickModel, effort: "high", mode: "auto", at: 1000 },
            [agySessionId]: { model: agyPickModel, effort: "high", mode: "auto", at: 1000 },
          };

          try {
            // Path 1: listSessions on directory
            const rawClaudeSessions = await listSessions(claudeProjectDir);
            const rawAgySessions = await listSessions(agyProjectDir, "google");
            const cRaw = rawClaudeSessions.find((s) => s.id === claudeSessionId);
            const gRaw = rawAgySessions.find((s) => s.id === agySessionId);
            expect(cRaw?.family).toBe("claude");
            expect(gRaw?.family).toBe("google");

            // Path 2: listSessionsForProject (merged multi-root scan)
            const projectSessions = await listSessionsForProject(projectKey, claudeRoot, agyRoot);
            const cProj = projectSessions.find((s) => s.id === claudeSessionId);
            const gProj = projectSessions.find((s) => s.id === agySessionId);
            expect(cProj?.family).toBe("claude");
            expect(gProj?.family).toBe("google");

            // Path 3: attachPicks decoration
            const decorated = attachPicks([...projectSessions], mockPicks);
            const cDec = decorated.find((s) => s.id === claudeSessionId);
            const gDec = decorated.find((s) => s.id === agySessionId);
            expect(cDec?.family).toBe("claude");
            expect(gDec?.family).toBe("google");

            // Path 4: assembleTrain
            const trainClaude = await assembleTrain(claudeProjectDir, "claude");
            const trainAgy = await assembleTrain(agyProjectDir, "google");
            const cTrain = trainClaude.find((s) => s.id === claudeSessionId);
            const gTrain = trainAgy.find((s) => s.id === agySessionId);
            expect(cTrain?.family).toBe("claude");
            expect(gTrain?.family).toBe("google");

            // Path 5: assembleTrainFor (multi-root train)
            const multiTrain = await assembleTrainFor(
              claudeProjectDir,
              claudeProjectDir,
              new Set(),
              agyProjectDir,
              agyProjectDir,
            );
            const cMultiTrain = multiTrain.find((s) => s.id === claudeSessionId);
            const gMultiTrain = multiTrain.find((s) => s.id === agySessionId);
            expect(cMultiTrain?.family).toBe("claude");
            expect(gMultiTrain?.family).toBe("google");

            // Path 6: record session list assembly (/api/records/sessions pipeline)
            const ownSessions = await listSessionsForProject(projectKey, claudeRoot, agyRoot);
            const coreSessions = await listSessionsForProject(projectKey, claudeRoot, agyRoot);
            const mergedByLinkList = mergeByLink(ownSessions, coreSessions, new Set());
            const finalRecordSessions = attachPicks(mergedByLinkList, mockPicks);
            const cRecord = finalRecordSessions.find((s) => s.id === claudeSessionId);
            const gRecord = finalRecordSessions.find((s) => s.id === agySessionId);
            expect(cRecord?.family).toBe("claude");
            expect(gRecord?.family).toBe("google");
          } finally {
            rmSync(claudeRoot, { recursive: true, force: true });
            rmSync(agyRoot, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

