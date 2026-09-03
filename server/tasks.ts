/**
 * The two regions of a project record loom may WRITE: `## Next` and `## Hypotheses`.
 *
 * SPEC §Tasks. The `project` skill owns the record format; this module owns those two sections and
 * nothing else. Everything outside them is read and handed back untouched, which is the property
 * `tests/props/tasks.props.test.ts` hunts counterexamples for — a write that can wander outside its
 * own lines would put the vault at the mercy of a regex.
 *
 * The whole file is kept as lines and an edit splices one item's span back in. A markdown
 * round-trip (parse to AST, re-render) would reformat the 95% of the record nobody asked it to
 * touch; splicing lines cannot.
 *
 * Neither grammar is invented here. Task boxes are Obsidian's; hypothesis standings are the set
 * `tools/project-guard/lint.py` already enforces, so the linter is the test for what loom writes.
 */

import { invalidateRecords } from "./records.ts";
import { mkdir, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export type TaskStatus = "open" | "doing" | "done" | "dropped" | "promoted";

/** Obsidian's own box vocabulary — borrowed, not minted. */
const FROM_BOX: Record<string, TaskStatus> = {
  " ": "open",
  "/": "doing",
  x: "done",
  X: "done",
  "-": "dropped",
  ">": "promoted",
};

const TO_BOX: Record<TaskStatus, string> = {
  open: " ",
  doing: "/",
  done: "x",
  dropped: "-",
  promoted: ">",
};

export const STATUSES: readonly TaskStatus[] = ["open", "doing", "done", "dropped", "promoted"];

/** Inline field labels a task may carry, on its first line or on a continuation line. */
const KEYS = ["need", "hypo", "result", "artifacts", "subproject"] as const;
type Key = (typeof KEYS)[number];

const HEADING = /^#{1,6}\s/;
const NEXT_HEADING = /^#{2,3}\s+Next\s*$/i;
const HYPO_HEADING = /^#{2,3}\s+Hypotheses\s*$/i;
const ITEM = /^(\d+\.|[-*+])[ \t]+(.*)$/;
const BOXED = /^\[(.)\](?:[ \t]+([\s\S]*))?$/;

/** The standings `tools/project-guard/lint.py` accepts — borrowed from the linter, not minted. */
export const STANDINGS = [
  "open",
  "supported",
  "half-supported",
  "confirmed",
  "refuted",
  "disproven",
] as const;
export type Standing = (typeof STANDINGS)[number];

/**
 * `*Refuted 2026-08-06*:` — the italic marker records already use, with an optional date.
 *
 * Matched only AFTER the claim's closing `**`, so a claim that happens to begin with a standing
 * word is not read as its own standing.
 */
const STANDING_MARK = new RegExp(
  `\\*(${STANDINGS.join("|")})(?:[ \\t]*[—–-]?[ \\t]*(\\d{4}-\\d{2}-\\d{2}))?\\*[ \\t]*:?[ \\t]*`,
  "i",
);
const BOLD_LEAD = /^\*\*([\s\S]+?)\*\*[ \t]*/;

export interface Task {
  /** 1-based position among the items in `Next` — the id a write addresses. */
  n: number;
  /** null means "a prose item, not a task": no status box, so loom leaves it alone. */
  status: TaskStatus | null;
  title: string;
  need: string | null;
  hypo: string | null;
  result: string | null;
  artifacts: string[];
  /** Record-relative path of the subproject this task graduated into. */
  subproject: string | null;
  /** Line span in the FULL file text, [from, to) — the only region an edit may rewrite. */
  from: number;
  to: number;
  /** The item's first line verbatim — the client echoes it back so a stale tick cannot land. */
  head: string;
}

/** A numbered claim under `## Hypotheses`, in the shape `**claim** *Standing date*: evidence`. */
export interface Hypothesis {
  /** 1-based position among the items in `Hypotheses` — the id a write addresses. */
  n: number;
  claim: string;
  /** null means the claim carries no standing word — legal to render, and what the linter flags. */
  standing: Standing | null;
  /** The ISO date inside the standing marker, when it has one. */
  since: string | null;
  evidence: string;
  /** Line span in the FULL file text, [from, to) — the only region an edit may rewrite. */
  from: number;
  to: number;
  /** The item's first line verbatim — the client echoes it back so a stale write cannot land. */
  head: string;
}

/**
 * A record split into the parts loom renders: prose, the two operable sections, prose.
 *
 * The pieces concatenate back to the body in file order — `head · hypotheses · middle · tasks ·
 * tail` — so the client can draw rows where the sections were without reordering the record.
 */
export interface RecordDoc {
  /** Body markdown before the hypotheses, frontmatter stripped, `## Hypotheses` heading included. */
  head: string;
  hypotheses: Hypothesis[];
  /** Body markdown between the two sections, `## Next` heading included. */
  middle: string;
  tasks: Task[];
  /** Body markdown after the `Next` section. */
  tail: string;
}

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === "---") return i + 1;
  return 0;
}

