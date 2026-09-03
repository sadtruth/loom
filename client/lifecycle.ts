/**
 * The project's own status control, in the record tab's facts line (SPEC 65–66).
 *
 * A task row already closes a work item and demands a result for it. This is the same move one level
 * up: the button next to the status chip closes the PROJECT, and asks for the verdict on the bet
 * before it will — "the work is complete" and "the bet paid off" are different claims, and only the
 * second is worth keeping. A closed project can be reopened; a mis-click is not a one-way door.
 */

export interface LifecycleHandlers {
  /** The record's status as the reader sees it — echoed back so a close lands where it was aimed. */
  status: string;
  onDone: (verdict: string) => void;
  onReopen: () => void;
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
 * The verdict form. Deliberately not a status menu: `done` is the transition with a rule attached,
 * so it gets the one control, and the placeholder says what a verdict is not.
 */
function verdictForm(handlers: LifecycleHandlers, close: () => void): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "record-form";

  const label = document.createElement("div");
  label.className = "record-form-label";
  label.textContent = "the verdict on the bet — which parts landed, which did not";
  form.append(label);

  const text = document.createElement("textarea");
  text.className = "record-form-text";
  text.rows = 3;
  text.placeholder = "not “it works” — what the bet got right, and what it missed";
  form.append(text);

  const actions = document.createElement("div");
  actions.className = "record-form-actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "record-save";
  save.textContent = "mark done";
  const cancel = button("record-cancel", "cancel", "Leave the project as it was");
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
    handlers.onDone(body);
  });

  queueMicrotask(() => text.focus());
  return form;
}

/**
 * The control itself. `display: contents` in the stylesheet, so the button sits inline among the
 * facts and the form drops onto its own row underneath them.
 */
export function renderLifecycle(handlers: LifecycleHandlers): HTMLElement {
  const host = document.createElement("div");
  host.className = "record-life";

  if (handlers.status === "done") {
    const reopen = button("record-act", "reopen", "Reopen this project — back to active");
    reopen.addEventListener("click", () => handlers.onReopen());
    host.append(reopen);
    return host;
  }

  const done = button("record-act", "mark done", "Close this project — it needs a verdict on the bet");
  let form: HTMLFormElement | null = null;
  done.addEventListener("click", () => {
    if (form !== null) return;
    form = verdictForm(handlers, () => {
      form?.remove();
      form = null;
    });
    host.append(form);
  });
  host.append(done);
  return host;
}
