/**
 * The `plan` block — a build plan drawn from its file (SPEC §Rich blocks 147–152).
 *
 * The fence carries a PATH, never content: the plan is the same file the build gate demands, so
 * the chat and the plan cannot drift. Everything the block shows is either in that file or derived
 * from the world (the gate's unlock, git) — the state is never typed into the document, because a
 * typed state keeps claiming "open" long after the gate shut.
 *
 * Sections render OPEN (151). The arrow folds one already read; nothing starts folded, because a
 * plan he has to click through is a plan he approves unread.
 */

import {
  asList,
  SCHEMA,
  fieldOf,
  IMAGE_LINE,
  missingFields,
  parsePlan,
  planSize,
  sectionOf,
  type PlanDoc,
  type PlanItem,
  type PlanSection,
} from "./plan-parse.ts";
import { looksLikePath } from "./paths.ts";
import { labelChips, type RecordLike } from "./chips.ts";
import { embed, embedKind } from "./embed.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A chip with NO label — `labelChips()` owns labelling, and it skips any chip that arrives with
 * one. Built here rather than imported from markdown.ts, which imports this module's registry.
 */
function chip(raw: string): HTMLAnchorElement {
  const node = document.createElement("a");
  node.className = "chip";
  node.dataset["raw"] = raw;
  node.dataset["path"] = raw;
  node.href = "#";
  node.title = raw;
  node.textContent = raw.split("/").slice(-1)[0] ?? raw;
  return node;
}

/**
 * `backticks` become code, **stars** bold and *singles* italic — the three inline marks a plan
 * actually uses (his quotes are all italic). The
 * plan's text is written by hand in markdown, and showing the marks literally reads as a bug.
 * Text only: nothing here can produce an element from the file's characters, so no sanitiser.
 */
/**
 * `SPEC.md`, `VERIFY.md`, `blocks.ts` — a bare filename with no slash. `looksLikePath` refuses one
 * (rightly: in ordinary prose it is usually a word), but a plan cites the files of ONE project and
 * every such name in it is a destination. User, 2026-08-11: "the Spec.md and verify.md are not
 * proper links to those files". The server's `locate` walks the plan's directory and its ancestors,
 * so the name alone is enough to open.
 */
const BARE_FILE = /^[\w.-]+\.(md|ts|tsx|js|py|sh|json|css|html|toml|ya?ml)$/i;

function isDestination(text: string): boolean {
  return looksLikePath(text) || BARE_FILE.test(text.trim());
}

function inlineText(text: string, host: HTMLElement): void {
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g)) {
    if (part.length === 0) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const inner = part.slice(1, -1);
      // A path in backticks is a LINK, not a code span: the plan cites files, records and tasks
      // constantly, and rendering them as grey text throws away every destination in the document.
      host.append(isDestination(inner) ? chip(inner) : el("code", undefined, inner));
    } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      host.append(el("b", undefined, part.slice(2, -2)));
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      host.append(el("i", undefined, part.slice(1, -1)));
    } else {
      host.append(document.createTextNode(part));
    }
  }
}

function withInline(tag: "span" | "p" | "td" | "th", cls: string | undefined, text: string): HTMLElement {
  const node = el(tag, cls);
  inlineText(text, node);
  return node;
}

function gap(what: string): HTMLElement {
  return el("span", "plan-gap", what);
}

/** `label · value` row, or a visible gap when the value is missing (147). */
function factRow(key: string, value: Node | string | null): HTMLElement {
  const row = el("div", "plan-fact");
  row.append(el("span", "plan-k", key));
  const box = el("span", "plan-v");
  if (value === null) {
    row.classList.add("missing");
    box.append(gap(`no ${key}`));
  } else if (typeof value === "string") {
    box.append(document.createTextNode(value));
  } else {
    box.append(value);
  }
  row.append(box);
  return row;
}

function chipList(values: readonly string[], cls?: string): HTMLElement {
  const box = el("span", "plan-chips");
  for (const value of values) {
    const node = chip(value);
    if (cls !== undefined) node.classList.add(cls);
    box.append(node);
  }
  return box;
}

function section(
  title: string,
  count: string,
  planPath = "",
): { host: HTMLElement; body: HTMLElement } {
  const folds = FOLDED.get(planPath) ?? new Set<string>();
  const shutNow = folds.has(title);
  const host = el("div", `plan-sec${shutNow ? " shut" : ""}`);
  const head = el("div", "plan-h");
  const arrow = el("span", "plan-arrow", shutNow ? "▸" : "▾");
  head.append(arrow, el("span", "plan-t", title));
  if (count.length > 0) head.append(el("span", "plan-c", count));
  head.addEventListener("click", () => {
    const shut = host.classList.toggle("shut");
    arrow.textContent = shut ? "▸" : "▾";
    const set = FOLDED.get(planPath) ?? new Set<string>();
    if (shut) set.add(title);
    else set.delete(title);
    FOLDED.set(planPath, set);
  });
  const body = el("div", "plan-b");
  host.append(head, body);
  return { host, body };
}

const KIND_LABEL: Record<string, string> = { new: "new", changed: "changed" };

/** `kind: new` / `kind: changed · failure` becomes the badge his eye catches (his ask). */
function kindBadge(item: PlanItem): HTMLElement | null {
  const raw = fieldOf(item, "kind");
  if (raw === null) return null;
  const first = raw.split("·")[0]?.trim().toLowerCase() ?? "";
  const label = KIND_LABEL[first];
  if (label === undefined) return null;
  const badge = el("span", `plan-tag ${first}`, label);
  return badge;
}

