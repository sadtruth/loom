/**
 * PROPERTY PINS for the command gist — the line that says what a Bash call did.
 *
 * The defect it exists to prevent, seen in a real session on 2026-08-01: eight consecutive Bash rows
 * all rendered as `cd "/home/user/resilio/docs/Projects/Personal Claude" && …`, truncated before
 * anything distinguishing. The rule is metamorphic — a relationship between two runs, which is why
 * it cannot be satisfied by accident: prefixing a command with a `cd` must not change its gist.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { commandGist, summariseRun } from "../../client/gist.ts";

/** Real commands, none of which start with `cd`, so the prefix under test is the only difference. */
const commandArb = fc.constantFrom(
  "grep -rn 'loom' client/",
  "bun run verify",
  "systemctl --user status loom.service",
  'python3 -c "print(1)"',
  "git status --short",
  "ls -la tools/loom",
  "sed -n 1,40p SPEC.md",
  "grep -c '^  - id:' tools/hub/services.yaml && echo done",
);

/** Directories with and without spaces, quoted the way a real command quotes them. */
const dirArb = fc.constantFrom(
  "/tmp",
  "/home/user/projects",
  '"/home/user/resilio/docs/Projects/Personal Claude"',
  "'/Users/user/docs/Projects/Personal Claude'",
  '"/home/user/resilio/docs/Projects/Personal Claude/tools/loom"',
);

describe("metamorphic: a cd prefix does not change the gist", () => {
  test("one cd", () => {
    fc.assert(
      fc.property(commandArb, dirArb, (command, dir) => {
        expect(commandGist(`cd ${dir} && ${command}`)).toBe(commandGist(command));
      }),
      { numRuns: 300 },
    );
  });

  test("chained cds", () => {
    fc.assert(
      fc.property(commandArb, dirArb, dirArb, (command, a, b) => {
        expect(commandGist(`cd ${a} && cd ${b} && ${command}`)).toBe(commandGist(command));
      }),
      { numRuns: 300 },
    );
  });
});

describe("the gist is always usable as a one-line label", () => {
  test("never empty for a non-blank command", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0), (command) => {
        expect(commandGist(command).length).toBeGreaterThan(0);
      }),
      { numRuns: 400 },
    );
  });

  test("never contains a newline", () => {
    fc.assert(
      fc.property(fc.string(), (command) => {
        expect(commandGist(command)).not.toContain("\n");
      }),
      { numRuns: 400 },
    );
  });

  test("a cd with nothing after it still labels itself", () => {
    expect(commandGist("cd /tmp")).toBe("cd /tmp");
    expect(commandGist('cd "/home/user/resilio/docs"')).toBe('cd "/home/user/resilio/docs"');
  });

  test("a heredoc shows its opening line, not its payload", () => {
    const command = `cd "/x/y" && cat >> DECISIONS.md <<'EOF'\n## a heading\nbody text\nEOF`;
    expect(commandGist(command)).toBe("cat >> DECISIONS.md <<'EOF'");
  });
});

describe("run summaries", () => {
  test("counts every call and names each verb once", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("Bash", "Read", "Edit", "Grep"), { minLength: 1, maxLength: 30 }), (names) => {
        const summary = summariseRun(names);
        expect(summary.startsWith(`${names.length} step`)).toBe(true);
        for (const verb of new Set(names.map((n) => n.toLowerCase()))) {
          expect(summary).toContain(verb);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("singular for one step", () => {
    expect(summariseRun(["Bash"])).toBe("1 step · bash");
    expect(summariseRun(["Bash", "Bash", "Read"])).toBe("3 steps · bash ×2 · read");
  });
});
