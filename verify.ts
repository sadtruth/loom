#!/usr/bin/env bun
/**
 * The verify runner. Runs the VERIFY.md contract and, only on green, stamps `.verify-ok`.
 *
 *     bun tools/loom/verify.ts
 *     bun tools/loom/verify.ts --fast
 *
 * ORDERING: the tree hash comes from `git ls-files -s`, i.e. the INDEX. Stage first, then run this,
 * then commit — staging after stamping moves the hash and the gate correctly calls the marker stale.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const HERE = dirname(Bun.fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const isFast = process.argv.includes("--fast");
// Ignore every stage stamp and run the whole contract. What runs before anything lands on master.
const isFullRun = process.argv.includes("--full");
// Anything on the command line that is not a flag names a journey spec to run — `bun run verify
// --fast journey21-gutter`. There is deliberately NO path-to-spec map here. A map is a second copy
// of what the specs already know, it goes stale silently, and the failure it produces is the worst
// kind: a fast run that passes because it skipped the spec that would have failed. The person
// making the change already knows what they touched, and with the suite parallel the whole set is
// cheap enough that "all of them" is the honest default.
const namedSpecs = process.argv.slice(2).filter((a) => !a.startsWith("-"));

function getChangedFiles(repoPath: string): string[] {
  const unstaged = spawnSync("git", ["-C", repoPath, "diff", "--name-only", "HEAD"], { encoding: "utf8" }).stdout ?? "";
  const staged = spawnSync("git", ["-C", repoPath, "diff", "--name-only", "--cached"], { encoding: "utf8" }).stdout ?? "";
  const untracked = spawnSync("git", ["-C", repoPath, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).stdout ?? "";

  const set = new Set<string>();
  for (const str of [unstaged, staged, untracked]) {
    for (const line of str.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return Array.from(set);
}

/** Byte-identical to verify_gate.tree_hash: same command, same digest, same slice. */
function treeHash(): string {
  const out =
    spawnSync("git", ["-C", REPO, "ls-files", "-s", "--", relative(REPO, HERE)], { encoding: "utf8" }).stdout ?? "";
  return createHash("sha256").update(out).digest("hex").slice(0, 16);
}

/** Get tree slug from .session marker */
const marker = (() => {
  try {
    return readFileSync(join(REPO, ".session"), "utf8");
  } catch {
    return "";
  }
})();
const treeSlug = /^slug=(.+)$/m.exec(marker)?.[1]?.trim() || "main";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const logDir = join(homedir(), ".cache", "loom-verify");
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `${treeSlug}-${timestamp}.log`);

function extractFailureLines(stageKey: string, output: string): string[] {
  const lines = output.split("\n");

  if (stageKey === "requirements") {
    const result: string[] = [];
    let collecting = false;
    for (const line of lines) {
      if (
        line.match(/^(duplicate-id|ambiguous-citation|dangling-citation|wrong-section|suffixed-id|phantom-claim|double-claimed|unowned-requirement)/) ||
        line.match(/\d+ finding\(s\)/)
      ) {
        collecting = true;
      }
      if (collecting && line.trim()) {
        result.push(line);
      }
    }
    return result.length > 0 ? result : lines.filter((l) => l.trim().length > 0);
  }

  if (stageKey === "typecheck") {
    return lines.filter((l) => l.trim().length > 0 && !l.startsWith("$ tsc"));
  }

  if (stageKey === "properties") {
    const result: string[] = [];
    for (const line of lines) {
      if (line.startsWith("[loom]") || line.startsWith("bun test v") || line.startsWith("✓")) {
        continue;
      }
      if (
        line.match(/^\s*\d+\s*\|/) ||
        line.includes("error:") ||
        line.includes("Expected") ||
        line.includes("Received") ||
        line.includes("Property failed") ||
        line.includes("Counterexample") ||
        line.includes("✗") ||
        line.includes("fail") ||
        line.includes("Seed:") ||
        line.includes("at <anonymous>") ||
        line.includes("at /") ||
        line.match(/tests\/props\/.*\.ts:$/) ||
        line.match(/^\s*\d+\s+(pass|fail)/) ||
        line.match(/Ran \d+ tests across/)
      ) {
        result.push(line);
      }
    }
    return result.length > 0 ? result : lines.filter((l) => !l.startsWith("[loom]") && !l.startsWith("bun test v") && l.trim().length > 0);
  }

  if (stageKey === "journeys") {
    const result: string[] = [];
    for (const line of lines) {
      if (
        line.startsWith("[WebServer]") ||
        line.startsWith("[pins]") ||
        line.startsWith("[fixture]") ||
        line.startsWith("✓") ||
        line.startsWith("  ✓") ||
        line.includes("…")
      ) {
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("Running ")) {
        result.push(line);
      }
    }
    return result.length > 0 ? result : lines.filter((l) => !l.startsWith("[WebServer]") && !l.startsWith("[pins]") && l.trim().length > 0);
  }

  return lines.filter((l) => l.trim().length > 0);
}

