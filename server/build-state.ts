/**
 * What state a build is in — derived, never typed (SPEC 148).
 *
 * The plan file says nothing about its own state. Two things outside it do: the gate's unlock file,
 * which names the plan it opened and when, and git, which knows whether the tree that build lives in
 * still exists and whether it landed. A state typed into the document would go on claiming "open"
 * long after the gate shut, and nobody could see the difference.
 *
 * The pure decision is `stateOf`, so every transition is testable without a repository.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parsePlan, asList } from "../client/plan-parse.ts";
import { planProblems, type PlanProblem, type PlanWorld } from "./plan-rules.ts";

export type BuildState = "awaiting" | "open" | "stopped" | "closed" | "dropped";

export interface GitFacts {
  /** The branch or worktree the plan names, `null` when it names neither. */
  tree: string | null;
  /** Does a ref for it still exist? */
  exists: boolean;
  /** Commits it carries that the base does not — the evidence that a build actually ran. */
  ahead: number;
  /** Is every commit of it already in the base branch? */
  merged: boolean;
  /** Files it changed against the base, when it has landed or is ahead. */
  changed: string[];
}

export interface UnlockFacts {
  /** The plan the gate unlocked, absolute. */
  plan: string | null;
  /** Seconds since the epoch. */
  ts: number;
}

export const UNLOCK_TTL = 12 * 60 * 60;

/**
 * The five states, from the two sources and nothing else.
 *
 * `dropped` is a branch that vanished without landing — the only way a build ends with neither a
 * merge nor work in flight. It is derived like the rest: a human deleting a branch IS the act.
 */
export function stateOf(plan: string, unlock: UnlockFacts, git: GitFacts, now: number): BuildState {
  const held = unlock.plan === plan && now - unlock.ts < UNLOCK_TTL;
  if (git.tree !== null && git.merged) return "closed";
  if (held) return "open";
  if (git.tree === null || !git.exists) {
    // Never built and no tree: still waiting for `build start`. A tree that existed and is gone
    // unmerged was abandoned.
    return git.tree !== null ? "dropped" : "awaiting";
  }
  // A tree exists, work may be in it, and the gate is shut: stopped, not awaiting. The difference
  // matters — `build start` on a stopped plan resumes the same build, id and all.
  //
  // COMMITS decide this, not the unlock file. The unlock lives in the main tree's `.claude/`, which
  // a worktree's own server cannot read — so on 4335 an 18-commit build reported "awaiting your go"
  // and then flagged its own finished tasks as faults (User, 2026-08-11). Work in the tree is
  // proof the build ran, and it is proof no matter which session holds the gate.
  return unlock.plan === plan || git.ahead > 0 ? "stopped" : "awaiting";
}

/** The nearest `.claude/.build-unlock.json` at or above a directory. */
export function readUnlock(from: string, stop: string): UnlockFacts {
  let here = resolve(from);
  const top = resolve(stop);
  for (;;) {
    try {
      const raw = JSON.parse(readFileSync(join(here, ".claude", ".build-unlock.json"), "utf8")) as {
        plan?: string;
        ts?: number;
      };
      if (typeof raw.plan === "string") return { plan: raw.plan, ts: raw.ts ?? 0 };
    } catch {
      // keep walking
    }
    if (here === top || here === dirname(here)) return { plan: null, ts: 0 };
    here = dirname(here);
  }
}

/** `worktree plan-block, off master` → the tree's name and the base it came off. */
export function readGitLine(line: string): { tree: string | null; base: string } {
  const named = /\b(?:worktree|branch)\s+([\w./-]+)/i.exec(line);
  const base = /\boff\s+([\w./-]+)/i.exec(line);
  return { tree: named?.[1] ?? null, base: base?.[1] ?? "master" };
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const done = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "pipe" });
  return { ok: done.exitCode === 0, out: new TextDecoder().decode(done.stdout).trim() };
}

/** What git knows about the tree a plan names. Every failure reads as "not there". */
export function gitFacts(repo: string, line: string): GitFacts {
  const { tree, base } = readGitLine(line);
  if (tree === null) return { tree: null, exists: false, ahead: 0, merged: false, changed: [] };

  // A session worktree's branch is `s/<slug>`; a plan may name either form.
  const ref = [tree, `s/${tree}`].find((name) => git(repo, ["rev-parse", "--verify", "--quiet", name]).ok);
  if (ref === undefined) {
    // Gone. It landed if the base contains a merge of it, which we cannot know once the ref is
    // deleted — so "gone" is dropped, and a landed build keeps its branch until it is tidied.
    return { tree, exists: false, ahead: 0, merged: false, changed: [] };
  }
  const up = git(repo, ["rev-list", "--count", `${base}..${ref}`]);
  const ahead = up.ok ? Number(up.out) : 0;
  // Landed means the base swallowed it, so the base must have moved PAST it. Ahead-zero alone is
  // also true of a branch created a minute ago and never committed to, which read as "closed".
  const down = git(repo, ["rev-list", "--count", `${ref}..${base}`]);
  const merged = ahead === 0 && up.ok && down.ok && Number(down.out) > 0;
  const changed = git(repo, ["diff", "--name-only", `${base}...${ref}`]);
  return {
    tree,
    exists: true,
    ahead,
    merged,
    changed: changed.ok && changed.out.length > 0 ? changed.out.split("\n") : [],
  };
}

