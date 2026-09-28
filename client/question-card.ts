/**
 * The AskUserQuestion permit card (plan `ask-user-in-loom`, `mockups/ask-user-card-2026-09-25.html`).
 *
 * `composer.ts`'s `permitCard` delegates here for `toolName === "AskUserQuestion"` and caches the
 * returned node exactly the way it caches every other permit card — one node for the card's whole
 * life, so picks and typed "Other" text survive every redraw the socket drives (the permit itself
 * never changes once asked, only the DOM the reader is looking at does).
 *
 * Sending posts `{id, verdict:"allow", answers}` where `answers` is keyed by each question's EXACT
 * text (the Agent SDK / VS Code convention — server/input.ts `buildPermitReply` attaches it to the
 * tool call's own input before the CLI runs it). Multi-select answers are the chosen labels joined
 * with ", ", with a typed "Other" appended. Skip denies with a message that tells Claude to ask in
 * plain text instead, rather than the generic denial every other permit card sends.
 *
 * The `answer` function is passed in rather than imported from `composer.ts`, which imports this
 * module to build the card in the first place — passing it in is what keeps that a one-way import.
 */

import type { Permit } from "./types.ts";

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export type AnswerFn = (
  id: string,
  verdict: "allow" | "deny",
  answers?: Record<string, string>,
) => Promise<void>;

/** `permit.toolInput` (or a recorded `tool_use.input`) read as AskUserQuestion's shape, or null. */
export function parseQuestions(input: unknown): AskQuestion[] | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = (input as Record<string, unknown>)["questions"];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const q = item as Record<string, unknown>;
    if (typeof q["question"] !== "string" || !Array.isArray(q["options"]) || q["options"].length === 0) {
      return null;
    }
    const options: AskOption[] = [];
    for (const rawOpt of q["options"]) {
      if (typeof rawOpt !== "object" || rawOpt === null) return null;
      const opt = rawOpt as Record<string, unknown>;
      if (typeof opt["label"] !== "string") return null;
      options.push({
        label: opt["label"],
        description: typeof opt["description"] === "string" ? opt["description"] : undefined,
        preview: typeof opt["preview"] === "string" ? opt["preview"] : undefined,
      });
    }
    out.push({
      question: q["question"],
      header: typeof q["header"] === "string" ? q["header"] : undefined,
      multiSelect: q["multiSelect"] === true,
      options,
    });
  }
  return out;
}

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

interface DoneRow {
  question: string;
  answer: string;
}

function renderDone(card: HTMLElement, rows: readonly DoneRow[], skipped: boolean): void {
  card.className = `ask-card ${skipped ? "skipped" : "answered"}`;
  card.replaceChildren();
  card.append(el("div", "ask-head", skipped ? "Question skipped" : "You answered"));
  const done = el("div", "ask-done");
  if (skipped) {
    done.append(el("div", "ask-done-row ask-done-skip", "Skipped — Claude will ask in the chat instead."));
  } else {
    for (const row of rows) {
      const r = el("div", "ask-done-row");
      r.append(el("div", "ask-done-q", row.question));
      r.append(el("div", "ask-done-a", row.answer.length > 0 ? row.answer : "(no answer)"));
      done.append(r);
    }
  }
  card.append(done);
}

