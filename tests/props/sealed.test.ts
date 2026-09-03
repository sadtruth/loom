/**
 * The pin suite must not touch anything outside its own run (loom item 79).
 *
 * Every path the server resolves comes from a `LOOM_*` environment variable with a fallback, and
 * the fallbacks point at the real world: the vault, `~/.claude`, `~/.cache`. A variable the pin
 * config forgets to set does not fail — the server quietly reads User's own file instead, and the
 * suite's answer starts depending on what he did that morning.
 *
 * That is not hypothetical. Audited 2026-09-01: `LOOM_SEEN_DIR` was unset, so every pin run read
 * the watermark out of `tools/loom/seen/user-nixos.json` and wrote fixture session ids back into
 * it — four workers and his live loom appending to one file. `LOOM_ASK_SETTINGS` was unset too,
 * and every pin server read `~/.claude/settings.json` at boot, directly under a comment saying a
 * test that depends on the real settings file changes meaning when he edits it.
 *
 * Both are set now. This test is here so the NEXT one is caught the day it is written, by reading
 * the two files against each other rather than by anyone remembering.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SERVER = join(import.meta.dir, "..", "..", "server");
const CONFIG = join(import.meta.dir, "..", "playwright.config.mjs");

/** A fallback that reaches outside the run: built from the home directory, the vault, or a literal. */
const ESCAPES = /homedir\(\)|env\["HOME"\]|"\/home\/|\bVAULT\b/;

/** Every `LOOM_X` read whose fallback is one of those — `?? join(homedir(), …)` and friends. */
function unsealedReads(): { name: string; where: string; line: string }[] {
  const found: { name: string; where: string; line: string }[] = [];
  for (const entry of readdirSync(SERVER)) {
    if (!entry.endsWith(".ts")) continue;
    const lines = readFileSync(join(SERVER, entry), "utf8").split("\n");
    lines.forEach((line, i) => {
      const read = /env\["(LOOM_[A-Z_]+)"\]/.exec(line);
      const name = read?.[1];
      if (name === undefined) return;
      // The fallback often wraps onto the next line, so judge the pair rather than the line.
      const window = `${line}\n${lines[i + 1] ?? ""}`;
      if (!window.includes("??") || !ESCAPES.test(window)) return;
      found.push({ name, where: `server/${entry}:${i + 1}`, line: line.trim() });
    });
  }
  return found;
}

test("every server path variable whose fallback escapes the run is set by the pin config", () => {
  const config = readFileSync(CONFIG, "utf8");
  const leaking = unsealedReads().filter(({ name }) => !config.includes(`${name}:`) && !config.includes(`"${name}"`));

  // Named rather than counted: a count says something broke, the name says what to set.
  expect(
    leaking.map((l) => `${l.name} (${l.where}) — ${l.line}`),
    "these fall back to a real path outside the pin run, and the pin config never sets them",
  ).toEqual([]);
});

test("the reads this test exists to catch are still being found", () => {
  // Two-sided. The test above passes vacuously the moment the regex stops matching anything, which
  // is the failure mode of every check written as "the bad list is empty". So: the known cases are
  // asserted directly, and finding NO unsealed reads at all is itself a failure.
  const config = readFileSync(CONFIG, "utf8");
  expect(config).toContain("LOOM_SEEN_DIR:");
  expect(config).toContain("LOOM_ASK_SETTINGS:");
  expect(unsealedReads().map((r) => r.name)).toContain("LOOM_SEEN_DIR");
});