/** [first line after the heading, first line after the section) — [-1,-1] when absent. */
function section(lines: readonly string[], heading: RegExp): [number, number] {
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (heading.test(lines[i] ?? "")) {
      at = i;
      break;
    }
  }
  if (at < 0) return [-1, -1];
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (HEADING.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return [at + 1, end];
}

/**
 * The spans of the list items inside a section, [start, end) each, trailing blanks trimmed.
 *
 * An item runs until the next item's marker or the section's end, so a continuation line belongs to
 * the item above it whatever its indent — the same rule a reader applies.
 */
function itemSpans(lines: readonly string[], from: number, to: number): Array<[number, number]> {
  const starts: number[] = [];
  for (let i = from; i < to; i += 1) if (ITEM.test(lines[i] ?? "")) starts.push(i);
  return starts.map((start, index) => {
    let end = starts[index + 1] ?? to;
    while (end > start + 1 && (lines[end - 1] ?? "").trim().length === 0) end -= 1;
    return [start, end] as [number, number];
  });
}

/** The item's own text: the first line past its marker and box, plus its continuation lines. */
function itemBody(item: readonly string[]): string {
  const first = ITEM.exec(item[0] ?? "");
  const afterMarker = first?.[2] ?? item[0] ?? "";
  const boxed = BOXED.exec(afterMarker);
  const lead = boxed !== null ? (boxed[2] ?? "") : afterMarker;
  return [lead, ...item.slice(1).map((line) => line.replace(/^[ \t]+/, ""))].join("\n");
}

function keyClauses(body: string): Map<Key, string> {
  const finder = new RegExp(`\\b(${KEYS.join("|")}):[ \\t]*`, "g");
  const hits: Array<{ key: Key; start: number; end: number }> = [];
  let match = finder.exec(body);
  while (match !== null) {
    hits.push({ key: match[1] as Key, start: match.index, end: match.index + match[0].length });
    match = finder.exec(body);
  }
  const out = new Map<Key, string>();
  hits.forEach((hit, i) => {
    const next = hits[i + 1];
    const stop = next?.start ?? body.length;
    // A clause that runs into the NEXT label swallowed the dash that introduced it; a clause that
    // runs to the end did not, so a value which simply ends in a dash keeps it.
    let raw = body.slice(hit.end, stop);
    if (next !== undefined) {
      raw = raw.replace(/[ \t]*[—–-][ \t]*$/, "");
    }
    const value = raw.trim();
    if (value.length > 0 && !out.has(hit.key)) out.set(hit.key, value);
  });
  return out;
}

const LABEL = new RegExp(`(?:\\s+[—–-])?\\s*\\b(?:${KEYS.join("|")}):`);
const NESTED = /^[ \t]*(?:\d+\.|[-*+])[ \t]/;

/**
 * How many of an item's lines its NAME occupies.
 *
 * A name written by hand is wrapped to the margin like every other sentence in the record, so it is
 * several lines and reading only the first one cuts it mid-word — which is exactly what User saw
 * on 2026-08-07: *"the tasks have their ends cut, they don't read like finished sentences."* The
 * name runs on until the item's prose breaks: a blank line, a nested bullet, or a line carrying a
 * field label (the item's earned history, which is never part of its name).
 */
function leadCount(item: readonly string[]): number {
  if (LABEL.test(ITEM.exec(item[0] ?? "")?.[2] ?? item[0] ?? "")) return 1;
  let n = 1;
  while (n < item.length) {
    const line = item[n] ?? "";
    if (line.trim().length === 0 || LABEL.test(line) || NESTED.test(line)) break;
    n += 1;
  }
  return n;
}

/** The lead phrase: everything before the first field label, unbolded, on one line. */
function titleOf(body: string): string {
  const cut = LABEL.exec(body);
  const lead = cut === null ? body : body.slice(0, cut.index);
  return oneLine(lead).replace(/\*\*/g, "").trim();
}

