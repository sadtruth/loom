/**
 * Task rows for the record tab — SPEC §Tasks.
 *
 * A `Next` item is not prose that happens to describe work: it is a very small project (User's
 * 2026-08-05 brainstorm, DESIGN-projects.md), so it renders as a row with a status box you can
 * click, a result it cannot be `done` without, and the door into a subproject. The markdown
 * renderer is deliberately NOT taught about checkboxes — a `[x]` it drew would be a picture of a
 * control, and the whole point is that this one works.
 */

import { makeChip } from "./markdown.ts";

export type TaskStatus = "open" | "doing" | "done" | "dropped" | "promoted";

export interface Task {
  n: number;
  status: TaskStatus | null;
  title: string;
  need: string | null;
  hypo: string | null;
  result: string | null;
  artifacts: string[];
  subproject: string | null;
  from: number;
  to: number;
  /** Echoed back on every write so a tick cannot land on a task the reader never saw. */
  head: string;
}

export interface TaskHandlers {
  /** The record's directory — relative artifact paths resolve against it. */
  dir: string;
  /** Files this session touched, most useful first: the candidates for a result's artifacts. */
  candidates: () => Array<{ path: string; name: string; kind: string }>;
  onStatus: (task: Task, status: TaskStatus) => void;
  onResult: (task: Task, result: string, artifacts: string[], status: TaskStatus) => void;
  onPromote: (task: Task) => void;
  onOpenSubproject: (path: string) => void;
  /** Append a new open item to `## Next`. The text is "name — plan", as written by hand. */
  onAdd: (title: string) => void;
  /** Rewrite an item's name. Only the name — its fields are its earned history. */
  onTitle: (task: Task, title: string) => void;
}

const GLYPH: Record<TaskStatus, string> = {
  open: "",
  doing: "/",
  done: "✓",
  dropped: "✕",
  promoted: "↳",
};

const HINT: Record<TaskStatus, string> = {
  open: "open — click to start it",
  doing: "in progress — click to finish it",
  done: "done — click to reopen",
  dropped: "dropped — click to reopen",
  promoted: "promoted to a subproject — click to reopen",
};

/** open → doing → done → open. `done` is a gate, not a step: the form below intercepts it. */
const AFTER: Record<TaskStatus, TaskStatus> = {
  open: "doing",
  doing: "done",
  done: "open",
  dropped: "open",
  promoted: "open",
};

export function absolutise(path: string, dir: string): string {
  if (path.startsWith("/") || path.startsWith("~")) return path;
  return dir.length > 0 ? `${dir}/${path}` : path;
}

/** Written back short when it sits under the record, so a record stays readable in a plain editor. */
export function relativise(path: string, dir: string): string {
  return dir.length > 0 && path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path;
}

function button(className: string, label: string, title: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.title = title;
  return node;
}

/**
 * The result form: the verdict gate at task grain. Ticking `done` asks what came of it and offers
 * the files this session touched as the change-object side of the answer — a done task with no
 * result is exactly the "it works, it's fun" ceremony the project skill refuses.
 */
function resultForm(task: Task, handlers: TaskHandlers, close: () => void): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "task-form";

  const text = document.createElement("textarea");
  text.className = "task-form-text";
  text.rows = 2;
  text.placeholder = "what came of it? one line is enough";
  text.value = task.result ?? "";
  form.append(text);

  const picked = new Set(task.artifacts.map((a) => absolutise(a, handlers.dir)));
  const candidates = handlers.candidates();
  const pool = [...candidates.map((c) => c.path), ...picked].filter(
    (path, index, all) => all.indexOf(path) === index,
  );

  if (pool.length > 0) {
    const strip = document.createElement("div");
    strip.className = "task-cands";
    const label = document.createElement("span");
    label.className = "task-cands-label";
    label.textContent = "artifacts:";
    strip.append(label);
    for (const path of pool.slice(0, 14)) {
      const chip = button("task-cand", path.split("/").slice(-1)[0] ?? path, path);
      chip.classList.toggle("on", picked.has(path));
      chip.addEventListener("click", () => {
        if (picked.has(path)) picked.delete(path);
        else picked.add(path);
        chip.classList.toggle("on", picked.has(path));
      });
      strip.append(chip);
    }
    form.append(strip);
  }

  const actions = document.createElement("div");
  actions.className = "task-form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "task-save";
  save.textContent = task.status === "done" ? "save result" : "mark done";
  const cancel = button("task-cancel", "cancel", "Leave the task as it was");
  cancel.addEventListener("click", close);
  actions.append(save, cancel);
  form.append(actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = text.value.trim();
    if (body.length === 0) {
      text.focus();
      text.classList.add("bad");
      return;
    }
    handlers.onResult(
      task,
      body,
      [...picked].map((path) => relativise(path, handlers.dir)),
      "done",
    );
  });

  queueMicrotask(() => text.focus());
  return form;
}

