/**
 * The previous session, carried across the seam (SPEC §Recap), driven end to end.
 *
 * A narrow assertion would prove nothing here either. The whole claim is about a SEQUENCE — press
 * the seam, type, get answered without waiting, and only then have the block arrive — so the spec
 * walks it in that order and asserts what must be true at each step. Two of the requirements are
 * claims about what must NOT happen (no turn of its own, no new car in the picker), and those are
 * the ones a one-sided check would sail past.
 * Edited 2026-08-26, SPEC 252: the #t-meta button is gone. `loom-view` still drives the render
 * (114), so meta rows are now reached by writing the key and reloading, not by clicking.
 */

import { expect, test } from "@playwright/test";

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource.*\b(400|403|404|409|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * Its OWN record, not the shared train. This spec ends by starting a real session, and a spec that
 * adds a car to a fixture other specs count is a spec that breaks them.
 */
async function enterTheRecapProject(page) {
  await page.locator(".tree-item", { hasText: "Fixture recap project" }).first().click();
  // The chat row of the open list — what `.tab-session-label` named before the layout build
  // moved the strip out of the centre (SPEC 202).
  await page.locator('.open-row[data-kind="session"]').click();
}

test("the seam carries the last session forward, without ever becoming a turn", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await enterTheRecapProject(page);

  await expect(page.locator("#row-claude")).toHaveClass(/active/);
  const carsBefore = await page.locator("#select-claude option").count();
  const projectsBefore = await page.locator(".tree-item").count();

  // Cut the seam. No session exists yet — the first send creates it — but the recap starts HERE
  // (requirement 174), which is the only way it can be ready for the FIRST message.
  await page.locator("#composer-new").click();
  await expect(page.locator(".recap")).toBeVisible({ timeout: 10_000 });

  // Requirement 181: the wait says how long it has been. He read a silent minute as a hang — *"it
  // shows for a moment the words that recap will be here but then it never appears"* — so the line
  // carries a clock, and the clock has to MOVE. Reading it once would pass on a frozen 0:00, which
  // is the version of this the screen already had.
  const waiting = page.locator(".recap.working .recap-wait");
  await expect(waiting).toContainText("usually about a minute");
  const first = await waiting.textContent();
  expect(first, "the running line carries m:ss").toMatch(/\d+:\d{2}/);
  await page.waitForTimeout(1500);
  const second = await waiting.textContent();
  expect(second, "the clock advances while the recap runs").not.toBe(first);

  // And it lands while the composer is still empty. Nothing has been sent, so nothing but the seam
  // could have started it — and this is what makes the assertion after the send mean anything.
  await expect(page.locator(".recap.working")).toHaveCount(0, { timeout: 30_000 });
  expect(await page.locator("#composer-text").inputValue()).toBe("");

  // Requirement 174: the send is never held for the recap.
  await page.locator("#composer-text").fill("right, lets build the centre column");
  await page.locator("#composer-send").click();
  await expect(page.locator(".msg.assistant").last()).toBeVisible({ timeout: 30_000 });

  // Requirement 174, the part that matters: it went out WITH THE FIRST MESSAGE, not the second.
  // The reminder is hidden on screen, so meta rows are how it is observed — this is the exact
  // assertion whose absence let a recap that arrived one message late pass as done (2026-08-13).
  // The #t-meta button is gone (SPEC 252); `loom-view` still drives the render (114), so meta rows
  // are reached by writing the key and reloading rather than clicking a button that no longer
  // exists. The session is real (it was just sent to), so a reload reads it straight off disk.
  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: false, thinking: false, meta: true, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const firstSaid = page.locator(".msg.user", { hasText: "right, lets build the centre column" }).first();
  await expect(firstSaid).toContainText("Stubbed recap of", { timeout: 15_000 });
  // Meta off again — requirement 175 below needs it off.
  await page.evaluate(() => {
    localStorage.setItem(
      "loom-view",
      JSON.stringify({ doc: false, thinking: false, meta: false, full: false }),
    );
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  const block = page.locator(".recap");
  await expect(block).toBeVisible({ timeout: 30_000 });
  // ON SCREEN, not merely in the document. `toBeVisible()` was green while the block sat 5,965px
  // above the viewport, because cutting a seam from inside an open session prepended it above that
  // car's whole history and then scrolled to the bottom (2026-08-13, found in his hands, not here).
  await expect(block).toBeInViewport({ timeout: 10_000 });
  // And it sits AFTER the seam of the session it belongs to, above his first message — the DOM order
  // the fix is about, asserted separately so a short fixture car cannot let the viewport check pass
  // by accident.
  const order = await page.evaluate(() => {
    const FOLLOWS = 4; // Node.DOCUMENT_POSITION_FOLLOWING
    const block = document.querySelector(".recap");
    const seams = [...document.querySelectorAll(".seam")];
    const lastSeam = seams[seams.length - 1] ?? null;
    const msgs = [...document.querySelectorAll(".msg")];
    return {
      hasBlock: block !== null,
      hasSeam: lastSeam !== null,
      afterLastSeam: block !== null && lastSeam !== null && (lastSeam.compareDocumentPosition(block) & FOLLOWS) !== 0,
      beforeAMessage: block !== null && msgs.some((m) => (block.compareDocumentPosition(m) & FOLLOWS) !== 0),
    };
  });
  expect(order.hasBlock && order.hasSeam, "block and seam both drawn").toBe(true);
  expect(order.afterLastSeam, "the block is below the seam of the session it belongs to").toBe(true);
  expect(order.beforeAMessage, "his first message comes after it").toBe(true);
  await expect(block).toContainText("where you left off");
  await expect(block).toContainText("State");
  await expect(block).toContainText("Open threads");

  // Requirement 175: one turn, not two. Counting assistant rows mid-turn would measure the stub's
  // intermediate frames instead — the claim is about TURNS, and a turn starts with a message of his.
  // He sent one, so there is exactly one, and nothing was asked on his behalf.
  await expect(page.locator("#status")).not.toContainText("working", { timeout: 30_000 });
  // The car he was reading stays open above the seam, so an absolute row count would be counting the
  // PREVIOUS session's messages too. The claim is about this session: he said one thing, once.
  expect(await page.locator(".msg.user", { hasText: "right, lets build the centre column" }).count()).toBe(1);

  // Requirement 175: it is context, not a message — with meta off his turn does not show it. Scoped
  // to HIS rows on purpose: the stub answers by quoting its whole prompt back, so an unscoped
  // assertion here measures the stub's echo rather than the renderer (found 2026-08-13).
  const leaked = await page.locator(".msg.user", { hasText: "Stubbed recap of" }).allInnerTexts();
  expect(leaked, "the recap must not be readable in his message with meta off").toEqual([]);

  // Requirement 177: the recap child is neither a car nor a project. The second half matters
  // because `server/projects.ts` enumerates the store ROOT, so a child spawned anywhere under it
  // shows up in the tree as a project nobody made.
  expect(await page.locator("#select-claude option").count()).toBe(carsBefore + 1);
  expect(await page.locator(".tree-item").count()).toBe(projectsBefore);

  // Requirement 176: refusable, and the refusal outlives a reload.
  await block.locator(".recap-x").click();
  await expect(block).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".recap")).toHaveCount(0);

  expect(errors).toEqual([]);
});
