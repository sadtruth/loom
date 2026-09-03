/**
 * PROPERTY PINS for the `permissions.ask` matcher (SPEC 219).
 *
 * This module decides whether a tool call gets a card, so both directions are expensive: a false
 * negative is the bug being fixed — a silent refusal he cannot answer — and a false positive is the
 * 2026-08-05 failure, a card per tool call, which made loom-driven sessions unusable.
 *
 * It is a parser over a syntax someone else owns, which is the case the build skill says gets
 * generated cases rather than a table of examples. The generated part hunts the shapes I would not
 * think to write; the named cases below carry the two real incidents.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  matchesAsk,
  matchesCommand,
  matchesPath,
  parseAskRules,
  type AskRule,
} from "../../server/askrules.ts";

const HOME = "/home/user";

/** His actual standing list on 2026-08-17 — the rules this has to get right. */
const REAL = [
  "Bash(git push:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(rm -rf:*)",
  "Edit(**/CLAUDE.md)",
  "Edit(.claude/commands/**)",
  "Edit(.claude/skills/**)",
  "Edit(.claude/agents/**)",
  "Edit(.claude/settings.json)",
  "Edit(.claude/settings.local.json)",
  "Edit(~/.claude/settings.json)",
  "Edit(.mcp.json)",
];

describe("the incident that named this project", () => {
  const rules = parseAskRules(REAL);

  test("`rm -rf:*` matches `rm -rf`, and does NOT match `rm -r`", () => {
    // 2026-08-16: six calls refused, and `rm -r` ran while `rm -rf` was refused on the same files.
    // The rule matched a spelling, not an operation. Both halves are pinned so neither can drift.
    expect(matchesCommand("rm -rf:*", "rm -rf /tmp/big")).toBe(true);
    expect(matchesCommand("rm -rf:*", "rm -r /tmp/big")).toBe(false);
  });

  test("a prefix ends on a boundary, never mid-word", () => {
    expect(matchesCommand("rm -rf:*", "rm -rfx /tmp")).toBe(false);
    expect(matchesCommand("git push:*", "git pushx origin")).toBe(false);
    expect(matchesCommand("git push:*", "git push")).toBe(true);
    expect(matchesCommand("git push:*", "git push --force origin main")).toBe(true);
  });

  test("a prefix is a PREFIX, not a substring", () => {
    // The other way to be wrong: a command that merely contains the pattern is not that command.
    expect(matchesCommand("rm -rf:*", "echo rm -rf")).toBe(false);
    expect(matchesCommand("git push:*", "cd x && git push")).toBe(false);
  });

  test("an ordinary command raises nothing", () => {
    for (const safe of ["ls -la", "git status", "bun test", "rm /tmp/one-file", "git pull"]) {
      expect(matchesAsk(rules, "Bash", { command: safe }, HOME)).toBe(false);
    }
  });

  test("the edits he listed raise a card, wherever the tree they are in", () => {
    for (const path of [
      `${HOME}/resilio/docs/Projects/Personal Claude/.claude/skills/build/SKILL.md`,
      `${HOME}/resilio/docs/Projects/Personal Claude/CLAUDE.md`,
      `${HOME}/resilio/docs/Projects/claude/.claude/agents/x.md`,
      `${HOME}/.claude/settings.json`,
      `${HOME}/projects/recs/.mcp.json`,
    ]) {
      expect(matchesAsk(rules, "Edit", { file_path: path }, HOME)).toBe(true);
    }
  });

  test("an ordinary vault file raises nothing — scenario 8", () => {
    for (const path of [
      `${HOME}/resilio/docs/Projects/Personal Claude/tools/loom/SPEC.md`,
      `${HOME}/resilio/docs/Stream/Daily/2026/2026-08-17.md`,
      `${HOME}/resilio/docs/Projects/Personal Claude/claude.md.backup`,
    ]) {
      expect(matchesAsk(rules, "Edit", { file_path: path }, HOME)).toBe(false);
    }
  });

  test("a rule about Edit says nothing about Bash, and vice versa", () => {
    expect(matchesAsk(rules, "Bash", { command: `cat ${HOME}/.claude/settings.json` }, HOME)).toBe(false);
    expect(matchesAsk(rules, "Read", { file_path: `${HOME}/.claude/settings.json` }, HOME)).toBe(false);
  });
});

