/** The status line and the toast — the two places loom says something in passing.
 *
 * They sat inside the scrolling section of `app.ts` until 2026-08-25, which owned neither: `toast`
 * was reached for from ten other sections and `setStatus` from the transport. A helper half the
 * file calls belongs to nobody's feature, so it gets its own.
 */
import { ui } from "./store.ts";

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(message: string, bad = false): void {
  ui.toast.textContent = message;
  ui.toast.classList.toggle("bad", bad);
  ui.toast.classList.add("show");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2600);
}

export function setStatus(text: string, kind: "" | "live" | "error" = ""): void {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`.trim();
}
