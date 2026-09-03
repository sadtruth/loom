/**
 * A link is a link because of what it SAYS — SPEC 223.
 *
 * User, 2026-08-19: *"Sometimes a link is parsed out of my own messages erroneously, check that
 * too. It's usually when i copy something out of a terminal window into chat"*, and then, on the
 * first attempt at a fix: *"i think you should show the link as the link only based on the text of
 * the link, not on the access to it - dont ask the disk"*.
 *
 * That second sentence is why this file checks text rules and not a resolver. Asking the filesystem
 * made a chip depend on which machine loom happened to run on — wrong for a man reading his own
 * transcripts from four devices — and cost a round trip per message.
 *
 * The four shapes below all used to produce a clickable link to nothing. The last is the one text
 * alone cannot settle — a space inside the FINAL segment ends the path in "see /home/user/docs and
 * go" and belongs to it in ".../Projects/Personal Claude". It is settled from the record list loom
 * already holds in memory, never by a lookup, and the fixture uses loom's own directory because that
 * path really does carry the space User's whole vault carries.
 *
 * Scoped per LINE. A `.msg` filtered by text also matches the containers wrapping it, so counts
 * taken at that scope silently include chips from other messages.
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

/** One rendered line of the kinds message. Each fixture line is its own paragraph. */
function line(page, text) {
  return page.locator("p", { hasText: text }).last();
}

test("a link is decided by its text, and pasted terminal noise is not one", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();
  await expect(line(page, "Two records:").locator(".chip").first()).toBeVisible({ timeout: 20_000 });

  // 1 · two paths separated by one space are two chips, never one.
  // The old walk read the trailing space of `…/loom-fixture-parent ` as part of a directory name —
  // right for `Personal Claude/tools`, wrong here — and produced one chip spanning both.
  const two = line(page, "Two paths, one space:");
  await expect(two.locator(".chip")).toHaveCount(2);
  await expect(two.locator('.chip[data-raw*="loom-fixture-parent "]')).toHaveCount(0);

  // 2 · a shell prompt does not drag its punctuation into the link.
  const prompt = line(page, "A prompt:");
  await expect(prompt.locator('.chip[data-raw$="$"]')).toHaveCount(0);
  // Two-sided: the path itself is still a chip. The fix is a boundary, not a refusal.
  await expect(prompt.locator('.chip[data-raw^="~/"]')).toHaveCount(1);

  // 3 · a shell operator ends the path.
  const unquoted = line(page, "An unquoted command:");
  await expect(unquoted.locator('.chip[data-raw*="&&"]')).toHaveCount(0);
  await expect(unquoted.locator(".chip")).toHaveCount(1);

  // 4 · and the space inside the last segment is settled by a directory loom knows.
  // A segment walk cuts `…/Projects/Personal Claude/tools/loom` at the space and yields
  // `…/Projects/Personal`, a link to nothing. The known-directory rule puts the name back — from the
  // records already loaded, with no request and no disk.
  await expect(unquoted.locator('.chip[data-raw$="/tools/loom"]')).toHaveCount(1);
  await expect(unquoted.locator('.chip[data-raw$="/Projects/Personal"]')).toHaveCount(0);

  // The kinds that already worked still work — without this a build that made no chips would pass.
  await expect(line(page, "Two records:").locator(".chip.rec")).toHaveCount(2);
  await expect(line(page, "Two notes with one name:").locator(".chip")).toHaveCount(2);
  await expect(line(page, "A line:").locator(".chip")).toHaveCount(1);
  await expect(line(page, "A heading:").locator(".chip")).toHaveCount(1);

  // And the chip still OPENS.
  await unquoted.locator(".chip").first().click();
  await expect(page.locator("#file-body")).toContainText("ARCHITECTURE.md", { timeout: 20_000 });

  expect(errors).toEqual([]);
});
