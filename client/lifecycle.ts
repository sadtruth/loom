/**
 * The project's own status control, in the record tab's facts line (SPEC 65–66).
 *
 * A task row already closes a work item; this is the same move one level up: the button next to
 * the status chip closes the PROJECT in one click. It used to ask for a verdict on the bet first,
 * and none was ever written (2026-10-28), so it no longer asks. A closed project can be reopened;
 * a mis-click is not a one-way door.
 */

export interface LifecycleHandlers {
  /** The record's status as the reader sees it — echoed back so a close lands where it was aimed. */
  status: string;
  onDone: () => void;
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

  const done = button("record-act", "mark done", "Close this project");
  done.addEventListener("click", () => handlers.onDone());
  host.append(done);
  return host;
}
