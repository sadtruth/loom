/**
 * P38 — Google Pro Models and Two Session Streams (SPEC google-pro-models).
 *
 * Drives the two-stream session switcher (#session-streams: Claude and Google rows)
 * and the per-session model picker (#pick-model) across full session transitions:
 * - Session streams: #row-claude and #row-google with respective glyphs and selects.
 * - Active stream has .active class, inactive is dimmed.
 * - Model picker: optgroups partitioned by family; optgroups of inactive family are disabled.
 * - Per-session model picks survive switching back and forth between sessions.
 * - Layout behaves cleanly at 320px viewport without overflow.
 */

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

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

test("google-pro-models: two session streams, family optgroups, per-session model pick tracking, and 320px responsiveness", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto(`/?project=${PROJECT_KEY}`);
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── 1. Two session streams rendered in sidebar ───────────────────────
  const sessionStreams = page.locator("#session-streams");
  await expect(sessionStreams).toBeVisible();

  const rowClaude = page.locator("#row-claude");
  const rowGoogle = page.locator("#row-google");
  await expect(rowClaude).toBeVisible();
  await expect(rowGoogle).toBeVisible();

  // Stream glyphs
  await expect(rowClaude.locator(".stream-glyph")).toHaveText("◆");
  await expect(rowGoogle.locator(".stream-glyph")).toHaveText("✦");

  // Stream selects and add buttons
  const selectClaude = page.locator("#select-claude");
  const selectGoogle = page.locator("#select-google");
  const addClaude = page.locator("#add-claude");
  const addGoogle = page.locator("#add-google");
  await expect(selectClaude).toBeVisible();
  await expect(selectGoogle).toBeVisible();
  await expect(addClaude).toBeVisible();
  await expect(addGoogle).toBeVisible();

  // Initially in Claude stream
  await expect(rowClaude).toHaveClass(/active/);
  await expect(rowGoogle).not.toHaveClass(/active/);

  // ── 2. Model picker contains groups and respects active family ────────
  const pickModel = page.locator("#pick-model");
  await expect(pickModel).toBeVisible();

  // Model optgroups exist
  const optgroups = pickModel.locator("optgroup");
  const groupCount = await optgroups.count();
  expect(groupCount, "model optgroups populated from /api/models").toBeGreaterThan(1);

  // Claude optgroups enabled, Google optgroups disabled
  const claudeGroups = pickModel.locator('optgroup[data-family="claude"]');
  const googleGroups = pickModel.locator('optgroup[data-family="google"]');
  expect(await claudeGroups.count()).toBeGreaterThan(0);
  expect(await googleGroups.count()).toBeGreaterThan(0);

  expect(await claudeGroups.first().evaluate((el) => el.disabled)).toBe(false);
  expect(await googleGroups.first().evaluate((el) => el.disabled)).toBe(true);

  // ── 3. Send turn in Claude session with custom model pick ────────────
  const composer = page.locator("#composer-text");
  await composer.fill("hello claude stream");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: hello claude stream", {
    timeout: 15_000,
  });

  const claudeSessionId = await selectClaude.inputValue();
  expect(claudeSessionId.length).toBeGreaterThan(0);
  expect(claudeSessionId).not.toBe("__pending__");

  // Switch model to haiku for this Claude session
  await pickModel.selectOption("haiku");
  await expect(pickModel).toHaveValue("haiku");
  await expect(pickModel).toHaveAttribute("data-picked", "haiku");

  // Send a second turn with haiku
  await composer.fill("turn with haiku");
  await composer.press("Enter");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: turn with haiku", {
    timeout: 15_000,
  });
  await expect(pickModel).toHaveValue("haiku");

  // ── 4. Start Google session via + button ─────────────────────────────
  await addGoogle.click();

  // Google stream is now active
  await expect(rowGoogle).toHaveClass(/active/);
  await expect(rowClaude).not.toHaveClass(/active/);
  await expect(selectGoogle).toHaveValue("__pending__");
  await expect(page.locator("#status")).toContainText("new session");

  // Model picker has switched to Google family
  await expect(pickModel).toHaveValue("g1:gemini-3.7-flash-high");
  expect(await claudeGroups.first().evaluate((el) => el.disabled)).toBe(true);
  expect(await googleGroups.first().evaluate((el) => el.disabled)).toBe(false);

  // ── 5. Switch back to Claude session and verify model pick is restored ──
  await selectClaude.selectOption(claudeSessionId);

  // Claude stream is active again
  await expect(rowClaude).toHaveClass(/active/);
  await expect(rowGoogle).not.toHaveClass(/active/);
  await expect(page.locator("#transcript-body")).toContainText("stub reply: turn with haiku", {
    timeout: 15_000,
  });

  // Model picker is restored to haiku
  await expect(pickModel, "Claude session model restored to haiku").toHaveValue("haiku");
  expect(await claudeGroups.first().evaluate((el) => el.disabled)).toBe(false);
  expect(await googleGroups.first().evaluate((el) => el.disabled)).toBe(true);

  // ── 6. Responsive 320px check ─────────────────────────────────────────
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForTimeout(200);

  const streamsBox = await sessionStreams.boundingBox();
  expect(streamsBox, "session streams bounding box").not.toBeNull();
  expect(streamsBox.width, "session streams width fits in 320px viewport").toBeLessThanOrEqual(320);
  expect(streamsBox.height, "session streams height stays around 50-60px").toBeGreaterThan(45);
  expect(streamsBox.height, "session streams height stays around 50-60px").toBeLessThanOrEqual(70);

  // Check no horizontal overflow on page
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(hasHorizontalScroll, "no horizontal page overflow at 320px").toBe(false);

  expect(errors, "no console or page errors").toEqual([]);
});
