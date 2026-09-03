/**
 * A plan that SHOWS what it is about, driven end to end (SPEC 165–168).
 *
 * User, 2026-08-11: *"This is a subproject about adding icons and nowhere in the build plan do
 * you show the icons themselves."* The block drew text, tables and chips; a prototype was a link
 * out of the document he was deciding in.
 *
 * This is also the plan block's FIRST driven case (build-plan record, item 9). Everything it had
 * was parser properties, and four visible defects survived a green suite twice — so the assertions
 * here are about what is on screen, at a real size, not about what a function returned.
 */

import { expect, test } from "@playwright/test";

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The failure case in the fixture is a picture that does not exist: its 404 is the point.
    if (/Failed to load resource.*\b(403|404|413|415)\b/.test(message.text())) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** Open the fixture record's session that carries the plan fence. */
async function openThePlan(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator('.open-row[data-kind="record"]')).toContainText("Fixture parent project");
  await expect(page.locator("#chat-area")).toBeVisible();
  const plan = page.locator(".rich-plan .plan").first();
  await expect(plan).toBeVisible({ timeout: 20_000 });
  return plan;
}

test("the prototype runs, the visual is drawn, and a missing one says so", async ({ page }) => {
  const errors = watchErrors(page);
  const plan = await openThePlan(page);

  // ── place 1: the prototype is the page itself, not a link to it ──
  const frame = plan.locator(".plan-pic iframe").first();
  await expect(frame).toBeVisible();
  await expect
    .poll(async () => (await frame.boundingBox())?.height ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(40);
  // It RUNS: the framed document's own text is on screen inside it.
  await expect(frame.contentFrame().locator("body")).toContainText("fixture widget v2");
  // …and the chip that used to be the only thing here is still under it.
  await expect(plan.locator(".plan-sec", { hasText: "Prototype" }).locator(".chip")).toBeVisible();

  // ── place 2: an object's visual — an SVG, which is the format that
  //    comes back as JSON without `raw=1` (SPEC 166) ───────────────
  const svg = plan.locator(".plan-item", { hasText: "The picture that loads" }).locator("img.embed-img");
  await expect(svg).toBeVisible();
  const drawn = await svg.evaluate((img) => ({
    natural: img.naturalWidth,
    width: img.getBoundingClientRect().width,
    type: img.currentSrc.includes("raw=1"),
  }));
  expect(drawn.natural).toBeGreaterThan(0); // a JSON document decodes to nothing
  expect(drawn.width).toBeGreaterThan(0);
  expect(drawn.type).toBe(true);

  // ── place 3: a paragraph that is only an image ───────────────────
  const paragraph = plan.locator(".plan-sec", { hasText: "Log" }).locator("img.embed-img");
  await expect(paragraph).toBeVisible();
  await expect(plan.locator(".plan-cap", { hasText: "the tile" })).toBeVisible();
  // The line above it stayed its own paragraph rather than swallowing the image, and no markdown
  // source is left on screen — the two ways this can go wrong.
  const log = plan.locator(".plan-sec", { hasText: "Log" });
  await expect(log).toContainText("The third place is a paragraph");
  expect(await log.innerText()).not.toContain("![");

  // ── the failure: a picture that is not there names the path ──────
  const missing = plan.locator(".plan-item", { hasText: "The picture that is not there" });
  await expect(missing.locator(".embed-err")).toContainText("gone-2026-08-11.png", { timeout: 15_000 });
  // …and the rest of the document still reads.
  await expect(plan.locator(".plan-item", { hasText: "The picture that loads" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("the pictures survive a redraw and never widen his column", async ({ page }) => {
  const errors = watchErrors(page);
  const plan = await openThePlan(page);
  const svg = plan.locator(".plan-item", { hasText: "The picture that loads" }).locator("img.embed-img");
  await expect(svg).toBeVisible();
  await expect.poll(async () => svg.evaluate((img) => img.complete)).toBe(true);

  // ── the transcript redraws in full on every change. A picture rebuilt each time refetches and
  //    flashes through zero height (SPEC 168) — so the node must be the SAME node afterwards.
  await svg.evaluate((img) => {
    img.dataset["pinMark"] = "1";
  });
  // A real redraw, the way one happens: leave the transcript for the record and come back.
  await page.locator('.open-row[data-kind="record"]').first().click();
  await expect(page.locator("#record-body")).toBeVisible();
  await page.locator('.open-row[data-kind="session"]').click();
  const again = page.locator(".plan-item", { hasText: "The picture that loads" }).locator("img.embed-img");
  await expect(again).toBeVisible();
  expect(await again.evaluate((img) => img.dataset["pinMark"] ?? "")).toBe("1");

  // ── his real column: 300px wide, nothing cut off, nothing sideways ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const fits = await plan.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const wide = [...node.querySelectorAll("img.embed-img, iframe")].map((el) => ({
      w: el.getBoundingClientRect().width,
      over: el.getBoundingClientRect().width > box.width + 1,
    }));
    return { scrolls: node.scrollWidth > node.clientWidth + 1, wide };
  });
  expect(fits.scrolls).toBe(false);
  expect(fits.wide.every((one) => !one.over)).toBe(true);
  expect(fits.wide.every((one) => one.w > 0)).toBe(true);

  expect(errors).toEqual([]);
});
