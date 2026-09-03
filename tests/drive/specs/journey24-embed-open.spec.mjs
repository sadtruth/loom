/**
 * Every framed prototype carries the way out (SPEC 205), driven.
 *
 * SPEC 137 gave the drawer's row a full-tab escape; a prototype met in the CONVERSATION had none,
 * which User reported on 2026-08-10, 2026-08-11 and 2026-08-14. A 300px column is no place to
 * click a mockup, and the drawer only knows about prototypes it can enumerate.
 *
 * The second case is the load-bearing one: when the frame cannot draw, the link is the only route
 * left to the file, and the old error branch replaced the whole block — anchor included.
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

async function openTheMockupMessage(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();
}

test("a framed prototype offers a tab, at rest, and the tab renders it", async ({ page, context }) => {
  const errors = watchErrors(page);
  await openTheMockupMessage(page);

  const embed = page.locator(".embed").first();
  await expect(embed.locator("iframe")).toBeVisible();

  // Visible WITHOUT hovering: placement C, his call on 2026-08-10 over a hover control.
  const link = embed.locator(".embed-open");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);

  const [popup] = await Promise.all([context.waitForEvent("page"), link.click()]);
  expect(popup.url()).toContain("raw=1");
  expect(popup.url()).toContain("fixture-widget-v2-bigger-2026-08-02.html");
  // Serving is not rendering: the CSP path has to produce a document, not merely a 200.
  await expect(popup.locator("body")).toContainText("fixture widget v2, the bigger one");
  await popup.close();

  expect(errors).toEqual([]);
});

test("a frame that cannot draw keeps its way out", async ({ page }) => {
  const errors = watchErrors(page);
  await openTheMockupMessage(page);

  const broken = page.locator(".embed").filter({ has: page.locator(".embed-err") }).first();
  await expect(broken.locator(".embed-err")).toContainText("could not read");
  // The error replaces the FRAME, never the block — the anchor is what survives.
  await expect(broken.locator("iframe")).toHaveCount(0);
  const link = broken.locator(".embed-open");
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", /raw=1/);
  await expect(link).toHaveAttribute("href", /fixture-widget-shot-2026-08-02\.png/);

  expect(errors).toEqual([]);
});

test("the way out is reachable on a phone", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  // Below 700px the rail is off-canvas and `☰` is the only way to it (SPEC 188).
  await page.locator("#rail-toggle").click();
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();

  const link = page.locator(".embed .embed-open").first();
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);

  expect(errors).toEqual([]);
});
