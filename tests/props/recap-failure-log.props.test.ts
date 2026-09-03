/**
 * A failed recap is written down (requirement 209).
 *
 * 2026-08-14: a recap failed while he watched, he asked why, and there was no answer to give. The
 * reason had gone into one socket frame and one in-memory entry, and the entry is deleted the moment
 * a session claims it. The block is not a record — it is a screen. So every failure path now writes
 * one line to loom's log, and this is the pin that says so: the log dep is called with the record
 * and the reason, from a run driven end to end rather than from reading the code.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { failureLine, recapForNewSession, type RecapPhase } from "../../server/recap/service.ts";
import { storeDir } from "../../server/train.ts";

/** A session with enough said in it to be worth recapping (`worthRecapping`: two user turns). */
function writeSession(root: string, cwd: string, id: string): void {
  const dir = storeDir(root, cwd);
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: "user", uuid: "1", parentUuid: null, timestamp: "2026-08-14T10:00:00.000Z", cwd, sessionId: id,
      message: { role: "user", content: "make the block say how long it has been running" } },
    { type: "assistant", uuid: "2", parentUuid: "1", timestamp: "2026-08-14T10:01:00.000Z", cwd, sessionId: id,
      message: { role: "assistant", content: [{ type: "text", text: "done — it counts m:ss" }] } },
    { type: "user", uuid: "3", parentUuid: "2", timestamp: "2026-08-14T10:02:00.000Z", cwd, sessionId: id,
      message: { role: "user", content: "good. now land it" } },
    { type: "assistant", uuid: "4", parentUuid: "3", timestamp: "2026-08-14T10:03:00.000Z", cwd, sessionId: id,
      message: { role: "assistant", content: [{ type: "text", text: "landed" }] } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function runFailing(): Promise<{ lines: string[]; phases: RecapPhase[]; cwd: string }> {
  const root = mkdtempSync(join(tmpdir(), "recap-log-root-"));
  const cwd = mkdtempSync(join(tmpdir(), "recap-log-record-"));
  try {
    writeSession(root, cwd, "00000000-0000-4000-8000-00000000cafe");
    const lines: string[] = [];
    const phases: RecapPhase[] = [];
    await recapForNewSession(
      {
        // A binary that cannot exist: the child never starts, which is one of the failure paths that
        // used to report to the screen and nowhere else. No model is called, so this pin is free.
        bin: join(root, "no-such-claude"),
        transcriptRoot: root,
        stateDir: join(root, "state"),
        scratchDir: join(root, "scratch"),
        // The record's own store is both sources here: a fixture has no core above it, which is the
        // `ownDir === coreDir` short-circuit and the pre-cores behaviour (SPEC 217).
        store: { ownDir: storeDir(root, cwd), coreDir: storeDir(root, cwd), linked: new Set<string>() },
        now: () => "2026-08-14T18:00:00.000Z",
        report: (phase) => phases.push(phase),
        log: (line) => lines.push(line),
        appendEntry: async () => {},
      },
      cwd,
      "00000000-0000-4000-8000-00000000beef",
    );
    return { lines, phases, cwd };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("requirement 209 — the failure outlives the screen", () => {
  test("a recap that cannot run writes one line naming the record and the reason", async () => {
    const { lines, phases, cwd } = await runFailing();
    const failed = phases.filter((p) => p.phase === "failed");
    expect(failed.length).toBe(1);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(cwd);
    expect(lines[0]).toContain("recap failed");
    // The same reason the block shows — one story, not two.
    const reason = failed[0]?.phase === "failed" ? failed[0].reason : "";
    expect(reason.length).toBeGreaterThan(0);
    expect(lines[0]).toContain(reason.split("\n")[0]?.slice(0, 40) ?? "");
  });

  test("the line survives a reason of any shape, and stays one line", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 900 }), fc.string({ minLength: 1, maxLength: 60 }), (reason, dir) => {
        const line = failureLine(`/tmp/${dir}`, reason);
        // A reason with newlines in it (a stack, a stderr dump) must not become five log lines that
        // nothing can attribute to the recap.
        expect(line.split("\n").length).toBe(1);
        expect(line.startsWith("[loom] recap failed for /tmp/")).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});