function printFailure(stageName: string, exitCode: number, stageKey: string, output: string): void {
  const failureLines = extractFailureLines(stageKey, output);
  const header = `=== ${stageName} FAILED (exit ${exitCode}) ===`;
  const footer = logPath;

  const MAX_LINES = 40;
  const maxContentLines = MAX_LINES - 2; // header and footer

  let outputLines: string[] = [];
  if (failureLines.length <= maxContentLines) {
    outputLines = [header, ...failureLines, footer];
  } else {
    const dropped = failureLines.length - (maxContentLines - 1);
    const kept = failureLines.slice(0, maxContentLines - 1);
    outputLines = [header, ...kept, `... (${dropped} lines dropped)`, footer];
  }

  console.log(outputLines.join("\n"));
  process.exit(exitCode !== 0 ? exitCode : 1);
}

interface StagePlan {
  key: string;
  name: string;
  cmd: string[];
  env?: Record<string, string>;
  skipReason?: string;
  customSummary?: string;
}

const changedFiles = getChangedFiles(REPO);
// A markdown-only diff cannot break a typecheck, a property or a browser journey. It can break the
// requirements artifact, which is what that stage reads. So that is the only stage it runs.
const isMdOnly = isFast && changedFiles.length > 0 && changedFiles.every((f) => f.endsWith(".md"));

appendFileSync(
  logPath,
  `=== verify ${isFast ? "fast" : "full"} mode ===\ntimestamp: ${timestamp}\nchanged files:\n${
    changedFiles.map((f) => `  ${f}`).join("\n") || "  (none)"
  }\nspecs: ${namedSpecs.length > 0 ? namedSpecs.join(" ") : "all"}\n\n`,
);

const stages: StagePlan[] = [
  {
    key: "requirements",
    name: "requirements",
    cmd: ["bun", "requirements-artifact/check.ts"],
  },
  {
    key: "typecheck",
    name: "typecheck",
    cmd: ["bun", "run", "typecheck"],
    skipReason: isMdOnly ? "skipped (.md only)" : undefined,
  },
  {
    key: "properties",
    name: "properties",
    cmd: ["bun", "test", "tests/props"],
    env: isFast ? { FC_RUNS: "100" } : undefined,
    skipReason: isMdOnly ? "skipped (.md only)" : undefined,
  },
  {
    key: "journeys",
    name: "journeys",
    cmd: [
      "./node_modules/.bin/playwright",
      "test",
      "-c",
      "tests/playwright.config.mjs",
      ...(isFast ? namedSpecs : []),
      // journey29 measures how many milliseconds a click takes to land. Eight workers on eight cores
      // is exactly the condition under which that number stops describing loom and starts describing
      // the machine: it read p95 988ms in the first parallel run, against a guard written from an
      // unloaded box. It gets its own pass below, alone.
      ...(isFast && namedSpecs.length > 0 ? [] : ["--grep-invert", "changes the centre exactly once"]),
    ],
    skipReason: isMdOnly ? "skipped (.md only)" : undefined,
  },
  {
    key: "latency",
    name: "latency",
    cmd: ["./node_modules/.bin/playwright", "test", "-c", "tests/playwright.config.mjs", "journey29-nav-speed"],
    env: { LOOM_PIN_WORKERS: "1" },
    skipReason: isMdOnly
      ? "skipped (.md only)"
      : isFast && namedSpecs.length > 0
        ? "skipped (named specs)"
        : undefined,
  },
];

