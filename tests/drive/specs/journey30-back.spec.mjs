/**
 * Browser Back returns to a real place, without reloading — SPEC 222.
 *
 * User, 2026-08-19: *"going back in browser history often doesnt work and leaves me on a broken
 * page with just the input field"*.
 *
 * Two causes, and this file drives both. `popstate` was `location.reload()`, so every press threw
 * away the socket, the transcript and the reader's place. And `pushUrl` pushed from all nine of its
 * call sites — `applyCentre` among them — so ONE project click left three or four entries and Back
 * walked into the middle of a move instead of out of it. The "broken page" is a half-applied state
 * that the history had recorded as though it were somewhere you had been.
 *
 * The load-bearing assertion is the SENTINEL: a value written into the page before the first click
 * must survive every Back. It cannot survive a reload, so it is the one check that can tell
 * "restored in place" from "rebuilt from scratch, and happened to look similar".
 */

import { expect, test } from "@playwright/test";

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

const sentinel = (page) => page.evaluate(() => window.__backSentinel ?? null);

/** The project the screen — not the address — currently says it is in. */
const currentRow = (page) =>
  page.evaluate(() => document.querySelector(".tree-item.current")?.getAttribute("data-record") ?? null);

test("back walks places, one per click, without reloading the page", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    window.__backSentinel = "alive";
  });
  expect(await sentinel(page), "the sentinel is set before anything moves").toBe("alive");

  const rows = page.locator(".tree-item[data-record]");
  expect(await rows.count(), "the fixture tree has at least two records").toBeGreaterThan(1);

  const first = await rows.nth(0).getAttribute("data-record");
  const second = await rows.nth(1).getAttribute("data-record");
  expect(first).not.toBe(second);

  // ── ONE history entry per gesture ──────────────────────────────────
  //
  // Counted by walking back and checking how many presses it takes to undo one click. The old build
  // needed three or four, and every intermediate one showed a half-applied screen.
  await rows.nth(0).click();
  await expect.poll(() => currentRow(page), { timeout: 10_000 }).toBe(first);
  await page.waitForTimeout(800);

  await rows.nth(1).click();
  await expect.poll(() => currentRow(page), { timeout: 10_000 }).toBe(second);
  await page.waitForTimeout(800);

  await page.goBack();
  await expect.poll(() => currentRow(page), { timeout: 10_000 }).toBe(first);

  // ── and it did not reload ──────────────────────────────────────────
  expect(await sentinel(page), "back restored in place rather than reloading").toBe("alive");

  // ── the page is USABLE, not a bare composer ────────────────────────
  //
  // This is the actual complaint. A centre must be showing something: either the transcript with
  // its messages, or the record with its work items — never a composer over nothing.
  const usable = await page.evaluate(() => {
    const chat = document.querySelector("#chat-area");
    const record = document.querySelector("#record-body");
    const transcript = document.querySelector("#transcript-body");
    const chatUp = chat !== null && !chat.hidden && chat.offsetParent !== null;
    const recordUp = record !== null && !record.hidden && record.offsetParent !== null;
    return {
      chatUp,
      recordUp,
      messages: transcript === null ? 0 : transcript.childElementCount,
      recordText: record === null ? 0 : (record.textContent ?? "").trim().length,
    };
  });
  expect(usable.chatUp || usable.recordUp, "some centre is showing").toBe(true);
  expect(
    usable.chatUp ? usable.messages > 0 : usable.recordText > 0,
    `the centre has content, not an empty composer: ${JSON.stringify(usable)}`,
  ).toBe(true);

  // ── forward works too, and still does not reload ───────────────────
  await page.goForward();
  await expect.poll(() => currentRow(page), { timeout: 10_000 }).toBe(second);
  expect(await sentinel(page), "forward restored in place too").toBe("alive");

  expect(errors).toEqual([]);
});
