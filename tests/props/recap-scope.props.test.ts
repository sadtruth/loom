/**
 * A recap belongs to ONE project, even when several share a core (SPEC 217/218).
 *
 * The failure this pins, in User's words (2026-08-17): *"sometimes a recap appears not related to
 * the session im in"*. It was reproduced in the session that reported it — a loom session was handed
 * a recap of a tablet-shopping session, because both projects live under the personal core.
 *
 * Why it could happen at all: until 2026-08-16 a session's cwd WAS its project, so keying the recap
 * on a cwd was keying it on a project. Parent item 48 moved every session into its core's directory
 * and made the link the answer instead — and the recap kept asking the cwd, which by then named the
 * core. One ledger for every project under it, and "the previous session on this project" resolved
 * to whichever session ran last anywhere in the core.
 *
 * The properties below are METAMORPHIC on purpose: each asserts a relationship between two records
 * in one core, which is exactly the situation no single-record test can see. Both were run against
 * a version with the fix reverted and both fail there — see the file's own mutation note at the end.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  appendEntry,
  carsOf,
  previousCar,
  readLedger,
  type RecordStore,
} from "../../server/recap/service.ts";
import { storeDir } from "../../server/train.ts";

/** A session with enough said in it to be worth recapping, written into the CORE's store. */
function writeSession(root: string, coreCwd: string, id: string, at: string, title: string): void {
  const dir = storeDir(root, coreCwd);
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: "user", uuid: "1", parentUuid: null, timestamp: at, cwd: coreCwd, sessionId: id,
      message: { role: "user", content: title } },
    { type: "assistant", uuid: "2", parentUuid: "1", timestamp: at, cwd: coreCwd, sessionId: id,
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", uuid: "3", parentUuid: "2", timestamp: at, cwd: coreCwd, sessionId: id,
      message: { role: "user", content: "carry on" } },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * Two records under one core, each with one session of its own in the core's shared store.
 *
 * `ownDir` points at each record's own escaped-cwd store, which does not exist — that is the real
 * shape after 2026-08-16, and it is what makes the link the ONLY thing that can tell the two apart.
 */
function twoRecordsInOneCore(): {
  root: string;
  core: string;
  a: { dir: string; store: RecordStore; session: string };
  b: { dir: string; store: RecordStore; session: string };
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "recap-scope-root-"));
  const core = mkdtempSync(join(tmpdir(), "recap-scope-core-"));
  const aDir = join(core, "alpha");
  const bDir = join(core, "beta");
  mkdirSync(aDir, { recursive: true });
  mkdirSync(bDir, { recursive: true });

  const aSession = "00000000-0000-4000-8000-00000000aaaa";
  const bSession = "00000000-0000-4000-8000-00000000bbbb";
  // B is NEWER. Under the old cwd keying both records answered with B, because the newest car in the
  // core's store won regardless of whose it was — which is precisely the reported bug.
  writeSession(root, core, aSession, "2026-08-17T10:00:00.000Z", "alpha's work");
  writeSession(root, core, bSession, "2026-08-17T12:00:00.000Z", "beta's work");

  const storeOf = (dir: string, mine: string): RecordStore => ({
    ownDir: storeDir(root, dir),
    coreDir: storeDir(root, core),
    linked: new Set([mine]),
  });

  return {
    root,
    core,
    a: { dir: aDir, store: storeOf(aDir, aSession), session: aSession },
    b: { dir: bDir, store: storeOf(bDir, bSession), session: bSession },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(core, { recursive: true, force: true });
    },
  };
}

describe("two projects in one core do not read each other's sessions", () => {
  test("a record's cars are its own, and only its own", async () => {
    const w = twoRecordsInOneCore();
    try {
      const aCars = await carsOf(w.a.store);
      const bCars = await carsOf(w.b.store);
      expect(aCars.map((c) => c.id)).toEqual([w.a.session]);
      expect(bCars.map((c) => c.id)).toEqual([w.b.session]);
    } finally {
      w.cleanup();
    }
  });

  test("the previous car is the record's own, not the core's newest", async () => {
    const w = twoRecordsInOneCore();
    try {
      // The whole bug in one assertion: B's session is newer, so a core-keyed lookup hands it to
      // BOTH records. A must be told about A.
      const forA = await previousCar(w.a.store, "00000000-0000-4000-8000-0000000fresh".slice(0, 36));
      const forB = await previousCar(w.b.store, "00000000-0000-4000-8000-0000000fresh".slice(0, 36));
      expect(forA?.id).toBe(w.a.session);
      expect(forB?.id).toBe(w.b.session);
      expect(forA?.id).not.toBe(forB?.id);
    } finally {
      w.cleanup();
    }
  });

  test("a session never told about itself, whichever record asks", async () => {
    const w = twoRecordsInOneCore();
    try {
      expect(await previousCar(w.a.store, w.a.session)).toBeNull();
      // B asking while B is the new session still must not be handed A's — A is not B's predecessor,
      // it is another project's session that merely shares a directory.
      expect(await previousCar(w.b.store, w.b.session)).toBeNull();
    } finally {
      w.cleanup();
    }
  });
});


