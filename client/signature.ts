/**
 * Is this turn the same turn? — the one question SPEC 211 rests on, with no DOM in it.
 *
 * Kept out of `render.ts` for the reason `hiddenReminder` is: `bun test` has no `document`, and a
 * rule only checkable in a browser gets checked less often than one that is not. This is the
 * function whose failure mode is STALE CONTENT on his screen, so it is the one that most needs
 * properties hunting for cases nobody imagined.
 */

import type { Message, RenderOptions } from "./render.ts";
import { turnCostLabel } from "./turn-cost.ts";

/**
 * A piece of text, small enough to compare every frame and specific enough to notice a change.
 *
 * NOT a hash: the signature is computed for every turn on every frame, and hashing a 20 000-character
 * tool result across a 350-turn session twice a second buys precision this does not need. What it
 * needs instead is to be STATED, because three documents claimed more than the code delivered
 * (reviewer, 2026-08-14) — a `tool_result`'s text was carried as its length alone.
 *
 * The bound: **a transcript is append-only.** A tool result does not change once it has arrived, and
 * an assistant's text block only grows at the end. So length-plus-both-ends is not a guess about
 * likely edits — it is exact for the way this content actually changes. The single shape it cannot
 * see is a block replaced in place by different text of the same length sharing its first and last
 * 48 characters, which the JSONL a transcript is read from does not produce.
 */
export function mark(text: string): string {
  return text.length <= 96 ? text : `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
}

/**
 * Everything `renderTurn` reads, as one string — so a redraw can tell a turn that would come out
 * IDENTICAL from one that has changed, and leave the identical one alone (SPEC 211).
 *
 * This has to be honest in one direction only, and the honest direction is the expensive one: a
 * signature that changes when the output would not costs a rebuild nobody sees, while a signature
 * that stays put when the output would differ is stale content on his screen — the one class of bug
 * a read-only viewer has no excuse for. Every input the renderer reads is in here, each through
 * `mark` — read its note for the exact bound, which is narrower than "every byte" and is stated
 * rather than implied.
 */
export function turnSignature(turn: readonly Message[], options: RenderOptions): string {
  // The cost figure is drawn from `options.scale`, which moves on every `/api/bar` poll while the
  // turn itself never changes again — so the RENDERED text has to ride in the signature or the
  // reconcile leaves a stale percentage on an unchanged row. The text and not `scale` itself: raw
  // `scale` changes every poll and would redraw every turn in the session twice a minute, which is
  // the cost journey29's p95 guard exists to notice.
  const cost = turnCostLabel(turn, options.scale ?? 0);
  const parts: string[] = [
    options.stamp,
    options.showMeta === true ? "M" : "m",
    options.showThinking ? "T" : "t",
    options.pinned ? "P" : "p",
    cost === null ? "$-" : `$${cost.text}${cost.loud ? "!" : ""}`,
  ];
  for (const message of turn) {
    parts.push(message.uuid, message.endsTurn === true ? "end" : "-", message.isMeta ? "meta" : "-");
    for (const block of message.blocks) {
      const text = block.text ?? "";
      if (block.kind === "text" || block.kind === "thinking") {
        parts.push(`${block.kind}${mark(text)}`);
      } else if (block.kind === "tool_use") {
        const result = block.id === undefined ? undefined : options.results.get(block.id);
        const answer =
          result === undefined ? "-" : `${result.isError === true ? "E" : "R"}${mark(result.text ?? "")}`;
        // The NAME and the input too: a call's summary line is drawn from them.
        parts.push(`use${block.id ?? ""}:${block.name ?? ""}:${mark(JSON.stringify(block.input ?? null))}:${answer}`);
      } else if (block.kind === "tool_result") {
        parts.push(`res${block.forId ?? ""}:${mark(text)}`);
      } else {
        parts.push(`img${block.mediaType ?? ""}:${mark(block.data ?? "")}`);
      }
    }
  }
  return parts.join("|");
}

