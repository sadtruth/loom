/**
 * P39 — Return to session from project page.
 *
 * Drives the return-to-session journey:
 * - Create a new project record (lands on the project record page).
 * - Start a session in it on a Claude model (fable) and send a turn from the project page.
 * - Verify the turn is answered while on the project page.
 * - Click the session stream row on the project page to enter the session.
 * - Assert the session opens and its turns render.
 * - Leave the session to the project record page again.
 * - Click the stream glyph icon to enter the session.
 * - Assert the session opens and its turns render.
 */

import { expect, test } from "@playwright/test";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SLOT = process.env["LOOM_PINS"] ?? "";
function recordsDir(testInfo) {
  const index = testInfo?.parallelIndex ?? Number(process.env["TEST_PARALLEL_INDEX"] ?? 0);
  const slotName = `.records${SLOT !== "" ? `-${SLOT}` : ""}-w${index}`;
  return join(fileURLToPath(new URL("../../..", import.meta.url)), "tests", "fixture", slotName);
}

test.afterAll(async ({}, testInfo) => {
  const dir = recordsDir(testInfo);
  for (const slug of ["journey39-project"]) {
    await rm(join(dir, slug), { recursive: true, force: true });
  }
  await new Promise((resolve) => setTimeout(resolve, 2_200));
});

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

test("journey39: create project, start session, leave to project page, click row to return to session", async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // 1. Create a project record (lands on project record page)
  await page.locator(".tree-more.create").click();
  const rootInput = page.locator(".tree-input input");
  await expect(rootInput).toBeFocused();
  await rootInput.fill("journey39-project");
  await rootInput.press("Enter");

  const recordOpen = page.locator(".open-row[data-kind='record']");
  await expect(recordOpen).toContainText("journey39-project", { timeout: 10_000 });
  await expect(page.locator("#record-body")).toBeVisible();
  await expect(page.locator("#chat-area")).toBeHidden();

  // 2. Select model fable and start a session with one turn from the composer under the record
  const pickModel = page.locator("#pick-model");
  await pickModel.selectOption("fable");

  const composer = page.locator("#composer-text");
  await composer.fill("hello from journey39");
  await composer.press("Enter");

  // Wait for session to be adopted and reply to be received
  const selectClaude = page.locator("#select-claude");
  await expect(selectClaude).not.toHaveValue("__pending__", { timeout: 15_000 });
  await expect(selectClaude).not.toHaveValue("", { timeout: 15_000 });

  // Verify we are still on the project record page
  await expect(recordOpen).toHaveClass(/on/);
  await expect(page.locator("#record-body")).toBeVisible();
  await expect(page.locator("#chat-area")).toBeHidden();

  // 3. Return via clicking the session stream row
  const rowClaude = page.locator("#row-claude");
  await rowClaude.click();

  // Assert the session opens and its turns render
  await expect(page.locator("#chat-area"), "chat-area visible after clicking session row").toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator("#record-body")).toBeHidden();
  await expect(rowClaude).toHaveClass(/active/);
  await expect(page.locator("#transcript-body")).toContainText("hello from journey39");
  await expect(page.locator("#transcript-body")).toContainText("stub reply: hello from journey39");

  // 4. Leave to project record page again and return via clicking the stream glyph
  await recordOpen.click();
  await expect(page.locator("#record-body")).toBeVisible();
  await expect(page.locator("#chat-area")).toBeHidden();

  await page.locator("#row-claude .stream-glyph").click();
  await expect(page.locator("#chat-area"), "chat-area visible after clicking stream glyph").toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator("#record-body")).toBeHidden();
  await expect(page.locator("#transcript-body")).toContainText("hello from journey39");

  expect(errors, "no console or page errors").toEqual([]);
});