function taskRow(task: Task, handlers: TaskHandlers): HTMLElement {
  const row = document.createElement("li");
  row.className = `task ${task.status === null ? "prose" : `is-${task.status}`}`;
  row.dataset["task"] = String(task.n);

  const main = document.createElement("div");
  main.className = "task-main";

  // ── the box: the status, and the one control that changes it ──────
  if (task.status === null) {
    const add = button("task-addbox", "+", "Make this a task — give it a status box");
    add.addEventListener("click", () => handlers.onStatus(task, "open"));
    row.append(add);
  } else {
    const box = button("task-box", GLYPH[task.status], HINT[task.status]);
    box.setAttribute("aria-label", `${task.title} — ${task.status}`);
    box.addEventListener("click", () => {
      const wanted = AFTER[task.status ?? "open"];
      if (wanted === "done") openForm();
      else handlers.onStatus(task, wanted);
    });
    row.append(box);
  }

  // ── the name: click it and retype it, and nothing else moves ──────
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = `${task.n}. ${task.title}`;
  title.title = "Click to rewrite the name";
  title.addEventListener("click", () => {
    if (title.querySelector("input") !== null) return;
    const field = document.createElement("input");
    field.type = "text";
    field.className = "task-title-edit";
    field.value = task.title;
    // Enter and blur are the same commit, and Enter causes a blur: without this latch the write
    // goes twice, and the second one echoes a line the first one already replaced — a 409 the
    // reader sees as "this record changed under you" on a record only they touched.
    let settled = false;
    const restore = (): void => {
      if (settled) return;
      settled = true;
      title.replaceChildren();
      title.textContent = `${task.n}. ${task.title}`;
    };
    const commit = (): void => {
      if (settled) return;
      const next = field.value.trim();
      if (next.length === 0 || next === task.title) {
        restore();
        return;
      }
      settled = true;
      handlers.onTitle(task, next);
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") restore();
    });
    // Blur commits rather than discards: clicking away from a name you just fixed should keep it.
    field.addEventListener("blur", commit);
    title.replaceChildren(field);
    field.focus();
    field.select();
  });
  main.append(title);

  for (const [key, value] of [
    ["need", task.need],
    ["hypo", task.hypo],
  ] as const) {
    if (value === null) continue;
    const line = document.createElement("div");
    line.className = "task-need";
    const label = document.createElement("span");
    label.className = "task-key";
    label.textContent = `${key}: `;
    line.append(label, value);
    main.append(line);
  }

  // ── the result, and the artifacts that are its change-object side ─
  if (task.result !== null) {
    const result = document.createElement("div");
    result.className = "task-result";
    const label = document.createElement("span");
    label.className = "task-key";
    label.textContent = "result: ";
    result.append(label, task.result);
    if (task.status === "done") {
      const edit = button("task-edit", "edit", "Rewrite this result");
      edit.addEventListener("click", () => openForm());
      result.append(edit);
    }
    main.append(result);
  }

  if (task.artifacts.length > 0) {
    const strip = document.createElement("div");
    strip.className = "task-arts";
    for (const path of task.artifacts) {
      strip.append(makeChip(absolutise(path, handlers.dir), path.split("/").slice(-1)[0] ?? path));
    }
    main.append(strip);
  }

  // ── actions ───────────────────────────────────────────────────────
  const actions = document.createElement("div");
  actions.className = "task-actions";
  if (task.subproject !== null) {
    const open = button("task-act", "→ open subproject", task.subproject);
    const target = absolutise(task.subproject, handlers.dir);
    open.addEventListener("click", () => handlers.onOpenSubproject(target));
    actions.append(open);
  } else if (task.status !== null && task.status !== "dropped") {
    const split = button("task-act", "↳ subproject", "Split this task out and start a session in it");
    split.addEventListener("click", () => handlers.onPromote(task));
    actions.append(split);
  }
  if (task.status !== null && task.status !== "dropped" && task.status !== "promoted") {
    const drop = button("task-act", "drop", "Drop this task — the line stays, struck through");
    drop.addEventListener("click", () => handlers.onStatus(task, "dropped"));
    actions.append(drop);
  }
  if (actions.childElementCount > 0) main.append(actions);

  row.append(main);

  // The form replaces the row's own actions in place, so the task you are finishing stays put.
  let form: HTMLFormElement | null = null;
  function openForm(): void {
    if (form !== null) return;
    form = resultForm(task, handlers, () => {
      form?.remove();
      form = null;
    });
    main.append(form);
  }

  return row;
}

/**
 * The add row: a button that becomes a one-line field, at the END of the list.
 *
 * One field, not a form with a slot per attribute — a new task is a name and a plan, and everything
 * else it will ever carry is earned by working on it. A form with `result` and `artifacts` boxes
 * would invite filling them in before the work, which is the record lying.
 */
function addRow(handlers: TaskHandlers): HTMLElement {
  const row = document.createElement("li");
  row.className = "task-add";

  const open = button("task-act", "+ add a task", "Write a new work item into this record");
  const form = document.createElement("form");
  form.className = "task-add-form";
  form.hidden = true;

  const field = document.createElement("input");
  field.type = "text";
  field.className = "task-add-text";
  field.placeholder = "name — and the plan, on one line";

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "task-save";
  save.textContent = "add";
  const cancel = button("task-cancel", "cancel", "Leave the list as it was");

  form.append(field, save, cancel);
  row.append(open, form);

  const shut = (): void => {
    form.hidden = true;
    open.hidden = false;
    field.value = "";
    field.classList.remove("bad");
  };
  open.addEventListener("click", () => {
    open.hidden = true;
    form.hidden = false;
    field.focus();
  });
  cancel.addEventListener("click", shut);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = field.value.trim();
    if (title.length === 0) {
      field.classList.add("bad");
      field.focus();
      return;
    }
    handlers.onAdd(title);
  });
  // Escape backs out — the field is one keystroke from being opened by accident.
  field.addEventListener("keydown", (event) => {
    if (event.key === "Escape") shut();
  });

  return row;
}

export function renderTasks(tasks: readonly Task[], handlers: TaskHandlers): HTMLElement {
  const list = document.createElement("ol");
  list.className = "tasks";
  for (const task of tasks) list.append(taskRow(task, handlers));
  if (tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "rail-empty";
    empty.textContent = "no work items yet";
    list.append(empty);
  }
  list.append(addRow(handlers));
  return list;
}