// Worker counts and browser flags are requests; a cgroup is a ceiling. cgroup v2 is live on the box
// with cpu and memory delegated to the user slice, so the pins run inside a scope they cannot leave.
// CPUWeight is the half that answers the actual complaint — not that verify is slow, but that
// everything else stops while it runs: under contention this scope yields to every other process.
// MemoryHigh throttles and reclaims before MemoryMax kills, because a slow run is a nuisance and an
// OOM-killed one costs a whole re-run and reads as a test failure.
const CAP = [
  "systemd-run",
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "-p",
  "CPUQuota=500%",
  "-p",
  "CPUWeight=20",
  "-p",
  "MemoryHigh=8G",
  "-p",
  "MemoryMax=12G",
  "--",
];

// Absent on the Mac, and the scope fails where the controllers are not delegated. Degrade to the
// bare command rather than failing the gate, and say so once so a silent uncapped run is visible.
let capOk: boolean | null = null;
function capped(cmd: string[]): string[] {
  if (capOk === null) {
    capOk = spawnSync(CAP[0] ?? "", [...CAP.slice(1), "true"], { encoding: "utf8" }).status === 0;
    if (!capOk) console.log("[verify] no cgroup ceiling available - running uncapped");
  }
  return capOk ? [...CAP, ...cmd] : cmd;
}

// ── Stage stamps ────────────────────────────────────────────────────────────────────────────────
// User runs this gate five or six times in a session, and most of those runs follow a change that
// could not have broken most of what they re-prove — or follow no change at all. The gate already
// computed the answer and stamped it; it just never read the stamp back. A stage whose inputs have
// not moved since its last green does not run.
//
// NOT `treeHash()`, deliberately: that reads `git ls-files -s`, the INDEX, so an unstaged edit
// leaves it unmoved. A stage keyed on it would skip against a file it had never seen, which is the
// one failure that would make this whole mechanism worse than useless. These hashes read the bytes
// on disk.
//
// What counts as an input is decided by GIT, not by a list here: tracked files plus untracked ones
// git does not ignore. That is what keeps the generated fixture — rebuilt on every run, and
// gitignored — from moving the hash every time and defeating the cache, without a skip list that
// silently rots as the tree grows.
//
// The three expensive stages deliberately share ONE generous input set rather than getting narrow
// ones. Finer granularity is the same bet `namedSpecs` refuses above: it would buy seconds on the
// uncommon runs and risks a green that skipped the stage which would have failed. Coarse is the
// point — if anything in the app or the suite moves, all three run.
const APP_INPUTS = ["client", "server", "tests", "index.html", "package.json", "bunfig.toml", "tsconfig.json"];
const STAGE_INPUTS: Record<string, string[]> = {
  properties: APP_INPUTS,
  journeys: APP_INPUTS,
  latency: APP_INPUTS,
};
// requirements (0s) and typecheck (4s) are absent on purpose. They are the cheapest stages and the
// broadest safety net, so they always run: an unchanged re-run costs their ~4s rather than 0, and in
// exchange no stamp bug can ever hide a type error or a broken requirement id.

const statePath = resolve(HERE, ".verify-state.json");
let stageState: Record<string, { hash: string; durationSec: number }> = {};
try {
  stageState = JSON.parse(readFileSync(statePath, "utf8")) as typeof stageState;
} catch {
  /* no stamp yet is the normal first run */
}