/**
 * A line that OPENS a block. Everything else continues the line before it.
 *
 * The plan file is hard-wrapped at 100 columns, so a source line is not a paragraph — and drawing
 * one `<p>` per line is what made the document read as a column of orphans (User, 2026-08-11:
 * "clearly different from the prototype"). The list is deliberately concrete rather than clever:
 * a table row, a numbered or bulleted item, a `state → state:` transition, a `HH:MM ·` log entry.
 */
const OPENS = /^(!\[|\||\d+\.\s|[-*]\s|\S+\s*→\s*\S+\s*:|\d{1,2}:\d{2}\s*·)/u;

/**
 * Hard-wrapped source lines rejoined into the blocks they were written as. A blank line always
 * ends one; `OPENS` starts a new one; anything else is the previous line's continuation.
 */
export function reflow(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const last = out[out.length - 1];
    // A table row absorbs nothing — the line after a table is the table's caption, not its cell.
    // A wrapped list item DOES absorb its continuation, which is why only an opener splits here.
    if (last === undefined || last === "" || OPENS.test(line) || last.startsWith("|")) {
      out.push(line.trim());
      continue;
    }
    out[out.length - 1] = `${last} ${line.trim()}`;
  }
  return out.filter((line) => line !== "");
}

const STATES = new Set(["awaiting", "open", "stopped", "closed", "dropped"]);

/**
 * `awaiting → open: User types build start` — a transition, not a sentence. The prototype drew
 * these as rows of coloured state pills (`.st.awaiting` … `.st.dropped`) and the block drew them as
 * paragraphs, which is most of why requirement 148 read as a wall (User, 2026-08-11).
 */
function transitionRow(line: string): HTMLElement | null {
  const cut = /^(\w+)\s*→\s*(\w+)\s*:\s*(.*)$/u.exec(line);
  if (cut === null) return null;
  const [, from = "", to = "", rest = ""] = cut;
  if (!STATES.has(from.toLowerCase()) || !STATES.has(to.toLowerCase())) return null;
  const row = el("div", "plan-trans");
  const pair = el("span", "plan-trans-p");
  pair.append(el("span", `plan-st ${from.toLowerCase()}`, from));
  pair.append(el("span", "plan-arrow-to", "→"));
  pair.append(el("span", `plan-st ${to.toLowerCase()}`, to));
  row.append(pair);
  row.append(withInline("span", "plan-trans-x", rest));
  return row;
}

/**
 * The directory the plan being drawn lives in — what a relative picture path resolves against
 * (SPEC 168). Module state rather than a parameter: `draw` is synchronous and one plan is built at
 * a time, and threading a base through every prose and item renderer would touch a dozen calls.
 * The session's cwd is deliberately NOT the answer — that is the resolution that 400s (SPEC 143).
 */
let PLAN_DIR = "";