describe("parsing never invents a rule", () => {
  test("both shapes, and nothing else", () => {
    expect(parseAskRules(["Bash(rm:*)"])).toEqual([{ tool: "Bash", spec: "rm:*" }]);
    expect(parseAskRules(["WebFetch"])).toEqual([{ tool: "WebFetch", spec: null }]);
  });

  test("malformed rules are dropped, not guessed at", () => {
    // A rule that cannot be understood must match NOTHING. The alternative — a lenient parse that
    // matches everything — is a card per tool call, which is the failure this build must not cause.
    for (const bad of ["", "   ", "Bash(", "Bash()", ")(", "(x)", "Bash(x", "1Tool(x)", "Bash x"]) {
      expect(parseAskRules([bad])).toEqual([]);
    }
  });

  test("PROPERTY: a parsed rule round-trips to the text it came from", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,12}$/),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/[()]/.test(s) && s.trim().length > 0),
        (tool, spec) => {
          expect(parseAskRules([`${tool}(${spec})`])).toEqual([{ tool, spec: spec.trim() }]);
        },
      ),
    );
  });

  test("PROPERTY: parsing is never a throw, on any input at all", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 8 }), (list) => {
        expect(() => parseAskRules(list)).not.toThrow();
      }),
    );
  });
});

describe("matching is total and conservative", () => {
  const rules: AskRule[] = parseAskRules(REAL);

  test("PROPERTY: an unknown tool never matches", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((t) => !REAL.some((r) => r.startsWith(t))),
        fc.string(),
        (tool, arg) => {
          expect(matchesAsk(rules, tool, { command: arg, file_path: arg }, HOME)).toBe(false);
        },
      ),
    );
  });

  test("PROPERTY: a malformed input answers no, never a throw", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.integer(), fc.array(fc.string())),
        (input) => {
          expect(matchesAsk(rules, "Bash", input, HOME)).toBe(false);
          expect(matchesAsk(rules, "Edit", input, HOME)).toBe(false);
        },
      ),
    );
  });

  test("PROPERTY: adding a rule can only ever ADD matches — never remove one", () => {
    // Metamorphic, and the one that would catch a matcher whose rules interfere. A longer list must
    // be a superset: `ask` is a disjunction, and anything else is a rule silently cancelling another.
    fc.assert(
      fc.property(
        fc.subarray(REAL, { minLength: 1 }),
        fc.constantFrom(...REAL),
        fc.constantFrom("rm -rf /x", "git push origin", "ls", "git reset --hard HEAD~1"),
        (some, extra, command) => {
          const before = matchesAsk(parseAskRules(some), "Bash", { command }, HOME);
          const after = matchesAsk(parseAskRules([...some, extra]), "Bash", { command }, HOME);
          if (before) expect(after).toBe(true);
        },
      ),
    );
  });

  test("a bare tool rule matches every use of it", () => {
    const bare = parseAskRules(["Bash"]);
    fc.assert(
      fc.property(fc.string(), (command) => {
        expect(matchesAsk(bare, "Bash", { command }, HOME)).toBe(true);
      }),
    );
  });
});

describe("path globs", () => {
  test("`**` crosses directories and `*` does not", () => {
    expect(matchesPath("/a/**/c.md", "/a/b/c.md", HOME)).toBe(true);
    expect(matchesPath("/a/**/c.md", "/a/b/x/c.md", HOME)).toBe(true);
    expect(matchesPath("/a/**/c.md", "/a/c.md", HOME)).toBe(true);
    expect(matchesPath("/a/*/c.md", "/a/b/x/c.md", HOME)).toBe(false);
    expect(matchesPath("/a/*/c.md", "/a/b/c.md", HOME)).toBe(true);
  });

  test("`~` is the home directory, and an absolute rule stays absolute", () => {
    expect(matchesPath("~/.claude/settings.json", `${HOME}/.claude/settings.json`, HOME)).toBe(true);
    expect(matchesPath("~/.claude/settings.json", "/elsewhere/.claude/settings.json", HOME)).toBe(false);
  });

  test("a relative rule matches anywhere in the tree", () => {
    expect(matchesPath(".mcp.json", "/any/where/.mcp.json", HOME)).toBe(true);
    expect(matchesPath(".mcp.json", "/any/where/not-.mcp.json", HOME)).toBe(false);
  });
});