function splitArtifacts(clause: string): string[] {
  return clause
    .split(/\s*·\s*|\s*,\s*|\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseTask(item: readonly string[], n: number, from: number, to: number): Task {
  const first = ITEM.exec(item[0] ?? "");
  const boxed = BOXED.exec(first?.[2] ?? "");
  const boxChar = boxed?.[1] ?? null;
  const body = itemBody(item);
  const clauses = keyClauses(body);
  return {
    n,
    status: boxChar !== null ? (FROM_BOX[boxChar] ?? null) : null,
    title: titleOf(itemBody(item.slice(0, leadCount(item)))),
    need: clauses.get("need") ?? null,
    hypo: clauses.get("hypo") ?? null,
    result: clauses.get("result") ?? null,
    artifacts: splitArtifacts(clauses.get("artifacts") ?? ""),
    subproject: clauses.get("subproject") ?? null,
    from,
    to,
    head: item[0] ?? "",
  };
}

function parseHypothesis(item: readonly string[], n: number, from: number, to: number): Hypothesis {
  const body = itemBody(item);
  const bold = BOLD_LEAD.exec(body);
  // The standing is looked for only past the claim's closing `**`; a claim that opens with the word
  // "Open" is a claim, not a standing.
  const rest = bold === null ? body : body.slice(bold[0].length);
  const mark = STANDING_MARK.exec(rest);
  const claimText = bold !== null ? (bold[1] ?? "") : mark !== null ? rest.slice(0, mark.index) : rest;
  const evidence = mark === null ? (bold === null ? "" : rest) : rest.slice(mark.index + mark[0].length);
  return {
    n,
    claim: oneLine(claimText).replace(/\*\*/g, "").replace(/\s*[—–-]\s*$/, ""),
    standing: mark === null ? null : (mark[1]?.toLowerCase() as Standing),
    since: mark?.[2] ?? null,
    evidence: oneLine(evidence),
    from,
    to,
    head: item[0] ?? "",
  };
}

/**
 * Parse a record's full text. Total by construction — anything that does not look like a task comes
 * back as a prose item, a claim with no standing is still a claim, and a record missing either
 * section is not an error.
 */
export function parseRecord(text: string): RecordDoc {
  const lines = text.split("\n");
  const bodyStart = frontmatterEnd(lines);
  const [nextFrom, nextTo] = section(lines, NEXT_HEADING);
  let [hypoFrom, hypoTo] = section(lines, HYPO_HEADING);
  // A `## Hypotheses` sitting after `## Next` is out of the skill's section order; rather than
  // reorder the reader's record, leave it in the prose and operate only the tasks.
  if (hypoFrom >= 0 && nextFrom >= 0 && hypoFrom > nextFrom) [hypoFrom, hypoTo] = [-1, -1];

  const at = (n: number, fallback: number): number => (n < 0 ? fallback : n);
  const headEnd = at(hypoFrom, at(nextFrom, lines.length));
  const middleFrom = hypoFrom < 0 ? headEnd : hypoTo;
  const middleTo = at(nextFrom, hypoFrom < 0 ? headEnd : lines.length);

  const hypotheses =
    hypoFrom < 0
      ? []
      : itemSpans(lines, hypoFrom, hypoTo).map(([from, to], index) =>
          parseHypothesis(lines.slice(from, to), index + 1, from, to),
        );
  const tasks =
    nextFrom < 0
      ? []
      : itemSpans(lines, nextFrom, nextTo).map(([from, to], index) =>
          parseTask(lines.slice(from, to), index + 1, from, to),
        );

  return {
    head: lines.slice(bodyStart, headEnd).join("\n"),
    hypotheses,
    middle: lines.slice(middleFrom, middleTo).join("\n"),
    tasks,
    tail: nextFrom < 0 ? "" : lines.slice(nextTo).join("\n"),
  };
}

/** Continuation indent: aligned under the item's text, so the marker width decides it. */
function indentOf(firstLine: string): string {
  const marker = ITEM.exec(firstLine)?.[1] ?? "-";
  return " ".repeat(marker.length + 1);
}

/**
 * Drop one field from an item — inline on the first line, or its own continuation line.
 *
 * Only the label's own line goes: loom always writes a field as a single line (`oneLine` below),
 * so nothing it wrote can wrap, and a hand-wrapped one loses its label rather than its neighbours.
 */
function stripKey(item: readonly string[], key: Key): string[] {
  const others = KEYS.filter((k) => k !== key).join("|");
  const inline = new RegExp(`\\s*(?:[—–-]\\s*)?\\b${key}:[ \\t]*.*?(?=\\s+\\b(?:${others}):|$)`);
  const own = new RegExp(`^[ \\t]*\\b${key}:`);
  const out: string[] = [];
  item.forEach((line, index) => {
    if (index === 0) {
      out.push(line.replace(inline, "").replace(/[ \t]+$/, ""));
      return;
    }
    if (own.test(line)) return;
    out.push(line);
  });
  return out;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splice one item's replacement lines back into the file. Everything else is copied verbatim. */
function edit(text: string, n: number, rewrite: (item: string[], task: Task) => string[]): string {
  const doc = parseRecord(text);
  const task = doc.tasks.find((t) => t.n === n);
  if (task === undefined) throw new Error(`no task ${n} in this record`);
  const lines = text.split("\n");
  const replaced = rewrite(lines.slice(task.from, task.to), task);
  return [...lines.slice(0, task.from), ...replaced, ...lines.slice(task.to)].join("\n");
}

/**
 * Restate one claim's STANDING, leaving its wording and its evidence alone.
 *
 * User, 2026-08-06, choosing a control over free text: *"ok, button"*. The six words are the
 * linter's, so there is nothing here loom invented — it only stamps the date, which is the part a
 * person forgets. The marker is rewritten in place when the claim already has one and inserted
 * straight after the claim when it does not.
 */
export function setStanding(text: string, n: number, standing: Standing, date: string | null): string {
  const lines = text.split("\n");
  const [from, to] = section(lines, HYPO_HEADING);
  if (from < 0) throw new Error("this record has no `## Hypotheses` section");
  const spans = itemSpans(lines, from, to);
  const span = spans[n - 1];
  if (span === undefined) throw new Error(`no hypothesis ${n} in this record`);

  const stamp = date !== null && date.length > 0 ? ` ${date}` : "";
  const marker = `*${standing[0]?.toUpperCase() ?? ""}${standing.slice(1)}${stamp}*`;
  const item = lines.slice(span[0], span[1]);

  // Only the marker's own line is touched: a claim's evidence can run over several lines, and none
  // of them are loom's to rewrite.
  const bold = BOLD_LEAD.exec(itemBody(item));
  let done = false;
  const out = item.map((line) => {
    if (done) return line;
    const hit = STANDING_MARK.exec(line);
    if (hit === null) return line;
    done = true;
    const after = line.slice(hit.index + hit[0].length);
    return `${line.slice(0, hit.index)}${marker}:${after.length > 0 ? ` ${after}` : ""}`;
  });
  if (!done) {
    // No marker yet — put one straight after the claim's closing `**` on the first line.
    const first = out[0] ?? "";
    const at = bold === null ? first.length : first.indexOf("**", first.indexOf("**") + 2) + 2;
    const rest = first.slice(at);
    out[0] = `${first.slice(0, at)} ${marker}:${rest.length > 0 ? ` ${rest.replace(/^[ \t]*[—–-]?[ \t]*/, "")}` : ""}`.replace(
      /[ \t]+$/,
      "",
    );
  }
  return [...lines.slice(0, span[0]), ...out, ...lines.slice(span[1])].join("\n");
}

/**
 * Add an item to the end of `## Next`, in the numbering and marker style the section already uses.
 *
 * The typed text is "name — plan", the way the skill's grammar has it, so the part before the dash
 * is bolded and the rest is left plain. That is the one formatting decision loom makes on User's
 * behalf, and it makes the line indistinguishable from one he typed himself.
 *
 * A record with no `## Next` section is refused, not given one: loom does not invent sections in
 * the vault.
 */
export function addTask(text: string, title: string): string {
  const body = oneLine(title);
  if (body.length === 0) throw new Error("a task needs a name");

  const lines = text.split("\n");
  const [from, to] = section(lines, NEXT_HEADING);
  if (from < 0) throw new Error("this record has no `## Next` section to add to");

  const spans = itemSpans(lines, from, to);
  const last = spans[spans.length - 1];
  const previous = last === undefined ? null : (lines[last[0]] ?? null);
  const marker = markerAfter(previous, spans.length);

  const { name, plan } = splitName(body);
  const line = `${marker} [ ] **${name}**${plan}`;

  // Straight after the last item, so a section that ends in prose or a blank keeps its shape. With
  // no items at all, at the end of the section's own content.
  let at = last?.[1] ?? to;
  if (last === undefined) while (at > from && (lines[at - 1] ?? "").trim().length === 0) at -= 1;
  return [...lines.slice(0, at), line, ...lines.slice(at)].join("\n");
}

/**
 * Split "name — plan" the way the skill's grammar has it: bold the name, leave the plan plain.
 *
 * A trailing dash is dropped from the name, because the parser drops one when reading it back —
 * without this, typing "Reorder —" writes `**Reorder —**` and reads back as `Reorder`, so the row
 * on screen stops matching the line on disk.
 *
 * The separator he TYPED is the one written back. Normalising a hyphen to an em dash made the row
 * read back as a string he had never typed — "0 - -—" was stored as `**0** — -—` and read as
 * "0 — -—" — which is why `tasks.props` failed on roughly one seed in sixteen and made `bun test`
 * a coin flip all through 2026-08-10. A writer may reformat what it OWNS; a name is his.
 */
function splitName(body: string): { name: string; plan: string } {
  const cut = /\s+[—–]\s+|\s+-\s+/.exec(body);
  const lead = cut === null ? body : body.slice(0, cut.index);
  const trimmed = lead.replace(/\s+[—–-]$/, "").trim();
  const separator = cut === null ? "" : cut[0].trim();
  return {
    name: trimmed.length > 0 ? trimmed : lead,
    plan: cut === null ? "" : ` ${separator} ${body.slice(cut.index + cut[0].length)}`,
  };
}

/** The marker the next item should carry: the section's own style, `1.` when it has none yet. */
function markerAfter(previous: string | null, count: number): string {
  const marker = previous === null ? null : (ITEM.exec(previous)?.[1] ?? null);
  if (marker === null) return "1.";
  return /^\d+\.$/.test(marker) ? `${count + 1}.` : marker;
}

export function setStatus(text: string, n: number, status: TaskStatus): string {
  return edit(text, n, (item) => {
    const first = ITEM.exec(item[0] ?? "");
    if (first === null) return item;
    const boxed = BOXED.exec(first[2] ?? "");
    const rest = boxed !== null ? (boxed[2] ?? "") : (first[2] ?? "");
    const head = `${first[1]} [${TO_BOX[status]}]${rest.length > 0 ? ` ${rest}` : ""}`;
    return [head, ...item.slice(1)];
  });
}

/**
 * Rewrite an item's NAME, and nothing else on it.
 *
 * User, 2026-08-06, choosing this over a textarea over the whole item: *"ok, title only"*. The
 * marker, the box and every field the item carries are copied through — the fields are the item's
 * earned history and are not retyped by hand.
 *
 * The rewrite replaces exactly the lines the name occupied (`leadCount`), because a hand-wrapped
 * name is several lines: keeping only line 0 would leave the old wrapped tail sitting under the new
 * name, which reads as the record saying the same thing twice.
 */
export function setTitle(text: string, n: number, title: string): string {
  const body = oneLine(title);
  if (body.length === 0) throw new Error("a task needs a name");
  return edit(text, n, (item) => {
    const first = ITEM.exec(item[0] ?? "");
    if (first === null) return item;
    const boxed = BOXED.exec(first[2] ?? "");
    const rest = boxed !== null ? (boxed[2] ?? "") : (first[2] ?? "");
    // Everything from the first field label onward is the item's history; only the lead is retyped.
    const label = new RegExp(`\\s*(?:[—–-]\\s*)?\\b(?:${KEYS.join("|")}):`).exec(rest);
    const kept = label === null ? "" : rest.slice(label.index);
    const { name, plan } = splitName(body);
    const box = boxed !== null ? `[${boxed[1] ?? " "}] ` : "";
    return [`${first[1]} ${box}**${name}**${plan}${kept}`, ...item.slice(leadCount(item))];
  });
}

/** Write the result of a task — the verdict the `done` box is gated on (SPEC §Tasks). */
export function setResult(
  text: string,
  n: number,
  result: string,
  artifacts: readonly string[],
  date: string | null,
): string {
  return edit(text, n, (item) => {
    const indent = indentOf(item[0] ?? "");
    const kept = stripKey(stripKey(item, "result"), "artifacts");
    const out = [...kept];
    const stamp = date !== null && date.length > 0 ? ` — ${date}` : "";
    const body = oneLine(result);
    if (body.length > 0) out.push(`${indent}result: ${body}${stamp}`);
    const paths = artifacts.map((a) => oneLine(a)).filter((a) => a.length > 0);
    if (paths.length > 0) out.push(`${indent}artifacts: ${paths.join(" · ")}`);
    return out;
  });
}

export function setSubproject(text: string, n: number, rel: string): string {
  return edit(text, n, (item) => {
    const indent = indentOf(item[0] ?? "");
    return [...stripKey(item, "subproject"), `${indent}subproject: ${oneLine(rel)}`];
  });
}

// ── promotion: a task that outgrew its line becomes a record of its own ────────────────

/** Rename-into-place: the vault rides Resilio, and a half-written record would sync as truth. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.loom-tmp`;
  await Bun.write(tmp, text);
  await rename(tmp, path);
  // SPEC 231. The record scan is cached, and the client re-reads `/api/records` the instant its own
  // POST resolves — `submitCreate`, `submitRename` and `writeRecordStatus` all do. So the cache is
  // dropped HERE, at the one point every record write passes through, rather than in each of the
  // seven routes: a route added later would otherwise be a rail that silently lags its own writes,
  // and that is a wrong answer where a slow one was the whole complaint.
  invalidateRecords();
}

export function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : fallback;
}

export interface Promotion {
  /** Absolute path of the child record. */
  child: string;
  /** Draft of the child session's first message — loom loads the composer with it, never sends it. */
  seed: string;
}

async function freeDir(dir: string, slug: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const name = attempt === 0 ? slug : `${slug}-${attempt + 1}`;
    const path = join(dir, name);
    if (!(await Bun.file(join(path, "project.md")).exists())) return path;
  }
  throw new Error("ten same-named subprojects already exist here");
}

function childRecord(task: Task, name: string, parentTitle: string, parentFile: string, today: string): string {
  const need = task.need ?? task.title;
  return [
    "---",
    "type: project",
    "status: framing",
    `created: ${today}`,
    `parent: ../${parentFile}`,
    "---",
    "",
    `# ${name}`,
    "",
    "## Frame",
    "",
    `**Need.** ${need}`,
    "",
    "**Boundary.** Not written yet — the first session here writes it.",
    "",
    "**What would make this wrong.** Not stated yet.",
    "",
    "## Where it stands",
    "",
    `Split out of **${parentTitle}** on ${today}, where it was task ${task.n}. No work yet.`,
    "",
    "## Next",
    "",
    "1. [ ] Write the frame with User — boundary and the bet.",
    "",
  ].join("\n");
}

function childBrief(task: Task, name: string, parentTitle: string, today: string): string {
  return [
    `# Brief — ${name}`,
    "",
    "## Who and what this is for",
    "",
    task.need ?? task.title,
    "",
    "## Inherited — do not re-decide",
    "",
    `Everything framed in **${parentTitle}** (see \`../project.md\`): its need, its boundary, its bet.`,
    "Read them; do not relitigate them here.",
    "",
    "## This project only",
    "",
    `${task.title}${task.hypo !== null ? `\n\nHypothesis carried in: ${task.hypo}` : ""}`,
    "",
    "## Not inherited",
    "",
    `Not written yet — the first session here names what deliberately does NOT carry over (split ${today}).`,
    "",
  ].join("\n");
}

/**
 * Split a task into a subproject: the child directory, its record and brief, and the parent's line
 * rewritten to point at it. The parent is written LAST — a crash leaves an orphan directory, which
 * is visible and harmless, rather than a parent pointing at a record that does not exist.
 */
export async function promoteTask(
  recordPath: string,
  recordTitle: string,
  n: number,
  today: string,
): Promise<Promotion> {
  const text = await Bun.file(recordPath).text();
  const task = parseRecord(text).tasks.find((t) => t.n === n);
  if (task === undefined) throw new Error(`no task ${n} in this record`);
  if (task.subproject !== null) throw new Error("this task already has a subproject");

  // The child is named after the item's NAME, not "name — plan": the plan is a sentence about what
  // to do, and a directory called `…-finished-today-every-intermediate` is what running the whole
  // title through the slug produced on 2026-08-07.
  const name = splitName(task.title).name;
  const dir = await freeDir(dirname(recordPath), slugify(name, `task-${n}`));
  await mkdir(dir, { recursive: true });
  const child = join(dir, "project.md");
  await writeAtomic(child, childRecord(task, name, recordTitle, basename(recordPath), today));
  await writeAtomic(join(dir, "brief.md"), childBrief(task, name, recordTitle, today));

  const rel = `${basename(dir)}/project.md`;
  await writeAtomic(recordPath, setSubproject(setStatus(text, n, "promoted"), n, rel));

  return {
    child,
    seed: [
      `Opening this subproject — just split out of "${recordTitle}", where it was the task: ${task.title}.`,
      "",
      "Read `brief.md` and `project.md` here first, then write the frame with me: the boundary, the bet,",
      "and what deliberately does NOT carry over from the parent. Do not start on the work until the",
      "frame is written.",
      "",
      "What I meant by it:",
      "",
    ].join("\n"),
  };
}

// ── hand creation and rename (SPEC §Create-and-rename) ─────────────────────────────────────────

/**
 * A hand-created record starts as a title and the framing skeleton — no brief.md, because a brief
 * carries inherited context and a hand-made record has none yet; the first session fills it in.
 */
function blankRecord(name: string, parentFile: string | null, today: string): string {
  return [
    "---",
    "type: project",
    "status: framing",
    `created: ${today}`,
    ...(parentFile === null ? [] : [`parent: ../${parentFile}`]),
    "---",
    "",
    `# ${name}`,
    "",
    "## Frame",
    "",
    "**Need.** Not written yet — the first session here writes it.",
    "",
    "**Boundary.** Not written yet.",
    "",
    "**What would make this wrong.** Not stated yet.",
    "",
    "## Where it stands",
    "",
    `Created by hand on ${today}. No work yet.`,
    "",
    "## Next",
    "",
    "1. [ ] Write the frame with User — boundary and the bet.",
    "",
  ].join("\n");
}

/**
 * Create a record from nothing. With a parent: the child nests under the parent's directory and the
 * parent's `## Next` gains a `[>]` line pointing at it — written LAST, same crash story as
 * promoteTask. Without one: the directory lands under `rootDir` (the vault's Projects/).
 */
export async function createRecord(
  title: string,
  parentRecordPath: string | null,
  rootDir: string,
  today: string,
): Promise<{ child: string }> {
  const name = oneLine(title);
  if (name.length === 0) throw new Error("a project needs a title");

  const home = parentRecordPath === null ? rootDir : dirname(parentRecordPath);
  const dir = await freeDir(home, slugify(name, "project"));
  await mkdir(dir, { recursive: true });
  const child = join(dir, "project.md");
  const parentFile = parentRecordPath === null ? null : basename(parentRecordPath);
  await writeAtomic(child, blankRecord(name, parentFile, today));

  if (parentRecordPath !== null) {
    const text = await Bun.file(parentRecordPath).text();
    const added = addTask(text, name);
    const n = parseRecord(added).tasks.at(-1)?.n;
    if (n === undefined) throw new Error("the added line did not parse back as a task");
    const rel = `${basename(dir)}/project.md`;
    await writeAtomic(parentRecordPath, setSubproject(setStatus(added, n, "promoted"), n, rel));
  }

  invalidateRecords();
  return { child };
}

/** The `parent:` frontmatter field, resolved — null when the record is a root. */
function parentOf(recordPath: string, text: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const raw = fm === null ? null : (/^parent:\s*(.+)$/m.exec(fm[1] ?? "")?.[1]?.trim() ?? null);
  if (raw === null || raw.length === 0) return null;
  return resolve(isAbsolute(raw) ? raw : join(dirname(recordPath), raw));
}

/**
 * Rewrite the `#` title line — nothing else in the record — and ripple into the parent: the `[>]`
 * line referencing this record names the same object, so its title text changes in the same save.
 * The directory name stays; the slug is an address, not a name.
 */
export async function addReference(
  recordPath: string,
  targetPath: string,
  why: string,
  expect: string,
): Promise<void> {
  const text = await Bun.file(recordPath).text();
  const lines = text.split("\n");
  const titleAt = lines.findIndex((line) => /^#\s+/.test(line));
  if (titleAt < 0) throw new Error("this record has no title line");
  const current = (lines[titleAt] ?? "").replace(/^#\s+/, "").trim();
  if (current !== expect) throw new Error("this record changed under you — reload the tab");

  let frontEnd = lines.indexOf("---", 1);
  if (frontEnd < 0) throw new Error("this record has no frontmatter");

  const relTarget = relative(dirname(recordPath), targetPath);
  const targetLine = relTarget.startsWith(".") ? relTarget : `./${relTarget}`;
  const whyLine = why.trim().length > 0 ? `    why: ${oneLine(why)}` : null;

  let refAt = lines.findIndex((line, i) => i < frontEnd && /^references:/.test(line));

  if (refAt >= 0) {
    let nextTop = refAt + 1;
    while (nextTop < frontEnd && /^\s/.test(lines[nextTop] ?? "")) {
      nextTop += 1;
    }
    // Check if it's already there
    for (let i = refAt + 1; i < nextTop; i += 1) {
      const match = /^\s+-\s+path:\s*(.+)$/.exec(lines[i] ?? "");
      if (match !== null && match[1]?.trim() === targetLine) return; // No-op if duplicate
    }
    const newItems = [`  - path: ${targetLine}`];
    if (whyLine !== null) newItems.push(whyLine);
    lines.splice(nextTop, 0, ...newItems);
  } else {
    const newItems = ["references:", `  - path: ${targetLine}`];
    if (whyLine !== null) newItems.push(whyLine);
    // Put it right before the frontmatter end
    lines.splice(frontEnd, 0, ...newItems);
  }

  await writeAtomic(recordPath, lines.join("\n"));
}

export async function renameRecord(
  recordPath: string,
  title: string,
  expect: string,
): Promise<void> {
  const name = oneLine(title);
  if (name.length === 0) throw new Error("a project needs a title");

  const text = await Bun.file(recordPath).text();
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^#\s+/.test(line));
  if (at < 0) throw new Error("this record has no title line");
  const current = (lines[at] ?? "").replace(/^#\s+/, "").trim();
  if (current !== expect) throw new Error("this record changed under you — reload the tab");
  lines[at] = `# ${name}`;
  await writeAtomic(recordPath, lines.join("\n"));

  const parentPath = parentOf(recordPath, text);
  if (parentPath === null || !(await Bun.file(parentPath).exists())) return;
  const parentText = await Bun.file(parentPath).text();
  const referent = parseRecord(parentText).tasks.find(
    (t) => t.subproject !== null && resolve(dirname(parentPath), t.subproject) === resolve(recordPath),
  );
  if (referent === undefined) return;
  // setTitle retypes the item's lead in the record's own grammar (`**name** — plan`) and keeps the
  // keyed lines (subproject:, result:) — exactly what a reference line needs.
  await writeAtomic(parentPath, setTitle(parentText, referent.n, name));
  invalidateRecords();
}

// ── move record (SPEC §Move) ───────────────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";

async function walkMarkdown(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "build") continue;
      await walkMarkdown(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".md")) {
      out.push(join(dir, entry.name));
    }
  }
}

/**
 * PURE FUNCTION: Calculates new path for a relative path inside a moved subtree.
 * Returns the new relative path string, or throws if it breaks out of the subtree.
 */
export function reRelativize(
  link: string,
  mdFile: string,
  oldDir: string,
  newDir: string,
  allowOutside: boolean = false
): string {
  if (isAbsolute(link)) return link;
  const resLink = resolve(dirname(mdFile), link);
  if (!resLink.startsWith(oldDir + "/") && resLink !== oldDir) {
    if (!allowOutside) {
      throw new Error("refused: a link points outside the subtree and cannot be safely re-resolved");
    }
  }
  const subPath = mdFile.slice(oldDir.length);
  const newMdFile = join(newDir, subPath);
  let newResLink = resLink;
  if (resLink.startsWith(oldDir + "/") || resLink === oldDir) {
    const linkSubPath = resLink.slice(oldDir.length);
    newResLink = join(newDir, linkSubPath);
  }
  return relative(dirname(newMdFile), newResLink);
}

/**
 * PURE FUNCTION: Evaluates refusal rules for a reparent operation.
 */
export function checkReparentLegality(
  recordPath: string,
  targetPath: string,
  oldParentPath: string | null
): void {
  if (oldParentPath !== null && resolve(oldParentPath) === resolve(targetPath)) {
    throw new Error("a move onto the record's current parent is a no-op");
  }

  const oldDir = dirname(recordPath);
  const relTarget = relative(oldDir, targetPath);
  if (!relTarget.startsWith("..") && relTarget !== "") {
    throw new Error("reparenting a record under one of its own descendants is a cycle");
  }
}

export async function reparentRecord(
  recordPath: string,
  targetPath: string,
  expect: string,
): Promise<void> {
  const targetStat = await Bun.file(targetPath).exists();
  if (!targetStat) throw new Error("target is not a record");

  const text = await Bun.file(recordPath).text();
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^#\s+/.test(line));
  if (at < 0) throw new Error("this record has no title line");
  const currentTitle = (lines[at] ?? "").replace(/^#\s+/, "").trim();
  if (currentTitle !== expect) throw new Error("this record changed under you — reload the tab");

  const oldParentPath = parentOf(recordPath, text);
  checkReparentLegality(recordPath, targetPath, oldParentPath);

  const oldDir = dirname(recordPath);
  const targetDir = dirname(targetPath);
  const slug = basename(oldDir);
  const newDir = join(targetDir, slug);
  if (await Bun.file(join(newDir, "project.md")).exists()) {
    throw new Error("a subproject with this slug already exists under the target");
  }

  const allMarkdownFiles: string[] = [];
  await walkMarkdown(oldDir, allMarkdownFiles);

  const edits = new Map<string, string>();

  for (const mdFile of allMarkdownFiles) {
    let mdText = await Bun.file(mdFile).text();
    let modified = false;

    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(mdText);
    if (fmMatch !== null) {
      const pMatch = /^parent:\s*(.+)$/m.exec(fmMatch[1] ?? "");
      if (pMatch !== null && pMatch[1]) {
        const rawP = pMatch[1].trim();
        if (rawP.length > 0 && !isAbsolute(rawP)) {
          const resP = resolve(dirname(mdFile), rawP);
          if (!resP.startsWith(oldDir + "/") && resP !== oldDir) {
            const newResP = reRelativize(rawP, mdFile, oldDir, newDir, true);
            mdText = mdText.replace(new RegExp(`^parent:\\s*(.*)$`, "m"), `parent: ${newResP}`);
            modified = true;
          }
        }
      }

      const refsMatches = Array.from((fmMatch[1] ?? "").matchAll(/^\s+-\s+path:\s*(.+)$/gm));
      for (const m of refsMatches) {
        if (m[1] !== undefined) {
          const rawR = m[1].trim();
          if (rawR.length > 0 && !isAbsolute(rawR)) {
            reRelativize(rawR, mdFile, oldDir, newDir, false);
          }
        }
      }
    }

    // Subproject links in descendants
    const docT = parseRecord(mdText);
    for (const t of docT.tasks) {
      if (t.subproject) {
        reRelativize(t.subproject, mdFile, oldDir, newDir, false);
      }
    }

    const bodyText = fmMatch ? mdText.slice(fmMatch[0].length) : mdText;
    const bodyLinks = Array.from(bodyText.matchAll(/\]\(\s*([^)]+)\s*\)/g));
    for (const m of bodyLinks) {
       const link = m[1];
       if (link && !link.startsWith("http") && !isAbsolute(link)) {
          reRelativize(link, mdFile, oldDir, newDir, false);
       }
    }

    if (modified || mdFile === recordPath) {
      edits.set(mdFile, mdText);
    }
  }

  let movedText = edits.get(recordPath) ?? text;
  const newParentRel = relative(newDir, targetPath);
  movedText = movedText.replace(/^parent:\s*.+$/m, `parent: ${newParentRel}`);
  edits.set(recordPath, movedText);

  // 2. Rewrite old parent (remove subproject line)
  if (oldParentPath !== null && (await Bun.file(oldParentPath).exists())) {
    const oldParentText = await Bun.file(oldParentPath).text();
    const oldParentTask = parseRecord(oldParentText).tasks.find(
      (t) => t.subproject !== null && resolve(dirname(oldParentPath), t.subproject) === resolve(recordPath),
    );
    if (oldParentTask !== undefined) {
      const stripped = edit(oldParentText, oldParentTask.n, (item) => {
        return stripKey(item, "subproject");
      });
      edits.set(oldParentPath, stripped);
    }
  }

  // 3. Rewrite new parent (add subproject line)
  const targetText = edits.get(targetPath) ?? await Bun.file(targetPath).text();

  const existingTargetDoc = parseRecord(targetText);
  const matchingTask = existingTargetDoc.tasks.find(t => splitName(t.title).name === splitName(currentTitle).name && t.subproject === null);
  let targetUpdated;
  if (matchingTask !== undefined) {
    const rel = `${slug}/project.md`;
    targetUpdated = setSubproject(setStatus(targetText, matchingTask.n, "promoted"), matchingTask.n, rel);
  } else {
    const added = addTask(targetText, currentTitle);
    const targetDoc = parseRecord(added);
    const n = targetDoc.tasks.at(-1)?.n;
    if (n === undefined) throw new Error("the added line did not parse back as a task");
    const rel = `${slug}/project.md`;
    targetUpdated = setSubproject(setStatus(added, n, "promoted"), n, rel);
  }

  edits.set(targetPath, targetUpdated);

  const rollback = new Map<string, string>();
  for (const [file, content] of edits) {
    if (await Bun.file(file).exists()) {
      rollback.set(file, await Bun.file(file).text());
    }
    await writeAtomic(file, content);
  }

  try {
    await rename(oldDir, newDir);
  } catch (err) {
    // rollback
    for (const [file, content] of rollback) {
      await writeAtomic(file, content);
    }
    throw err;
  }

  invalidateRecords();
}
