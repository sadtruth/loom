/**
 * Hypothesis rows for the record tab — the `## Hypotheses` section, made readable.
 *
 * A hypothesis is a claim plus its standing plus the evidence, and the standing is the part a
 * reader scans for: which of these is still open, and which one already fell over. So the standing
 * is a chip at the front of the row, not a phrase buried in the prose, and refuted claims stay
 * visible rather than being tidied away — a refuted hypothesis is the most valuable line in a
 * record.
 *
 * The standing is a BUTTON, not a text field — User, 2026-08-06: *"ok, button"*. There are only
 * six legal words and `tools/project-guard/lint.py` already fixes them, so nothing is invented by
 * offering them as a menu; what loom adds is the date, which is the part a person forgets.
 */

export const STANDINGS = [
  "open",
  "supported",
  "half-supported",
  "confirmed",
  "refuted",
  "disproven",
] as const;
export type Standing = (typeof STANDINGS)[number];

export interface Hypothesis {
  n: number;
  claim: string;
  standing: Standing | null;
  since: string | null;
  evidence: string;
  from: number;
  to: number;
  /** Echoed back on every write so an edit cannot land on a claim the reader never saw. */
  head: string;
}

export interface HypothesisHandlers {
  onStanding: (hypothesis: Hypothesis, standing: Standing) => void;
}

/** The six words, offered as a menu. Picking one writes it, and stamps today unless it is `open`. */
function standingPicker(hypothesis: Hypothesis, handlers: HypothesisHandlers): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "hypo-picker";
  for (const standing of STANDINGS) {
    if (standing === hypothesis.standing) continue;
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = `hypo-pick is-${standing}`;
    pick.textContent = standing;
    pick.addEventListener("click", () => handlers.onStanding(hypothesis, standing));
    menu.append(pick);
  }
  return menu;
}

function row(hypothesis: Hypothesis, handlers: HypothesisHandlers): HTMLElement {
  const item = document.createElement("li");
  item.className = `hypo is-${hypothesis.standing ?? "unstated"}`;
  item.dataset["hypo"] = String(hypothesis.n);

  const mark = document.createElement("button");
  mark.type = "button";
  mark.className = "hypo-standing";
  mark.textContent = hypothesis.standing ?? "no standing";
  mark.title =
    hypothesis.standing === null
      ? "no standing — click to give it one"
      : hypothesis.since !== null
        ? `${hypothesis.standing} since ${hypothesis.since} — click to restate it`
        : `${hypothesis.standing} — click to restate it`;

  let menu: HTMLElement | null = null;
  mark.addEventListener("click", () => {
    if (menu !== null) {
      menu.remove();
      menu = null;
      return;
    }
    menu = standingPicker(hypothesis, handlers);
    item.append(menu);
  });
  item.append(mark);

  const main = document.createElement("div");
  main.className = "hypo-main";

  const claim = document.createElement("div");
  claim.className = "hypo-claim";
  claim.textContent = `${hypothesis.n}. ${hypothesis.claim}`;
  main.append(claim);

  if (hypothesis.evidence.length > 0) {
    const evidence = document.createElement("div");
    evidence.className = "hypo-evidence";
    evidence.textContent = hypothesis.evidence;
    main.append(evidence);
  }

  item.append(main);
  return item;
}

export function renderHypotheses(
  hypotheses: readonly Hypothesis[],
  handlers: HypothesisHandlers,
): HTMLElement {
  const list = document.createElement("ol");
  list.className = "hypos";
  for (const hypothesis of hypotheses) list.append(row(hypothesis, handlers));
  return list;
}