/** A project RECORD is not a plan, however its path is spelled. */
function isRecord(text: string): boolean {
  if (!text.startsWith("---\n")) return false;
  const end = text.indexOf("\n---", 4);
  return end > 0 && /^type:\s*project\s*$/m.test(text.slice(4, end));
}

/** The `Next` ids of a record, and which of them are already done. */
function nextIds(text: string): { ids: Set<string>; done: Set<string> } {
  const ids = new Set<string>();
  const done = new Set<string>();
  const start = text.indexOf("\n## Next");
  if (start < 0) return { ids, done };
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const item = /^(\d+)\.\s+\[([ x/\->])\]/.exec(line);
    if (item?.[1] === undefined) continue;
    ids.add(`next ${item[1]}`);
    if (item[2] === "x") done.add(`next ${item[1]}`);
  }
  return { ids, done };
}

/** Read what the rules need, then apply them — the same rules the gate applies (SPEC 152). */
function problemsFor(text: string, repo: string, facts: GitFacts, started: boolean): PlanProblem[] {
  const doc = parsePlan(text);
  const world: PlanWorld = {
    isRecord: isRecord(text),
    treeExists: facts.tree === null ? null : facts.exists || facts.merged,
    records: new Map(),
    outside: [],
    done: new Set(),
    started,
  };
  for (const record of asList(doc.front.get("records") ?? doc.front.get("record") ?? "")) {
    const full = record.startsWith("/") ? record : resolve(repo, record);
    if (!resolve(full).startsWith(resolve(repo))) {
      world.outside.push(record);
      world.records.set(record, null);
      continue;
    }
    try {
      const body = readFileSync(full, "utf8");
      if (!isRecord(body)) {
        world.records.set(record, null);
        continue;
      }
      const { ids, done } = nextIds(body);
      world.records.set(record, ids);
      for (const id of done) world.done.add(`${record}#${id}`);
    } catch {
      world.records.set(record, null);
    }
  }
  return planProblems(doc, world);
}

export interface Sibling {
  id: string;
  title: string;
  path: string;
  state: BuildState;
}

/**
 * Earlier builds on the same records — collected, never typed (SPEC 157).
 *
 * A plan lives beside the record it serves, so the record's own directory IS the index: every
 * `*plan*.md` in it that names one of these records is part of this feature's history. Newest
 * first, by build id. The section used to render only what someone had written into the file by
 * hand, which is not a history, it is a claim.
 */
export function lineage(planPath: string, repo: string, records: readonly string[]): Sibling[] {
  const out: Sibling[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const dir = dirname(record.startsWith("/") ? record : resolve(repo, record));
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md") || !name.includes("plan")) continue;
      const full = join(dir, name);
      if (full === planPath || seen.has(full)) continue;
      let text = "";
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (isRecord(text)) continue;
      const doc = parsePlan(text);
      const named = asList(doc.front.get("records") ?? doc.front.get("record") ?? "");
      if (!named.some((r) => records.includes(r))) continue;
      seen.add(full);
      const facts = gitFacts(repo, doc.front.get("git") ?? "");
      out.push({
        id: doc.front.get("id") ?? name.replace(/\.md$/, ""),
        title: doc.title,
        path: full,
        state: stateOf(full, readUnlock(dir, repo), facts, Date.now() / 1000),
      });
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** Everything the block needs, for one plan path. */
export function buildState(planPath: string, repo: string, now = Date.now() / 1000) {
  let text = "";
  try {
    text = readFileSync(planPath, "utf8");
  } catch {
    return null;
  }
  const line = /^git:\s*(.*)$/m.exec(text.slice(0, text.indexOf("\n---", 4) + 1))?.[1] ?? "";
  const unlock = readUnlock(dirname(planPath), repo);
  const facts = existsSync(join(repo, ".git")) || existsSync(join(repo, ".git/"))
    ? gitFacts(repo, line)
    : { tree: readGitLine(line).tree, exists: false, ahead: 0, merged: false, changed: [] };
  const state = stateOf(planPath, unlock, facts, now);
  return {
    state,
    tree: facts.tree,
    changed: facts.changed,
    /** What the gate would refuse this plan for, so the block can say it BEFORE `build start`. */
    problems: problemsFor(text, repo, facts, state !== "awaiting"),
    /** Earlier builds on the same records, newest first — derived, never typed (SPEC 157). */
    lineage: lineage(
      planPath,
      repo,
      asList(parsePlan(text).front.get("records") ?? parsePlan(text).front.get("record") ?? ""),
    ),
    /** Seconds left on the unlock, when it is this plan's. */
    left: unlock.plan === planPath ? Math.max(0, Math.round(UNLOCK_TTL - (now - unlock.ts))) : 0,
  };
}