/** The interactive card. `answer` is `composer.ts`'s `answerPermit`, passed in — see file header. */
export function questionCard(permit: Permit, answer: AnswerFn): HTMLElement {
  const card = el("div", "ask-card");
  card.setAttribute("aria-live", "polite");
  card.dataset["permit"] = permit.id;
  card.dataset["tool"] = permit.toolName;

  const questions = parseQuestions(permit.toolInput);
  if (questions === null) {
    // A malformed call still gets something clickable — Skip must always be reachable, so a bad
    // payload can never strand the turn without any card at all.
    card.append(el("div", "ask-head", "Claude is asking you"));
    card.append(el("div", "ask-q", "This question could not be read."));
    const actions = el("div", "ask-actions");
    const skip = el("button", "ask-btn", "Skip, I'll answer in chat");
    skip.type = "button";
    skip.addEventListener("click", () => {
      void answer(permit.id, "deny");
      renderDone(card, [], true);
    });
    actions.append(skip);
    card.append(actions);
    return card;
  }

  const head = el("div", "ask-head");
  head.append(el("span", undefined, "Claude is asking you"));
  const count = el("span", "ask-count");
  head.append(count);
  card.append(head);

  const answerFns: Array<() => string> = [];
  const questionTexts: string[] = [];
  let sendBtn!: HTMLButtonElement;

  const refresh = (): void => {
    const answered = answerFns.filter((f) => f().length > 0).length;
    count.textContent = `${answered} of ${answerFns.length} answered`;
    sendBtn.disabled = answered < answerFns.length;
  };

  for (const question of questions) {
    const qEl = el("div", `ask-q${question.multiSelect === true ? " multi" : ""}`);
    qEl.tabIndex = 0;
    if (question.header !== undefined && question.header.length > 0) {
      qEl.append(el("span", "ask-tag", question.header));
    }
    const text = el("div", "ask-q-text", question.question);
    if (question.multiSelect === true) text.append(el("span", "ask-q-hint", " — pick any"));
    qEl.append(text);

    const opts = el("div", "ask-opts");
    const optButtons: HTMLButtonElement[] = [];
    const previews: HTMLPreElement[] = [];

    question.options.forEach((option, i) => {
      const btn = el("button", "ask-opt");
      btn.type = "button";
      btn.append(el("span", "ask-mark"));
      const body = el("span", "ask-opt-body");
      body.append(el("span", "ask-label", option.label));
      if (option.description !== undefined && option.description.length > 0) {
        body.append(el("span", "ask-desc", option.description));
      }
      btn.append(body);
      btn.append(el("span", "ask-num", String(i + 1)));
      opts.append(btn);
      optButtons.push(btn);

      const preview = el("pre", "ask-preview");
      if (option.preview !== undefined) preview.textContent = option.preview;
      preview.hidden = true;
      opts.append(preview);
      previews.push(preview);
    });

    const otherLabel = el("label", "ask-other");
    otherLabel.append(el("span", "ask-mark ask-mark-other"));
    const otherInput = el("input");
    otherInput.type = "text";
    otherInput.placeholder = "Other — type your own answer";
    otherLabel.append(otherInput);
    opts.append(otherLabel);
    qEl.append(opts);
    card.append(qEl);

    const showPreview = (i: number): void => {
      const p = previews[i];
      const btn = optButtons[i];
      if (p === undefined || btn === undefined) return;
      p.hidden = !btn.classList.contains("on") || p.textContent === null || p.textContent.length === 0;
    };

    const selectSingle = (index: number | null): void => {
      optButtons.forEach((b, i) => {
        b.classList.toggle("on", i === index);
        showPreview(i);
      });
    };

    optButtons.forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (question.multiSelect === true) {
          btn.classList.toggle("on");
          showPreview(i);
        } else {
          selectSingle(i);
          otherInput.value = "";
          otherLabel.classList.remove("on");
        }
        refresh();
      });
    });
    otherInput.addEventListener("input", () => {
      otherLabel.classList.toggle("on", otherInput.value.trim().length > 0);
      if (question.multiSelect !== true && otherInput.value.trim().length > 0) selectSingle(null);
      refresh();
    });

    qEl.addEventListener("keydown", (event) => {
      if (event.target === otherInput) {
        if (event.key === "Enter" && !sendBtn.disabled) sendBtn.click();
        return;
      }
      const idx = Number(event.key) - 1;
      const target = optButtons[idx];
      if (idx >= 0 && target !== undefined) target.click();
      if (event.key === "Enter" && !sendBtn.disabled) sendBtn.click();
    });

    const answerOf = (): string => {
      const picked = optButtons
        .filter((b) => b.classList.contains("on"))
        .map((b) => b.querySelector(".ask-label")?.textContent ?? "");
      const other = otherInput.value.trim();
      if (question.multiSelect === true) {
        return other.length > 0 ? [...picked, other].join(", ") : picked.join(", ");
      }
      return other.length > 0 ? other : (picked[0] ?? "");
    };
    answerFns.push(answerOf);
    questionTexts.push(question.question);
  }

  const actions = el("div", "ask-actions");
  actions.append(el("span", "ask-why", "Waits for you. Skipping lets Claude ask in plain text."));
  const skipBtn = el("button", "ask-btn", "Skip, I'll answer in chat");
  skipBtn.type = "button";
  sendBtn = el("button", "ask-btn send", "Send answers");
  sendBtn.type = "button";
  sendBtn.disabled = true;
  actions.append(skipBtn, sendBtn);
  card.append(actions);
  refresh();

  skipBtn.addEventListener("click", () => {
    void answer(permit.id, "deny");
    renderDone(card, [], true);
  });
  sendBtn.addEventListener("click", () => {
    if (sendBtn.disabled) return;
    const answers: Record<string, string> = {};
    const rows: DoneRow[] = [];
    questionTexts.forEach((question, i) => {
      const value = answerFns[i]?.() ?? "";
      answers[question] = value;
      rows.push({ question, answer: value });
    });
    void answer(permit.id, "allow", answers);
    renderDone(card, rows, false);
  });

  return card;
}

