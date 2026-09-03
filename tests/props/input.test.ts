/**
 * The child-settings builder (SPEC 42): auto mode rides defaultMode through the injected settings
 * (the shape verified headless 2026-08-05 — the --permission-mode flag is NOT equivalent), cards
 * mode must NOT set a permission mode, and the permit hook is present in both.
 *
 * Plus the argv builder (SPEC 49): a picked model/thinking level reaches the child exactly once,
 * "default" adds no flag at all, and junk never becomes argv.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import {
  asEffort,
  asModel,
  childArgs,
  childMcpConfig,
  childSettings,
  EFFORTS,
  fingerprint,
  MODELS,
  type StartRequest,
} from "../../server/input.ts";

describe("childSettings", () => {
  test("auto sets defaultMode: auto and keeps the hook", () => {
    const parsed = JSON.parse(childSettings("auto"));
    expect(parsed.permissions).toEqual({ defaultMode: "auto" });
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("permit.ts");
  });

  test("cards sets NO permission mode and keeps the hook", () => {
    const parsed = JSON.parse(childSettings("cards"));
    expect(parsed.permissions).toBeUndefined();
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain("permit.ts");
  });

  // token-cost task 21/22. `.claude/settings.json` is discovered from the CWD and does not walk
  // up, and every loom session runs BELOW the repo root — so the project's ~30 guards, connguard
  // among them, never loaded for loom's whole life. Measured, not assumed: the same child spawned
  // at the repo root logged 12 hook invocations over 6 Bash calls, and 0 at a record directory.
  //
  // PINNED TWO-SIDED ON PURPOSE. A one-sided pin ("guards present at depth") passes on a build
  // that injects unconditionally — which would fire every guard TWICE at the root, where the CLI
  // discovers them already. Each test below fails on a different wrong implementation.
  const deep = join(import.meta.dir, "..", "..", "projects", "some-record");
  const root = join(import.meta.dir, "..", "..", "..", "..");

  const commandsOf = (raw: string): string[] =>
    (JSON.parse(raw).hooks.PreToolUse as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );

  // The guards come from the vault project's .claude/settings.json, which the public mirror
  // does not carry — the assertion is only meaningful on the box.
  test.skipIf(!existsSync(join(import.meta.dir, "..", "..", "..", "..", ".claude", "settings.json")))("a DEEP cwd gets the project's guards, with $CLAUDE_PROJECT_DIR resolved away", () => {
    const raw = childSettings("auto", deep);
    // That variable is exactly what fails at depth; a surviving literal means nothing was fixed.
    expect(raw).not.toContain("$CLAUDE_PROJECT_DIR");
    const commands = commandsOf(raw);
    expect(commands.some((c) => c.includes("connguard"))).toBe(true);
    // loom's own permit hook must survive the merge — without it every call raises a card.
    expect(commands.some((c) => c.includes("permit.ts"))).toBe(true);
  });

  test("the repo ROOT gets no injection, so guards cannot fire twice", () => {
    const commands = commandsOf(childSettings("auto", root));
    expect(commands.some((c) => c.includes("connguard"))).toBe(false);
    expect(commands.some((c) => c.includes("permit.ts"))).toBe(true);
  });
});

function req(over: Partial<StartRequest> = {}): StartRequest {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    resume: true,
    cwd: "/tmp",
    text: "hi",
    mode: "auto",
    model: "default",
    effort: "default",
    browser: false,
    images: [],
    ...over,
  };
}

describe("childArgs", () => {
  test("default adds neither flag — the CLI's own choice stands", () => {
    const args = childArgs("claude", req());
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });

  test("a pick lands as the flag's value", () => {
    const args = childArgs("claude", req({ model: "opus", effort: "xhigh" }));
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
    expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
  });

  test("the MCP set is always explicit — strict, plus a config loom composed itself", () => {
    // Both flags or neither. `--strict-mcp-config` on its own is the old shape (no servers at all);
    // `--mcp-config` on its own would let discovery add whatever the settings layers agreed on,
    // including the account-level Google Drive connector that flaps on its own schedule.
    const args = childArgs("claude", req());
    expect(args).toContain("--strict-mcp-config");
    const config = args[args.indexOf("--mcp-config") + 1] ?? "";
    expect(JSON.parse(config)).toHaveProperty("mcpServers");
  });

  test("the browser switch no longer reaches argv or the fingerprint", () => {
    // It stopped meaning anything on 2026-09-01: the browsers are always on and cost a socket. A
    // fingerprint that still watched it would retire a good child every time the toggle moved.
    expect(childArgs("claude", req({ browser: true }))).toEqual(childArgs("claude", req({ browser: false })));
    expect(fingerprint(req({ browser: true }))).toBe(fingerprint(req({ browser: false })));
  });

  test("only endpoints that answer are offered to a child", () => {
    // A server that is down at spawn and up later is the one shape that can still flap a live
    // child, so an unhealthy endpoint must be absent from the config rather than listed and broken.
    const servers = JSON.parse(childMcpConfig("/tmp")).mcpServers as Record<string, unknown>;
    for (const name of Object.keys(servers)) {
      if (name === "q") continue;
      expect(servers[name]).toHaveProperty("type", "http");
    }
  });

  test("the session flag still comes last, so a pick cannot displace it", () => {
    const resumed = childArgs("claude", req({ model: "haiku" }));
    expect(resumed.slice(-2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
    const fresh = childArgs("claude", req({ resume: false, effort: "max" }));
    expect(fresh.slice(-2)).toEqual(["--session-id", "11111111-2222-3333-4444-555555555555"]);
  });
});

describe("the picks are an allowlist", () => {
  test("junk degrades to default rather than reaching argv", () => {
    for (const junk of ["../../etc/passwd", "--dangerously-skip-permissions", "", "opus; rm -rf /"]) {
      expect(asModel(junk)).toBe("default");
      expect(asEffort(junk)).toBe("default");
    }
    expect(asModel(undefined)).toBe("default");
    expect(asEffort(null)).toBe("default");
    expect(asModel({ toString: () => "opus" })).toBe("default");
  });

  /**
   * The property that makes the allowlist load-bearing rather than decorative: for ARBITRARY
   * request bodies, every argv entry after `--model`/`--effort` is a listed value, and neither
   * flag can appear twice. A hand-written case only covers the junk I imagined.
   */
  test("property: no arbitrary string ever becomes a flag value", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (rawModel, rawEffort) => {
        const args = childArgs("claude", req({ model: asModel(rawModel), effort: asEffort(rawEffort) }));
        for (const [flag, allowed] of [
          ["--model", MODELS],
          ["--effort", EFFORTS],
        ] as const) {
          const at = args.indexOf(flag);
          expect(args.lastIndexOf(flag)).toBe(at);
          if (at >= 0) {
            const value = args[at + 1] ?? "";
            expect(allowed.includes(value as never)).toBe(true);
            expect(value).not.toBe("default");
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Metamorphic: a pick changes the argv by exactly the two entries it names and nothing else.
   * Stated as a relation between two runs, so it cannot be satisfied by a builder that quietly
   * drops or reorders the flags it already had.
   */
  test("property: picking only ever inserts its own two entries", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MODELS),
        fc.constantFrom(...EFFORTS),
        fc.boolean(),
        (model, effort, resume) => {
          const base = childArgs("claude", req({ resume }));
          const picked = childArgs("claude", req({ resume, model, effort }));
          const added = [
            ...(model === "default" ? [] : ["--model", model]),
            ...(effort === "default" ? [] : ["--effort", effort]),
          ];
          // The picks sit immediately before the session flag, and nothing else moves.
          expect(picked).toEqual([...base.slice(0, -2), ...added, ...base.slice(-2)]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