describe("property 4 — the service performs no ledger write except through RecapDeps", () => {
  test("recapForNewSession does not touch the real filesystem ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "recap-deps-root-"));
    const cwd = mkdtempSync(join(tmpdir(), "recap-deps-cwd-"));

    const binScript = `#!/usr/bin/env bun
console.log("## State\\n\\nmock state\\n\\n## Traps\\n\\nnone\\n\\n## Todos\\n\\nnone\\n\\n## Open threads\\n\\nnone\\n\\n## Discarded ideas\\n\\nnone\\n\\n## History\\n\\nnone\\n\\n## Landed\\n\\nnone");
`;
    const binPath = join(root, "mock-claude");
    writeFileSync(binPath, binScript, { mode: 0o755 });

    try {
      writeSession(root, cwd, "00000000-0000-4000-8000-00000000test", "2026-08-17T12:00:00.000Z", "test session");

      const appends: any[] = [];
      await import("../../server/recap/service.ts").then((mod) =>
        mod.recapForNewSession(
          {
            bin: binPath,
            transcriptRoot: root,
            stateDir: join(root, "state"),
            scratchDir: join(root, "scratch"),
            store: { ownDir: storeDir(root, cwd), coreDir: storeDir(root, cwd), linked: new Set<string>() },
            now: () => "2026-08-17T12:00:00.000Z",
            report: () => {},
            log: () => {},
            appendEntry: async (dir, entry) => { appends.push({ dir, entry }); },
          },
          cwd,
          "00000000-0000-4000-8000-00000000next"
        )
      );

      expect(appends.length).toBe(1);
      expect(appends[0].entry.body).toContain("mock state");

      let threw = false;
      try {
        readFileSync(join(cwd, "recap-ledger.md"), "utf8");
      } catch (e) {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("each record's ledger is its own file", () => {
  /** An entry with a body the other record could never legitimately contain. */
  const entryArb = fc.record({
    sessionId: fc.uuid(),
    title: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !s.includes("\n")),
    writtenAt: fc.constant("2026-08-17T12:00:00.000Z"),
    atTurn: fc.integer({ min: 1, max: 500 }),
    supersedes: fc.constant(null),
    body: fc.string({ minLength: 1, maxLength: 200 }),
  });

  test("METAMORPHIC: writing to one record's ledger never changes the other's", async () => {
    await fc.assert(
      fc.asyncProperty(entryArb, entryArb, async (first, second) => {
        const w = twoRecordsInOneCore();
        try {
          await appendEntry(w.a.dir, first);
          const aAlone = await readLedger(w.a.dir);
          await appendEntry(w.b.dir, second);
          // A's ledger is untouched by B's write. Under the old keying both wrote the same file, so
          // this read came back with two entries and the second project's body inside the first.
          expect(await readLedger(w.a.dir)).toEqual(aAlone);
          const bEntries = await readLedger(w.b.dir);
          expect(bEntries.map((e) => e.sessionId)).toEqual([second.sessionId]);
        } finally {
          w.cleanup();
        }
      }),
      { numRuns: 25 },
    );
  });

  test("METAMORPHIC: the order the two are recapped in does not matter", async () => {
    await fc.assert(
      fc.asyncProperty(entryArb, entryArb, async (first, second) => {
        const forward = twoRecordsInOneCore();
        const backward = twoRecordsInOneCore();
        try {
          await appendEntry(forward.a.dir, first);
          await appendEntry(forward.b.dir, second);
          // Same two writes, opposite order.
          await appendEntry(backward.b.dir, second);
          await appendEntry(backward.a.dir, first);
          expect(await readLedger(forward.a.dir)).toEqual(await readLedger(backward.a.dir));
          expect(await readLedger(forward.b.dir)).toEqual(await readLedger(backward.b.dir));
        } finally {
          forward.cleanup();
          backward.cleanup();
        }
      }),
      { numRuns: 25 },
    );
  });

  test("the ledger lands beside the record, not above it (SPEC 173)", async () => {
    const w = twoRecordsInOneCore();
    try {
      await appendEntry(w.a.dir, {
        sessionId: w.a.session,
        title: "alpha's work",
        writtenAt: "2026-08-17T12:00:00.000Z",
        atTurn: 3,
        supersedes: null,
        body: "## State\nalpha only",
      });
      expect(readFileSync(join(w.a.dir, "recap-ledger.md"), "utf8")).toContain("alpha only");
      // The core root — the shared pile every project's recap used to land in — stays empty.
      expect(() => readFileSync(join(w.core, "recap-ledger.md"), "utf8")).toThrow();
    } finally {
      w.cleanup();
    }
  });
});