function inputHash(paths: string[]): string {
  const listed =
    spawnSync("git", ["-C", HERE, "ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).stdout ?? "";
  const files = listed
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    try {
      h.update(readFileSync(join(HERE, rel)));
    } catch {
      // Tracked but gone from disk. It still has to move the hash, or deleting a file would read as
      // no change at all.
      h.update("<missing>");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function writeStageState(): void {
  writeFileSync(statePath, `${JSON.stringify(stageState, null, 2)}\n`);
}

const results: Array<{ name: string; summary: string; durationSec: number | null }> = [];

for (const stage of stages) {
  if (stage.skipReason) {
    results.push({ name: stage.name, summary: stage.skipReason, durationSec: null });
    continue;
  }

  // A named-spec run is someone asking for THAT spec; never answer it from a stamp.
  const inputs = STAGE_INPUTS[stage.key];
  const stampable = inputs !== undefined && !isFullRun && namedSpecs.length === 0;
  const hash = stampable ? inputHash(inputs) : "";
  if (stampable) {
    const seen = stageState[stage.key];
    if (seen !== undefined && seen.hash === hash) {
      results.push({ name: stage.name, summary: `cached (${seen.durationSec}s saved)`, durationSec: null });
      appendFileSync(logPath, `=== ${stage.name} (cached, inputs ${hash}) ===\n\n`);
      continue;
    }
  }

  const start = Date.now();
  // Only the browser stages get the ceiling. Typecheck and the properties are seconds and single-
  // process; boxing them buys nothing and adds a failure mode.
  const cmd = stage.cmd[0] === "./node_modules/.bin/playwright" ? capped(stage.cmd) : stage.cmd;
  // Tests assert the neutral defaults the public repository ships, and a developer's
  // environment must not be able to change the result.
  const baseEnv =
    stage.key === "properties"
      ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("LOOM_")))
      : process.env;
  const res = spawnSync(cmd[0] ?? "", cmd.slice(1), {
    cwd: HERE,
    env: { ...baseEnv, ...(stage.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const elapsedSec = Math.round((Date.now() - start) / 1000);

  const combinedOutput = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  appendFileSync(logPath, `=== ${stage.name} (exit ${res.status}) ===\n${combinedOutput}\n\n`);

  if (res.status !== 0) {
    // Drop the stamp BEFORE printing, because printFailure exits: a red stage that kept a stale
    // green stamp would be skipped by the next run and the failure would vanish.
    delete stageState[stage.key];
    writeStageState();
    printFailure(stage.name, res.status ?? 1, stage.key, combinedOutput);
  }

  if (stampable) {
    stageState[stage.key] = { hash, durationSec: elapsedSec };
    writeStageState();
  }

  // Parse summary for green table
  let summary = "ok";
  if (stage.key === "properties") {
    const match = /Ran (\d+) tests across/.exec(combinedOutput) || /(\d+)\s+pass/.exec(combinedOutput);
    summary = match ? `${match[1]} tests` : "?";
  } else if (stage.key === "journeys") {
    const match = /(\d+)\s+passed/.exec(combinedOutput);
    const count = match ? match[1] : "?";
    summary = namedSpecs.length > 0 ? `${count} cases (only ${namedSpecs.join(", ")})` : `${count} cases`;
  }

  results.push({ name: stage.name, summary, durationSec: elapsedSec });
}

// Print table on green
for (const r of results) {
  const col1 = r.name.padEnd(14);
  if (r.durationSec === null) {
    console.log(`${col1}${r.summary}`);
  } else {
    const col2 = r.summary.padEnd(28);
    const dur = `${r.durationSec}s`.padStart(4);
    console.log(`${col1}${col2}${dur}`);
  }
}

if (!isFast) {
  const hash = treeHash();
  writeFileSync(resolve(HERE, ".verify-ok"), `${hash}\n`);
  console.log(`VERIFY GREEN — stamped .verify-ok (${hash})`);
} else {
  console.log(`VERIFY GREEN (fast) — .verify-ok NOT written`);
}