/** The picture a `visual:` names — the first token in it that is a file this block can show. */
export function visualPath(value: string): string | null {
  for (const token of value.split(/[\s`]+/)) {
    const clean = token.replace(/[.,;]$/, "").trim();
    if (clean.length > 0 && embedKind(clean) !== null) return clean;
  }
  return null;
}

/** One picture, with its caption under it. */
function picture(path: string, caption: string): HTMLElement | null {
  const node = embed(path, PLAN_DIR, caption);
  if (node === null) return null;
  const wrap = el("div", "plan-pic");
  wrap.append(node);
  if (caption.length > 0) wrap.append(el("div", "plan-cap", caption));
  return wrap;
}

/** `| a | b |` rows become a real table; a `---` separator row is dropped. */
function renderProse(raw: readonly string[], host: HTMLElement): void {
  const lines = reflow(raw);
  let rows: string[][] = [];
  const flush = (): void => {
    if (rows.length === 0) return;
    const table = el("table", "plan-table");
    const [head, ...body] = rows;
    if (head !== undefined) {
      const tr = el("tr");
      for (const cell of head) tr.append(withInline("th", undefined, cell));
      table.append(tr);
    }
    for (const row of body) {
      const tr = el("tr");
      row.forEach((cell, i) => {
        const td = withInline("td", undefined, cell);
        // The header text travels with every cell so a narrow column can stack the row and still
        // say which column each value came from (requirement 150).
        const name = head?.[i];
        if (name !== undefined && name.length > 0) td.dataset["col"] = name;
        tr.append(td);
      });
      table.append(tr);
    }
    host.append(table);
    rows = [];
  };
  for (const line of lines) {
    if (line.startsWith("|")) {
      const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^-{2,}$/.test(c))) continue;
      rows.push(cells);
      continue;
    }
    flush();
    const image = IMAGE_LINE.exec(line.trim());
    if (image !== null) {
      const drawn = picture(image[2] ?? "", image[1] ?? "");
      if (drawn !== null) {
        host.append(drawn);
        continue;
      }
    }
    const trans = transitionRow(line);
    host.append(trans ?? withInline("p", "plan-p", line));
  }
  flush();
}

/** One `###` item: its title, its badge, then every field it carries as a labelled row. */
function renderItem(item: PlanItem, kind = "", ordinal = 0): HTMLElement {
  // `kind: new · failure` — the one scenario that must stand out is the one where things go wrong.
  const failure = (fieldOf(item, "kind") ?? "").toLowerCase().includes("failure");
  const host = el("div", `plan-item${kind === "objects" ? " card" : ""}${failure ? " err" : ""}`);
  const head = el("div", "plan-item-h");
  // A section whose items name themselves (`128 · …`, `3 · …`) is already referenceable; one whose
  // items are only titles is not. User, 2026-08-11, on 32 findings: "they need to be numbered,
  // otherwise its hard to reference them" — CLAUDE.md rule 6, inside the artifact.
  if (ordinal > 0) head.append(el("span", "plan-ord", String(ordinal)));
  head.append(withInline("span", "plan-nm", item.title));
  const badge = kindBadge(item);
  if (badge !== null) head.append(badge);
  host.append(head);
  for (const field of item.fields) {
    if (field.label === "kind") continue;
    if (field.label === "example") continue; // folded below, under its own control
    const row = el("div", "plan-frow");
    row.append(el("span", "plan-flb", field.label));
    const value = el("span", "plan-ftx");
    const cut = field.value.search(/#| § /u);
    const bare = cut < 0 ? field.value : field.value.slice(0, cut);
    if (isDestination(bare)) {
      const node = chip(bare);
      const place = field.value.slice(bare.length);
      // A `task:` names a TASK — the place travels ON the chip, so clicking it lands on that row
      // rather than on the project (User, 2026-08-11). Anything else keeps the place beside it.
      const task = /^#\s*next\s+\d+\s*$/i.test(place.trim());
      value.append(node);
      if (task) {
        node.dataset["place"] = place.trim();
        node.dataset["fixed"] = "1";
        node.replaceChildren(document.createTextNode(place.trim().replace(/^#\s*/, "")));
        node.classList.add("task-link");
      } else if (place.length > 0) value.append(el("span", "plan-place", place));
    } else {
      inlineText(field.value, value);
    }
    row.append(value);
    host.append(row);
  }
  // The picture goes below the fields, so the item still READS as a list of facts and the visual
  // confirms them (SPEC 167, place 2). The `visual:` row itself stays: it carries the path.
  const visual = fieldOf(item, "visual");
  const shown = visual === null ? null : visualPath(visual);
  if (shown !== null) {
    const drawn = picture(shown, "");
    if (drawn !== null) host.append(drawn);
  }

  const example = fieldOf(item, "example");
  if (example !== null) {
    const box = el("div", "plan-ex shut");
    const head = el("div", "plan-exh", "example ▸");
    const body = el("div", "plan-exb");
    inlineText(example, body);
    head.addEventListener("click", () => {
      const shut = box.classList.toggle("shut");
      head.textContent = shut ? "example ▸" : "example ▾";
    });
    box.append(head, body);
    host.append(box);
  }
  renderProse(item.prose, host);
  return host;
}

/** "3 new · 2 changed" — what the prototype's headers carried, derived rather than typed. */
function sectionCount(sec: PlanSection): string {
  if (sec.items.length === 0) return "";
  const kinds = sec.items.map((i) => (fieldOf(i, "kind") ?? "").toLowerCase());
  const fresh = kinds.filter((k) => k.startsWith("new")).length;
  const changed = kinds.filter((k) => k.startsWith("changed")).length;
  const parts: string[] = [];
  if (fresh > 0) parts.push(`${fresh} new`);
  if (changed > 0) parts.push(`${changed} changed`);
  if (parts.length === 0) parts.push(`${sec.items.length}`);
  if (kinds.some((k) => k.includes("failure"))) parts.push("1 failure");
  return parts.join(" · ");
}

/** `14:20 · what happened · +40m` — three columns, as the prototype drew them. */
function renderLog(sec: PlanSection, body: HTMLElement): void {
  for (const line of reflow(sec.prose)) {
    // A picture is a picture in EVERY section (SPEC 167): the log renderer splits on `·`, so an
    // image paragraph here would come out as one column of markdown source.
    const image = IMAGE_LINE.exec(line.trim());
    if (image !== null) {
      const drawn = picture(image[2] ?? "", image[1] ?? "");
      if (drawn !== null) {
        body.append(drawn);
        continue;
      }
    }
    const row = el("div", "plan-log");
    const parts = line.split("·").map((p) => p.trim());
    const when = /^\d{1,2}:\d{2}$/.test(parts[0] ?? "") ? parts.shift() ?? "" : "";
    const delta = /^[+−-]\s*\d+/.test(parts[parts.length - 1] ?? "") ? parts.pop() ?? "" : "";
    row.append(el("span", "plan-log-t", when));
    const text = el("span", "plan-log-x");
    inlineText(parts.join(" · "), text);
    row.append(text);
    if (delta.length > 0) {
      const over = delta.startsWith("+");
      const tag = el("span", `plan-log-d${over ? " over" : " under"}`, delta);
      // "what do the red numbers in log mean?" — User, 2026-08-11. They are minutes against the
      // estimate; a number with no unit and no label is a number nobody can read.
      tag.title = over ? "minutes this cost beyond the estimate" : "minutes this saved against the estimate";
      row.append(tag);
    }
    body.append(row);
  }
}

/** `1. Claude — takes the worktree` becomes an actor badge and a step (the prototype's shape). */
const ROLES = new Set(["builder", "verifier", "reviewer"]);

function renderSteps(sec: PlanSection, body: HTMLElement, roles = false): void {
  for (const line of reflow(sec.prose)) {
    const step = /^(\d+)\.\s+([A-Za-z][\w -]{0,20}?)\s+—\s+(.*)$/.exec(line);
    if (step?.[2] === undefined) {
      body.append(withInline("p", "plan-p", line));
      continue;
    }
    const row = el("div", "plan-who");
    const actor = step[2].trim();
    row.append(el("span", "plan-ord", step[1] ?? ""));
    // A ROLE is not a person: the prototype gave the three subagents their own purple chip, and a
    // step done by a role reads differently from one User or I do (his item 5, 2026-08-11).
    const isRole = roles || ROLES.has(actor.toLowerCase());
    const badge = isRole
      ? el("span", "plan-role", actor)
      : el("span", `plan-actor${actor === "User" ? " you" : " me"}`, actor);
    row.append(badge);
    const text = el("span", "plan-who-x");
    inlineText(step[3] ?? "", text);
    row.append(text);
    body.append(row);
  }
}

/** A quality question keeps its "— Who" as a badge, so every check has an owner on screen. */
function renderQuality(sec: PlanSection, body: HTMLElement): void {
  for (const line of reflow(sec.prose)) {
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (numbered?.[2] === undefined) {
      body.append(withInline("p", "plan-p", line));
      continue;
    }
    const text = numbered[2];
    const row = el("div", "plan-q");
    const cut = text.lastIndexOf(" — ");
    const body_ = cut > 0 ? text.slice(0, cut) : text;
    const who = cut > 0 ? text.slice(cut + 3).trim() : "";
    const ask = body_.split("?")[0] ?? body_;
    const rest = body_.slice(ask.length + 1);
    // Number first, then WHO — the same order as Deployment. User, 2026-08-11: the two sections
    // put the actor in different places, and a reader scanning for "mine" had to hunt per section.
    row.append(el("span", "plan-ord", numbered[1] ?? ""));
    row.append(el("span", `plan-actor${who === "User" ? " you" : " me"}`, who.length > 0 ? who : "?"));
    const said = el("span", "plan-q-x");
    said.append(withInline("span", "plan-ask", `${ask}?`));
    if (rest.trim().length > 0) said.append(withInline("span", "plan-how", rest.trim()));
    row.append(said);
    body.append(row);
  }
}

function renderSection(sec: PlanSection, planPath: string, title = sec.title): HTMLElement {
  const count = sectionCount(sec);
  const { host, body } = section(title, count, planPath);
  const kind = sec.title.toLowerCase();
  if (kind === "log") {
    body.append(el("div", "plan-legend", "time · what happened · minutes against the estimate"));
    renderLog(sec, body);
  }
  else if (kind === "deployment") renderSteps(sec, body);
  else if (kind === "subagents") renderSteps(sec, body, true);
  else if (kind === "quality") renderQuality(sec, body);
  else renderProse(sec.prose, body);
  const selfNumbered = sec.items.every((item) => /^\d/.test(item.title));
  sec.items.forEach((item, i) => body.append(renderItem(item, kind, selfNumbered ? 0 : i + 1)));
  return host;
}

/** Tasks grouped under the record each belongs to — a build may serve several projects. */
function renderWork(doc: PlanDoc): HTMLElement {
  const records = asList(doc.front.get("records") ?? doc.front.get("record") ?? "");
  const work = asList(doc.front.get("work") ?? "");
  const host = el("div", "plan-work");
  if (records.length === 0) {
    host.append(factRow("records", null));
    return host;
  }
  for (const record of records) {
    const group = el("div", "plan-group");
    const head = el("div", "plan-group-h");
    head.append(chip(record));
    group.append(head);
    // `work:` entries name the record when there is more than one: `<record>#next 2`.
    const mine = work.filter((entry) =>
      records.length === 1 ? true : entry.startsWith(record),
    );
    if (mine.length === 0) {
      group.append(gap("no task on this record"));
    } else {
      const known = RECORDS.get(record);
      for (const entry of mine) {
        const id = (entry.split("#").slice(-1)[0] ?? entry).trim();
        const task = known?.get(id.toLowerCase());
        const row = el("div", `plan-task${task?.status === "x" ? " done" : ""}`);
        row.append(el("span", "plan-box", BOX[task?.status ?? " "] ?? "☐"));
        row.append(el("span", "plan-task-n", id.replace(/^next /, "")));
        const name = el("span", "plan-task-name");
        if (task === undefined) {
          name.append(gap(`${id} is not on this record`));
        } else {
          // The row opens the task object itself. "with links" — User, 2026-08-11; a build's task
          // list is only usable if each row goes to the item whose box it is drawing.
          const link = chip(record);
          link.dataset["fixed"] = "1"; // the task's NAME, not a filename for labelChips to redo
          link.dataset["place"] = `#${id}`; // …and the row it opens IS the task, not the record
          link.classList.add("task-link");
          link.replaceChildren();
          inlineText(task.name, link);
          name.append(link);
        }
        row.append(name);
        group.append(row);
      }
    }
    host.append(group);
  }
  return host;
}

const ORDER = [
  "Requirements",
  "Scenarios",
  "Objects",
  "Quality",
  "Code validation",
  "Subagents",
  "Deployment",
  "Update afterwards",
  "Found during the build",
  "Log",
  // Lineage is context, not the decision — last, by his instruction (151).
  "Builds before this",
];

const SAYS: Record<PlanState["state"], string> = {
  awaiting: "awaiting your go",
  open: "gate open",
  stopped: "stopped — work in the tree, gate shut",
  closed: "closed — landed",
  dropped: "dropped — the tree is gone and never landed",
};

const FOOT: Record<PlanState["state"], string> = {
  awaiting: "Type build start to open the gate.",
  open: "build stop closes the gate.",
  stopped: "build start on this plan resumes the same build.",
  closed: "Kept as the record of what was agreed.",
  dropped: "Nothing landed. The log says why.",
};

function draw(doc: PlanDoc, text: string, path: string, live: PlanState): HTMLElement {
  PLAN_DIR = dirOf(path);
  const host = el("div", `plan ${live.state}`);

  const head = el("div", "plan-head");
  const kind = el("div", "plan-kind");
  const id = doc.front.get("id") ?? "";
  if (id.length > 0) kind.append(el("span", "plan-id", id));
  else kind.append(gap("no build id"));
  const file = chip(path);
  file.classList.add("plan-file");
  file.textContent = "plan file";
  kind.append(file);
  head.append(kind);
  const h3 = el("h3");
  if (doc.title.length > 0) inlineText(doc.title, h3);
  else h3.append(gap("no title"));
  head.append(h3);
  const declared = (doc.front.get("size") ?? "").trim().toUpperCase();
  // A file with no size used to pick its own grading scale: `planSize` defaults to M and the whole
  // required-field check then ran against M's column (the verifier, 2026-08-10).
  head.append(
    declared === "S" || declared === "M" || declared === "L"
      ? el("span", "plan-size", declared)
      : gap("no size"),
  );
  host.append(head);

  const state = el("div", "plan-state");
  state.append(el("span", "plan-dot"));
  const says = live.tree === null ? SAYS[live.state] : `${SAYS[live.state]} — ${live.tree}`;
  state.append(el("span", undefined, says));
  const when = clock(live.left);
  if (when.length > 0) state.append(el("span", "plan-when", when));
  host.append(state);

  // What the gate knows, said here — quality question 2 was answered "no" while a plan naming a
  // worktree that exists nowhere rendered as an ordinary fact (the verifier, 2026-08-10).
  if (live.problems.length > 0) {
    const warn = el("div", "plan-missing");
    warn.append(gap(`${live.problems.length} would refuse this plan`));
    for (const problem of live.problems) {
      const row = el("div", "plan-problem");
      row.append(el("span", "plan-flb", problem.field));
      row.append(withInline("span", "plan-ftx", problem.says));
      warn.append(row);
    }
    host.append(warn);
  } else {
    const missing = missingFields(doc);
    if (missing.length > 0) {
      const warn = el("div", "plan-missing");
      warn.append(gap(`${missing.length} required: ${missing.join(", ")}`));
      host.append(warn);
    }
  }

  host.append(renderWork(doc));
  const size = planSize(doc);
  const need = (field: string): boolean =>
    SCHEMA.find((entry) => entry.field === field)?.[size] === "required";
  const optional = (field: string, value: Node | string | null): void => {
    // Drawing "no stack" in error red for a field the schema calls optional made the block shout
    // about something nobody promised (the verifier, 2026-08-10).
    if (value === null && !need(field)) return;
    host.append(factRow(field, value));
  };
  optional("git", doc.front.get("git") ?? null);
  const stack = asList(doc.front.get("stack") ?? "");
  optional("stack", stack.length > 0 ? chipList(stack, "tech") : null);
  optional("estimate", doc.front.get("estimate") ?? null);

  const proto = doc.front.get("prototype");
  if (proto !== undefined && proto.length > 0) {
    const { host: sec, body } = section("Prototype", "", path);
    // The page itself, with the chip under it. It was a chip alone until the frame learned to
    // size itself to its content; a plan about a visual change with nothing visible in it is the
    // complaint that started this (User, 2026-08-11) — SPEC 165, place 1.
    const drawn = picture(proto, "");
    if (drawn !== null) body.append(drawn);
    body.append(chip(proto));
    host.append(sec);
  }

  for (const title of ORDER) {
    const sec = sectionOf(doc, title);
    if (sec !== null) {
      host.append(renderSection(sec, path));
      continue;
    }
    // 157: the lineage is COLLECTED, so it renders whether or not the file mentions it.
    if (title === "Builds before this" && live.lineage.length > 0) {
      const { host: box, body } = section(title, `${live.lineage.length}`, path);
      for (const earlier of live.lineage) {
        const row = el("div", "plan-prev");
        row.append(el("span", "plan-prev-id", earlier.id));
        const link = chip(earlier.path);
        if (earlier.title.length > 0) {
          link.textContent = earlier.title;
          link.dataset["fixed"] = "1"; // a plan's own title, not a filename for labelChips to redo
        }
        row.append(link);
        row.append(el("span", `plan-prev-state ${earlier.state}`, earlier.state));
        body.append(row);
      }
      host.append(box);
      continue;
    }
    // 147: an absent required section is a HOLE you can see, not a block that is quietly shorter.
    if (SCHEMA.find((entry) => entry.field === title)?.[size] === "required") {
      host.append(factRow(title.toLowerCase(), null));
    }
  }

  // `changed:` is a RESULT — git's, not the plan's — so it appears only once there is one.
  if (live.changed.length > 0) {
    const shown = live.changed.slice(0, 6);
    const box = chipList(shown);
    if (live.changed.length > shown.length) {
      box.append(el("span", "muted", `+${live.changed.length - shown.length} more`));
    }
    host.append(factRow("changed", box));
  }

  const foot = el("div", "plan-foot");
  foot.append(el("span", undefined, FOOT[live.state]));
  const src = el("span", "plan-src", "source");
  const pre = el("pre", "plan-raw");
  pre.append(el("code", undefined, text));
  pre.hidden = true;
  src.addEventListener("click", () => {
    pre.hidden = !pre.hidden;
    src.textContent = pre.hidden ? "source" : "hide source";
  });
  foot.append(src);
  host.append(foot, pre);
  host.dataset["plan"] = path;
  return host;
}

/**
 * The state is DERIVED, never read from the file: the gate's unlock names the plan it opened and
 * carries the timestamp it opened at. Asked for as a relative path so the server's own resolution
 * ladder finds it from the session's directory (SPEC 143).
 */
/** Read every record the plan names, once, so its tasks can be shown by name and by status. */
async function readRecords(doc: PlanDoc, base: string): Promise<void> {
  const records = asList(doc.front.get("records") ?? doc.front.get("record") ?? "");
  await Promise.all(
    records.map(async (record) => {
      if (RECORDS.has(record)) return;
      try {
        const res = await fetch(`/api/file?path=${enc(record)}&base=${enc(base)}`);
        if (!res.ok) return;
        const file = (await res.json()) as { text: string };
        RECORDS.set(record, parseNext(file.text));
      } catch {
        // A record that cannot be read leaves its tasks named by id — a gap, not a crash.
      }
    }),
  );
}

export interface PlanState {
  state: "awaiting" | "open" | "stopped" | "closed" | "dropped";
  tree: string | null;
  changed: string[];
  left: number;
  /** What the gate would refuse this plan for — drawn, so refusing does not need a `build start`. */
  problems: Array<{ field: string; says: string }>;
  /** Earlier builds on the same records, newest first — collected by the server (SPEC 157). */
  lineage: Array<{ id: string; title: string; path: string; state: PlanState["state"] }>;
}

/**
 * The state is DERIVED, never read from the file — and derived by the SERVER, the only side that
 * can run git or read the gate's unlock (SPEC 148). The client reading the unlock itself got two
 * states out of five, and 400ed in the live app because a relative path needs a `base`.
 */
async function planState(path: string, cwd: string | null): Promise<PlanState> {
  const idle: PlanState = {
    state: "awaiting",
    tree: null,
    changed: [],
    left: 0,
    problems: [],
    lineage: [],
  };
  try {
    const res = await fetch(`/api/plan-state?plan=${enc(path)}&base=${enc(cwd ?? dirOf(path))}`);
    if (!res.ok) return idle;
    const body = (await res.json()) as Partial<PlanState>;
    return {
      state: body.state ?? "awaiting",
      tree: body.tree ?? null,
      changed: body.changed ?? [],
      left: body.left ?? 0,
      problems: body.problems ?? [],
      lineage: body.lineage ?? [],
    };
  } catch {
    return idle;
  }
}

/** `11h 42m left`, or nothing at all when no clock is running. */
function clock(seconds: number): string {
  if (seconds <= 0) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

/**
 * Files already read, by absolute path. The transcript redraws in FULL on every change, so without
 * this every redraw collapsed each plan block to nothing and re-expanded it a fetch later — which
 * is a page-height change twice per redraw, under the eyes of anyone reading history.
 */
const CACHE = new Map<string, string>();
/** The gate state that went with the cached text, so a cached draw is not silently 'awaiting'. */
const GATE = new Map<string, PlanState>();
const IDLE: PlanState = {
  state: "awaiting",
  tree: null,
  changed: [],
  left: 0,
  problems: [],
  lineage: [],
};
/** When each path was last read, so a burst of redraws is not a burst of fetches. */
const READ_AT = new Map<string, number>();
/**
 * Paths whose read FAILED, which the cache above could not hold because a failure has no text.
 *
 * A miss has to be remembered exactly as a hit is, or the block is rebuilt from nothing on every
 * redraw: empty at draw time, an "unreadable" card a fetch later, and the difference between those
 * two heights lands on the page every time. It is a defect a reader meets, not a test artefact — a
 * plan citing a file outside the readable roots, or one since deleted, made the transcript jump
 * under anyone reading history on every append (measured 2026-08-12: five such blocks, 414.7px of
 * height that existed only during the redraw, plus a `loom:block-grew` per block per redraw).
 */
const MISSED = new Set<string>();
/**
 * Which sections the reader has folded, per plan — transient state the full redraw would otherwise
 * throw away (SPEC 146). Without it every fold reopened a second later, mid-turn.
 */
const FOLDED = new Map<string, Set<string>>();
/** A file this fresh is not re-read on a redraw; a running turn redraws many times a second. */
const FRESH_MS = 4000;

/**
 * The BUILT block, per plan path and per occurrence — reused across redraws rather than rebuilt.
 *
 * The transcript redraws in full on every change, so a plan block was being constructed from
 * scratch several times a second during a turn: a few hundred nodes thrown away and remade, which
 * the reader sees as the whole artifact flashing and shifting (User, 2026-08-10: *"the whole
 * artifact is jumping, flashing, buggin out"*). Moving the existing node into the new tree costs
 * nothing and keeps everything the DOM was holding — folds, and the reader's place.
 */
const NODES = new Map<string, HTMLElement>();
/** How many times each path has been drawn in the redraw currently running. */
const TAKEN = new Map<string, number>();
let clearing = false;

function occurrence(path: string): number {
  if (!clearing) {
    // One full redraw is synchronous, so a microtask is exactly its boundary.
    clearing = true;
    queueMicrotask(() => {
      TAKEN.clear();
      clearing = false;
    });
  }
  const n = TAKEN.get(path) ?? 0;
  TAKEN.set(path, n + 1);
  return n;
}

/**
 * Fill the block, and say by how much it grew and where it was. A reader following the live end is
 * re-pinned; a reader above is held still (SPEC 155).
 */
function grow(wrap: HTMLElement, fill: () => void): void {
  const before = wrap.getBoundingClientRect();
  fill();
  const after = wrap.getBoundingClientRect();
  wrap.dispatchEvent(
    new CustomEvent("loom:block-grew", {
      bubbles: true,
      detail: { delta: after.height - before.height, top: before.top },
    }),
  );
}

const enc = encodeURIComponent;

/**
 * The directory a relative path in this plan resolves against — sent as `base` on every fetch.
 *
 * `/api/file` refuses a relative path with no base (`server/main.ts:754`, SPEC 143), so the block's
 * two supporting reads — the gate's unlock and each record — were 400ing in the live app while the
 * plan itself loaded fine. The state never derived and the reader's own tasks rendered in red as
 * "not on this record" (found by the verifier, 2026-08-10).
 */
function dirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : path;
}

/** One `Next` item of a record: its number, its box and its name. */
interface TaskRow {
  status: string;
  name: string;
}

/** Records already read, so the work rows can say what a task IS rather than "next 2". */
const RECORDS = new Map<string, Map<string, TaskRow>>();

/**
 * A record's `Next` items (SPEC 51): `1. [ ] **Name** — the plan`. The name is what the plan block
 * shows; showing "next 2" was the prototype's whole complaint about the old chat prose.
 */
export function parseNext(text: string): Map<string, TaskRow> {
  const out = new Map<string, TaskRow>();
  const start = text.indexOf("\n## Next");
  if (start < 0) return out;
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const item = /^(\d+)\.\s+\[([ x/\->])\]\s+(.*)$/.exec(line);
    if (item?.[1] === undefined) continue;
    const name = (item[3] ?? "")
      .replace(/\*\*/g, "")
      .split(" — ")[0]
      ?.trim();
    out.set(`next ${item[1]}`, { status: item[2] ?? " ", name: name ?? "" });
  }
  return out;
}

const BOX: Record<string, string> = { " ": "☐", x: "☑", "/": "◪", "-": "⊘", ">": "↳" };

/** `path/to/<slug>-plan-YYYY-MM-DD.md` — one path, nothing else. */
/**
 * A plan cites paths as the REPO writes them — `tools/loom/projects/build-plan/project.md` — while
 * the app knows records by absolute path, so the label rule found no record and fell back to the
 * directory name: a chip reading "build-plan" where the project has a title. One unambiguous
 * suffix match is enough, and an ambiguous one is left alone rather than guessed at.
 */
function absolutise(root: ParentNode, records: readonly RecordLike[], planDir = ""): void {
  for (const node of root.querySelectorAll<HTMLElement>(".chip[data-raw]")) {
    const raw = (node.dataset["raw"] ?? "").trim();
    if (raw.length === 0 || raw.startsWith("/") || raw.startsWith("~")) continue;
    const hits = records.filter((r) => r.path.endsWith(`/${raw}`));
    if (hits.length === 1 && hits[0] !== undefined) {
      node.dataset["raw"] = hits[0].path;
      // `labelChips` skips a chip that carries its own label, and the CLICK reads `data-path` — so
      // a fixed chip that never had its path rewritten pointed at a relative string the server
      // could not resolve. That is why the work rows did nothing at all.
      node.dataset["path"] = hits[0].path;
      continue;
    }
    // `mockups/plan-block-v7-….html` is relative to the plan file's own directory — which is the
    // only thing that could resolve it, and nothing did: the prototype link opened nothing
    // (User, 2026-08-11, item 6).
    if (planDir.length > 0 && raw.includes("/")) node.dataset["raw"] = `${planDir}/${raw}`;
  }
}

/** What a plan block shows when its file cannot be read. One builder, so a redraw rebuilds it identically. */
function unreadable(abs: string): HTMLElement {
  const miss = el("div", "plan plan-unreadable");
  miss.append(el("div", "plan-state", "the plan file could not be read"));
  miss.append(factRow("path", abs));
  return miss;
}

export function renderPlanBlock(
  source: string,
  cwd: string | null,
  records: readonly RecordLike[] = [],
): HTMLElement {
  const raw = source.trim().split("\n")[0]?.trim() ?? "";
  const wrap = el("div", "rich rich-plan");
  if (raw.length === 0) {
    wrap.append(gap("no plan path"));
    return wrap;
  }
  const abs = raw.startsWith("/") ? raw : cwd !== null ? `${cwd}/${raw}` : raw;

  const key = `${abs}#${occurrence(abs)}`;
  const cached = CACHE.get(abs);
  // A remembered MISS counts as knowing the file, exactly as a remembered read does: what the block
  // shows is settled either way, so the redraw must not go through the empty state again.
  if (cached !== undefined || MISSED.has(abs)) {
    const built = NODES.get(key);
    // A node that is STILL ON SCREEN is never moved. `occurrence` counts draws within one redraw,
    // and since 211 a redraw skips turns it would draw identically — so two messages embedding the
    // same plan can both ask for occurrence 0, and appending the cached node here would tear the
    // live one out of the row above and leave it empty (reviewer, 2026-08-14). The real fix is to
    // key on the message rather than on draw order; until that exists, this is the safe read of it.
    if (built !== undefined && !built.isConnected) {
      wrap.append(built); // moved, not rebuilt
    } else if (cached !== undefined) {
      const node = draw(parsePlan(cached), cached, abs, GATE.get(abs) ?? IDLE);
      absolutise(node, records, dirOf(abs));
      labelChips(node, records);
      NODES.set(key, node);
      wrap.append(node);
    } else {
      const node = unreadable(abs);
      NODES.set(key, node);
      wrap.append(node);
    }
    // …and a redraw a few milliseconds later must not re-read the file and redraw it AGAIN, which
    // is what made the block flash and jump through a whole running turn (2026-08-10).
    if (Date.now() - (READ_AT.get(abs) ?? 0) < FRESH_MS) {
      watch(abs, wrap, key, cwd, records);
      return wrap;
    }
  }

  watch(abs, wrap, key, cwd, records);
  reread(abs, wrap, key, cwd, records);
  return wrap;
}

/**
 * Every plan block ON SCREEN, so a plan edited on disk still reaches the reader (SPEC 211's
 * two-sided half).
 *
 * Until 211 the freshness path was the redraw itself: `renderPlanBlock` ran several times a second
 * and re-read the file whenever its own 4s window had passed. A redraw that skips an unchanged turn
 * never calls it — so a plan being edited under a turn that is otherwise idle would have sat on its
 * old text indefinitely, which is the "calm because it is stale" failure this build's own record
 * names as the way to get it wrong (reviewer, 2026-08-14; it was traced before it was ever seen).
 * The clock moves here instead, and the node it updates is the live one in the document.
 */
const WATCHED = new Map<
  HTMLElement,
  { abs: string; key: string; cwd: string | null; records: readonly RecordLike[] }
>();
let ticker: number | null = null;

function watch(
  abs: string,
  wrap: HTMLElement,
  key: string,
  cwd: string | null,
  records: readonly RecordLike[],
): void {
  // Keyed by the WRAP, not appended: `renderPlanBlock` runs on every redraw that touches its turn,
  // and a Set of fresh objects grew one entry per render — each one fetching on every tick, which
  // is a request storm dressed as a freshness check (caught by the suite, 2026-08-14).
  WATCHED.set(wrap, { abs, key, cwd, records });
  if (ticker !== null || typeof window === "undefined") return;
  ticker = window.setInterval(() => {
    for (const [wrap, entry] of [...WATCHED]) {
      // A wrap the redraw threw away is not on screen and is nobody's to refresh.
      if (!wrap.isConnected) {
        WATCHED.delete(wrap);
        continue;
      }
      reread(entry.abs, wrap, entry.key, entry.cwd, entry.records);
    }
    if (WATCHED.size === 0 && ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  }, FRESH_MS);
}

/** Read the file and update the block IN PLACE, only when something actually changed. */
function reread(
  abs: string,
  wrap: HTMLElement,
  key: string,
  cwd: string | null,
  records: readonly RecordLike[],
): void {
  void fetch(`/api/file?path=${encodeURIComponent(abs)}`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then(async (file: { text: string }) => {
      const live = await planState(abs, cwd);
      await readRecords(parsePlan(file.text), dirOf(abs));
      const before = GATE.get(abs);
      const unchanged =
        CACHE.get(abs) === file.text &&
        before !== undefined &&
        before.state === live.state &&
        before.changed.length === live.changed.length &&
        before.problems.length === live.problems.length &&
        before.lineage.length === live.lineage.length;
      CACHE.set(abs, file.text);
      GATE.set(abs, live);
      READ_AT.set(abs, Date.now());
      MISSED.delete(abs); // it reads now — the miss must not outlive the file coming back
      // Nothing changed: leave the DOM exactly as it is. Replacing it with an identical tree is a
      // repaint the reader sees and a scroll position he loses.
      if (unchanged && wrap.firstChild !== null) return;
      grow(wrap, () => {
        const node = draw(parsePlan(file.text), file.text, abs, live);
        absolutise(node, records, dirOf(abs));
      labelChips(node, records);
        NODES.set(key, node);
        wrap.replaceChildren(node);
      });
    })
    .catch(() => {
      // 5 · the plan file is not where the message says: say which path, keep the message.
      const known = MISSED.has(abs);
      MISSED.add(abs);
      READ_AT.set(abs, Date.now());
      // Already showing the miss: leave the DOM alone, the same rule the unchanged read follows.
      if (known && wrap.firstChild !== null) return;
      grow(wrap, () => {
        const miss = unreadable(abs);
        NODES.set(key, miss);
        wrap.replaceChildren(miss);
      });
    });
}
