/**
 * The five states and six transitions (SPEC 148), stated over the two things they are derived from.
 *
 * The verifier's finding, 2026-08-10: the requirement claimed five states and the code drew two,
 * from one source. These properties are what makes the claim checkable — they run against the pure
 * decision, so no repository and no gate are needed to state them.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  readGitLine,
  stateOf,
  UNLOCK_TTL,
  type GitFacts,
  type UnlockFacts,
} from "../../server/build-state.ts";

const PLAN = "/x/tools/loom/projects/p/a-plan-2026-08-10.md";
const NOW = 1_000_000;

const held: UnlockFacts = { plan: PLAN, ts: NOW - 60 };
const expired: UnlockFacts = { plan: PLAN, ts: NOW - UNLOCK_TTL - 1 };
const elsewhere: UnlockFacts = { plan: "/x/other-plan.md", ts: NOW - 60 };

const noTree: GitFacts = { tree: null, exists: false, ahead: 0, merged: false, changed: [] };
const inFlight: GitFacts = { tree: "plan-block", exists: true, ahead: 3, merged: false, changed: ["a.ts"] };
const landed: GitFacts = { tree: "plan-block", exists: true, ahead: 0, merged: true, changed: ["a.ts"] };
const gone: GitFacts = { tree: "plan-block", exists: false, ahead: 0, merged: false, changed: [] };
/** A tree taken but never committed to: ahead of nothing, behind nothing, NOT landed. */
const fresh: GitFacts = { tree: "plan-block", exists: true, ahead: 0, merged: false, changed: [] };

describe("each state, from the two sources", () => {
  test("awaiting — no tree yet and no unlock for this plan", () => {
    expect(stateOf(PLAN, elsewhere, noTree, NOW)).toBe("awaiting");
    expect(stateOf(PLAN, { plan: null, ts: 0 }, noTree, NOW)).toBe("awaiting");
  });

  test("open — the gate holds this plan, and the tree is still in flight", () => {
    expect(stateOf(PLAN, held, inFlight, NOW)).toBe("open");
    expect(stateOf(PLAN, held, noTree, NOW)).toBe("open");
  });

  test("stopped — work exists, the unlock is this plan's, and it has expired", () => {
    expect(stateOf(PLAN, expired, inFlight, NOW)).toBe("stopped");
  });

  // 2026-08-11: on the worktree's own server the unlock is unreadable — it lives in the MAIN tree's
  // `.claude/` — so an 18-commit build reported "awaiting your go" and then flagged its own finished
  // tasks as faults. Commits in the tree are proof the build ran, whoever holds the gate.
  test("stopped — commits in the tree, with no unlock this session can see", () => {
    expect(stateOf(PLAN, { plan: null, ts: 0 }, inFlight, NOW)).toBe("stopped");
    expect(stateOf(PLAN, elsewhere, inFlight, NOW)).toBe("stopped");
  });

  test("a tree taken and not yet committed to is not closed, and not stopped", () => {
    expect(stateOf(PLAN, { plan: null, ts: 0 }, fresh, NOW)).toBe("awaiting");
    expect(stateOf(PLAN, held, fresh, NOW)).toBe("open");
  });

  test("closed — every commit of the tree is in the base, whatever the gate says", () => {
    expect(stateOf(PLAN, held, landed, NOW)).toBe("closed");
    expect(stateOf(PLAN, expired, landed, NOW)).toBe("closed");
    expect(stateOf(PLAN, elsewhere, landed, NOW)).toBe("closed");
  });

  test("dropped — the tree the plan names is gone and never landed", () => {
    expect(stateOf(PLAN, expired, gone, NOW)).toBe("dropped");
    expect(stateOf(PLAN, elsewhere, gone, NOW)).toBe("dropped");
  });
});

describe("what may never happen", () => {
  const unlocks = fc.constantFrom(held, expired, elsewhere, { plan: null, ts: 0 });
  const facts = fc.constantFrom(noTree, inFlight, landed, gone, fresh);

  test("a state is never typed: the plan's own text cannot change the answer", () => {
    // stateOf sees no text at all — this is the property by construction, and the test says so.
    fc.assert(
      fc.property(unlocks, facts, (unlock, git) => {
        expect(["awaiting", "open", "stopped", "closed", "dropped"]).toContain(
          stateOf(PLAN, unlock, git, NOW),
        );
      }),
    );
  });

  test("a plan is NEVER open once the unlock has expired", () => {
    fc.assert(
      fc.property(facts, (git) => {
        if (git.merged) return; // closed wins, deliberately
        expect(stateOf(PLAN, expired, git, NOW)).not.toBe("open");
      }),
    );
  });

  test("an unlock that names another plan never opens this one", () => {
    fc.assert(
      fc.property(facts, (git) => {
        expect(stateOf(PLAN, elsewhere, git, NOW)).not.toBe("open");
      }),
    );
  });
});

describe("the git line", () => {
  test("names its tree and its base", () => {
    expect(readGitLine("worktree plan-block, off master")).toEqual({ tree: "plan-block", base: "master" });
    expect(readGitLine("branch fix-subs, off main")).toEqual({ tree: "fix-subs", base: "main" });
    expect(readGitLine("we will see")).toEqual({ tree: null, base: "master" });
  });
});
