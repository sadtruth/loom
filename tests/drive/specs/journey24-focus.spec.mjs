/**
 * What the WRITER is in the middle of survives what the session is doing.
 *
 * User, 2026-08-14: *"i keep losing focus from the session input field if im trying to write a
 * message while you're working - fix this immediately - its a terrible bug"*. Since SPEC 199 the
 * composer is the last element of the transcript's own scroller, and the transcript is a full
 * redraw per change — so `replaceChildren` DETACHED the focused textarea and appended it back.
 * Taking the focused element out of the document blurs it, and putting the same node back does not
 * give focus back: every append frame of a running turn threw the caret out of a half-typed message.
 *
 * The sibling of journey2-input's disclosure test (SPEC 146), one layer stricter: a `<details>`
 * needed its state carried through the redraw, the composer needs to not be TOUCHED by it.
 *
 * Driven, never dispatched: a real turn runs, real frames land, and the assertion is on
 * `document.activeElement` and the caret while they do.
 */

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** Same rule as escapeCwd in server/input.ts — inlined because .mjs cannot import the .ts. */
const LOOM_ROOT = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const PROJECT_KEY = LOOM_ROOT.replace(/[^A-Za-z0-9-]/g, "-");

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource.*\b(403|404|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Where the caret is, and what has focus, read from the page rather than inferred. */
function writingState(page) {
  return page.evaluate(() => {
    const box = document.getElementById("composer-text");
    return {
      focused: document.activeElement === box,
      active: document.activeElement === null ? null : document.activeElement.id || document.activeElement.tagName,
      value: box.value,
      caret: box.selectionStart,
      selectionEnd: box.selectionEnd,
      attached: box.isConnected,
    };
  });
}

test("the composer keeps focus and the caret through the redraws of a running turn", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composer = page.locator("#composer-text");

  // ── a turn is running: the stub's "slow one" holds it open for ~6s and writes real frames ──
  await composer.fill("slow one to redraw underneath");
  await composer.press("Enter");
  await expect(page.locator("#composer-stop"), "a turn is genuinely in flight").toBeVisible({ timeout: 15_000 });

  // ── he starts typing the follow-up, and puts the caret back into the middle of it ──
  await composer.click();
  await page.keyboard.type("half typed follow-up");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  const before = await writingState(page);
  expect(before.focused, "the box has focus before the redraw").toBe(true);
  expect(before.value).toBe("half typed follow-up");
  expect(before.caret, "and the caret is where he left it").toBe("half typed follow-up".length - 3);

  // ── the frames land underneath him. THIS is the bug's own cause ──
  // The user row first (one redraw), then the reply (several more, and the working row appearing
  // and going away with them).
  await expect(page.locator("#transcript-body")).toContainText("slow one to redraw underneath", {
    timeout: 15_000,
  });
  const midTurn = await writingState(page);
  expect(midTurn.active, "mid-turn, focus is still in the composer").toBe("composer-text");
  expect(midTurn.attached, "and the box is the same one, never detached").toBe(true);
  expect(midTurn.value, "with the half-typed message intact").toBe("half typed follow-up");
  expect(midTurn.caret, "and the caret unmoved").toBe(before.caret);

  await expect(page.locator("#transcript-body")).toContainText("stub reply: slow one to redraw underneath", {
    timeout: 40_000,
  });
  const afterTurn = await writingState(page);
  expect(afterTurn.active, "and once the turn has finished redrawing").toBe("composer-text");
  expect(afterTurn.value).toBe("half typed follow-up");
  expect(afterTurn.caret).toBe(before.caret);
  expect(afterTurn.selectionEnd).toBe(before.caret);

  // He can still finish the sentence where the caret sits — the point of keeping it.
  await page.keyboard.type("XYZ");
  await expect(composer).toHaveValue("half typed followXYZ-up");

  expect(errors, "no page errors while typing through a running turn").toEqual([]);
});

/**
 * Everything focusable in the composer, not only the textarea: the pickers and the mode toggle sat
 * in the same detached subtree, so a redraw closed a select the moment it was reached for.
 */
test("the model picker also keeps focus while a turn redraws", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composer = page.locator("#composer-text");
  await composer.fill("slow one with a picker in hand");
  await composer.press("Enter");
  await expect(page.locator("#composer-stop")).toBeVisible({ timeout: 15_000 });

  await page.locator("#pick-model").focus();
  expect(await page.evaluate(() => document.activeElement.id)).toBe("pick-model");

  await expect(page.locator("#transcript-body")).toContainText("stub reply: slow one with a picker in hand", {
    timeout: 40_000,
  });
  expect(
    await page.evaluate(() => document.activeElement.id),
    "the picker survives the turn's redraws",
  ).toBe("pick-model");

  expect(errors, "no page errors").toEqual([]);
});

/**
 * The two-sided half. "Never touch the tail" must not become "never redraw": the messages still
 * have to arrive, in order, above the composer — and the composer still has to be the LAST element
 * of the scroller after every redraw (SPEC 199), or the fix bought focus by breaking the layout.
 */
test("the redraw still delivers messages, and the composer is still last", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const composer = page.locator("#composer-text");
  await composer.fill("hello after the fix");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: hello after the fix", {
    timeout: 20_000,
  });

  const tail = await page.evaluate(() => {
    const body = document.getElementById("transcript-body");
    const kids = [...body.children];
    return {
      last: kids[kids.length - 1]?.id ?? null,
      secondLast: kids[kids.length - 2]?.id ?? null,
      composerCount: body.querySelectorAll("#composer").length,
      messages: body.querySelectorAll(".msg").length,
    };
  });
  expect(tail.last, "the composer is the last element of the scroller").toBe("composer");
  expect(tail.secondLast, "with its spacer immediately above it").toBe("composer-anchor");
  expect(tail.composerCount, "and there is exactly one of it").toBe(1);
  expect(tail.messages, "messages still render").toBeGreaterThan(0);

  expect(errors, "no page errors").toEqual([]);
});