/**
 * The compact rendering of an AskUserQuestion call in the transcript (plan
 * item 6). The CLI persists the ORIGINAL tool_use input - the `answers` that
 * `buildPermitReply` attaches travel only on the control_response wire and
 * are never written to the JSONL (verified 2026-09-25 against real
 * transcripts). So the answers come from the tool_result text, which reads
 * `... answered: "Q"="A", "Q2"="A2". ...`.
 *
 * Three states, never guessed from absence: no result yet -> "waiting" (the
 * live permit card, when it arrives over the socket, is what gets drawn in
 * its place); error result -> skipped; ok result -> the parsed pairs, or the
 * raw result text if the format ever changes. Returns null only when the
 * input is not a recognisable AskUserQuestion call, so the caller falls back
 * to the generic tool disclosure.
 */
export function parseAnswerText(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  for (const m of text.matchAll(re)) pairs.set(unescape(m[1] ?? ""), unescape(m[2] ?? ""));
  return pairs;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

export function renderAskDone(
  input: unknown,
  result: { isError: boolean; text: string } | undefined,
): HTMLElement | null {
  const questions = parseQuestions(input);
  if (questions === null) return null;
  const state = result === undefined ? "waiting" : result.isError ? "skipped" : "answered";
  // While the call is still open the live permit card is the only thing to
  // show; a summary above it just repeats the questions (the user, 2026-09-25,
  // screenshot). Hidden, not null: null would fall back to the generic tool
  // disclosure, and the reload race must never read as "skipped".
  if (state === "waiting") {
    const hold = el("div", "ask-card waiting");
    hold.hidden = true;
    return hold;
  }
  const card = el("div", `ask-card ${state}`);
  const title = state === "skipped" ? "Question skipped" : "You answered";
  card.append(el("div", "ask-head", title));
  const done = el("div", "ask-done");
  if (state === "skipped") {
    done.append(el("div", "ask-done-row ask-done-skip", "Skipped - Claude asked in the chat instead."));
  } else {
    const answers = result === undefined ? new Map<string, string>() : parseAnswerText(result.text);
    for (const q of questions) {
      const r = el("div", "ask-done-row");
      r.append(el("div", "ask-done-q", q.question));
      const a = answers.get(q.question);
      if (state === "answered") r.append(el("div", "ask-done-a", a ?? "(see Claude's reply)"));
      done.append(r);
    }
    if (state === "answered" && answers.size === 0 && result !== undefined && result.text.length > 0) {
      done.append(el("div", "ask-done-row ask-done-raw", result.text.slice(0, 600)));
    }
  }
  card.append(done);
  return card;
}
