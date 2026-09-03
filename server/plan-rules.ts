/**
 * What makes a plan unusable — the rules themselves, with no filesystem and no git in them.
 *
 * One implementation, two callers: the server, so the block can SHOW a problem before User types
 * `build start`, and `tools/build/plan_check.ts`, so the gate refuses the same thing for the same
 * reason. Two copies of these rules is the drift SPEC 152 was written against — and the gate
 * refusing something the block drew as an ordinary fact is exactly the failure the verifier found
 * ("does it tell him enough to REFUSE?" — no, 2026-08-10).
 */

import { asList, IMAGE_LINE, missingFields, planSize, type PlanDoc } from "../client/plan-parse.ts";

export interface PlanProblem {
  field: string;
  says: string;
}

/** Everything the caller had to go and find out before the rules can be applied. */
export interface PlanWorld {
  /** `true` the file is a project record — a record is never a plan, however its path is spelled. */
  isRecord: boolean;
  /** Does the branch or worktree the plan names exist? `null` when nobody could check. */
  treeExists: boolean | null;
  /** For each record the plan names: the ids of its `Next` items, or null when unreadable. */
  records: Map<string, Set<string> | null>;
  /** Records that resolve outside the repository the build happens in. */
  outside: string[];
  /**
   * Ids that are already `[x]`, keyed `<record>#<id>` — the record it belongs to travels WITH the
   * id. A flat set of bare ids refused the first plan that ever named two records: both had a
   * `next 1`, one of them long finished (2026-08-11).
   */
  done: Set<string>;
  /**
   * Has this build started? A task already ticked is a problem BEFORE `build start` — the plan
   * claims work that is finished — and the normal end state after it, because the build ticked it.
   * Without this the block reported its own finished tasks as faults.
   */
  started: boolean;
}

/** `worktree plan-block, off master` → the tree's name. */
export function treeName(git: string): string | null {
  return /\b(?:worktree|branch)\s+([\w./-]+)/i.exec(git)?.[1] ?? null;
}

/**
 * Every finding in `Found during the build` must BE a work object — a task on a record, or a record
 * of its own — so it carries a status and a link like anything else that has to get done.
 *
 * User, 2026-08-11: *"EACH of the items in 'Found during the build' should be either a task object
 * or a project object and therefore have a status and a link. You cant just write 'fixed in this
 * build'. And this should be a requirement and checked in code."* Prose about a defect is a defect
 * nobody is holding: the plan's own log filled with sentences that no list would ever show him
 * again (SPEC 158).
 */
export function findingProblems(doc: PlanDoc): PlanProblem[] {
  const section = doc.sections.find((s) => s.title.toLowerCase() === "found during the build");
  if (section === undefined) return [];
  const out: PlanProblem[] = [];
  for (const item of section.items) {
    const task = item.fields.find((f) => f.label === "task")?.value.trim() ?? "";
    if (task.length === 0) {
      out.push({ field: `finding "${item.title}"`, says: "has no `task:` — it is prose, not work" });
      continue;
    }
    // Either `<record>.md#next N` (a task object) or a `project.md` path (a project object).
    const isTask = /\.md#\s*next\s+\d+\s*$/i.test(task);
    const isProject = /(^|\/)(project|brief)\.md$/i.test(task);
    if (!isTask && !isProject) {
      out.push({
        field: `finding "${item.title}"`,
        says: `\`task: ${task}\` names neither a task (\`…project.md#next N\`) nor a record`,
      });
    }
  }
  return out;
}

/**
 * Requirement 159: every file, directory or object a plan names is a LINK. In the file that means
 * backticks — the block turns a backticked path into a chip and leaves bare text as text, so a bare
 * mention is a dead place-name on the map. User, 2026-08-11: *"All mentions to files, directories
 * or objects must be links with proper visual - make it a requirement"*.
 *
 * Deliberately narrow: only tokens that are unmistakably paths count, because a rule that fires on
 * ordinary prose is a rule that gets switched off.
 */
const PATHY = /(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.\w{1,5}|[\w-]+\.(?:ts|tsx|js|py|sh|css|html|json|md))(?=$|[\s,;:.)])/gu;

export function mentionProblems(doc: PlanDoc): PlanProblem[] {
  const out: PlanProblem[] = [];
  const seen = new Set<string>();
  const scan = (where: string, line: string): void => {
    // An image paragraph IS the link — demanding backticks around its path would refuse every plan
    // that uses place 3 of requirement 167, at `build start`, before a picture was ever drawn.
    if (IMAGE_LINE.test(line.trim())) return;
    const bare = line.replace(/`[^`]*`/g, ""); // what is already a link is not a finding
    for (const hit of bare.matchAll(PATHY)) {
      const name = (hit[1] ?? "").trim();
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push({ field: where, says: `\`${name}\` is named but not linked — put it in backticks` });
    }
  };
  for (const section of doc.sections) {
    for (const line of section.prose) scan(section.title, line);
    for (const item of section.items) {
      for (const line of item.prose) scan(item.title, line);
      for (const field of item.fields) scan(item.title, field.value);
    }
  }
  return out;
}

export function planProblems(doc: PlanDoc, world: PlanWorld): PlanProblem[] {
  if (world.isRecord) {
    return [{ field: "the file", says: "this is a project record (`type: project`), not a build plan" }];
  }

  const problems: PlanProblem[] = [];
  for (const field of missingFields(doc)) {
    problems.push({ field, says: `required at size ${planSize(doc)} and absent` });
  }

  const git = doc.front.get("git") ?? "";
  if (git.length > 0) {
    const tree = treeName(git);
    if (tree === null) problems.push({ field: "git", says: `"${git}" names neither a branch nor a worktree` });
    else if (world.treeExists === false) {
      problems.push({ field: "git", says: `"${tree}" does not exist in this repository yet` });
    }
  }

  for (const record of world.outside) {
    problems.push({ field: "records", says: `${record} is outside this repository` });
  }

  const records = asList(doc.front.get("records") ?? doc.front.get("record") ?? "");
  for (const record of records) {
    if (world.records.get(record) === null) {
      problems.push({ field: "records", says: `${record} could not be read as a project record` });
    }
  }

  for (const entry of asList(doc.front.get("work") ?? "")) {
    const [named, id] = entry.includes("#")
      ? [entry.slice(0, entry.indexOf("#")), entry.slice(entry.indexOf("#") + 1)]
      : [records[0] ?? "", entry];
    const items = world.records.get(named);
    if (items === undefined) {
      problems.push({ field: "work", says: `${entry} names a record this plan does not list` });
      continue;
    }
    if (items === null) continue; // already reported as unreadable
    const wanted = id.trim().toLowerCase();
    if (!items.has(wanted)) problems.push({ field: "work", says: `${entry} is not an item of ${named}` });
    else if (!world.started && world.done.has(`${named}#${wanted}`)) {
      problems.push({ field: "work", says: `${entry} is already done` });
    }
  }

  problems.push(...findingProblems(doc));
  problems.push(...mentionProblems(doc));

  return problems;
}
