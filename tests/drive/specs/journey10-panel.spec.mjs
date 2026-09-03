/**
 * P14 — the project panel sheds weight without lying (SPEC 88–93).
 *
 * The defect this pins is not "a row is missing" — it is a panel that has quietly hidden most of
 * itself and looks complete. So every assertion here comes in pairs: what went, and what says it
 * went. Driven as one flow because the three filters are stateful and compose — a narrowed panel
 * that stops navigating, or a focus that evaporates on reload, is invisible to any single check.
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

const row = (page, title) => page.locator(".tree-item", { hasText: title });

test("panel: finished folds away, focus narrows to one project and survives a reload", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── the resting state: two records hidden, one per axis, each announced ──────
  await expect(page.locator(".tree-item")).toHaveCount(6); // + the restore spec's record
  await expect(row(page, "Fixture finished project"), "a project that is over").toHaveCount(0);
  await expect(row(page, "Fixture dormant project"), "a project untouched for a month").toHaveCount(0);
  await expect(page.locator(".tree-more.finished")).toHaveText("+ 1 finished");
  await expect(page.locator(".tree-more.older")).toHaveText("+ 1 older");

  // ── the status axis, and it goes both ways ──────────────────────────────────
  await page.locator(".tree-more.finished").click();
  await expect(row(page, "Fixture finished project")).toHaveCount(1);
  await expect(row(page, "Fixture finished project")).toHaveClass(/status-done/);
  await expect(page.locator(".tree-more.finished")).toHaveText("fold the finished ones");
  await page.locator(".tree-more.finished").click();
  await expect(row(page, "Fixture finished project")).toHaveCount(0);

  // ── the crosshair costs no attention until it is reached for ────────────────
  const child = row(page, "Fixture child project");
  const crosshair = child.locator(".tree-focus");
  await expect(crosshair, "an unused control is invisible").toHaveCSS("visibility", "hidden");
  await child.hover();
  await expect(crosshair).toHaveCSS("visibility", "visible");

  // ── focus: the subtree, the path up to it, and nothing else ─────────────────
  await crosshair.click();
  // Filtering is not navigating. The crosshair sits on a row whose own click ENTERS the project, so
  // the centre staying put is the assertion that the two gestures are really separate.
  // One row in the open list — the chat — because nothing was entered. The strip this used to
  // count lived in the centre; the list lives in the right column now (SPEC 202).
  await expect(page.locator(".open-row"), "the crosshair filtered without entering anything").toHaveCount(1);
  await expect(row(page, "Fixture train project"), "a sibling is out of view").toHaveCount(0);
  await expect(row(page, "Fixture parent project"), "the path up is kept — a tree with a hole is not a tree").toHaveCount(1);
  await expect(child).toHaveCount(1);
  // The decision the frame made explicit, driven: focus REPLACES recency rather than stacking with
  // it, so a record untouched for a month is back the moment he says this subtree is what matters.
  await expect(row(page, "Fixture dormant project"), "focus beats the recency window").toHaveCount(1);
  await expect(page.locator(".tree-more.older"), "recency stands down, so it stops counting").toHaveCount(0);
  // The sibling AND the finished record are both outside the focus, counted once, in the axis that
  // actually removed them — while focused, "+ N finished" would be a second story about one row.
  await expect(page.locator(".tree-more.focused")).toHaveText("+ 4 outside the focus");
  await expect(page.locator(".tree-more.finished"), "nothing finished is hidden INSIDE the focus").toHaveCount(0);

  // ── the mark does not depend on the mouse: gold, and permanently on screen ──
  await page.locator("#opens").hover();
  await expect(crosshair).toHaveClass(/on/);
  await expect(crosshair, "a narrowed panel must say so with the mouse elsewhere").toHaveCSS(
    "visibility",
    "visible",
  );
  await expect(crosshair, "golden, by request").toHaveCSS("color", "rgb(200, 144, 26)");

  // ── still a panel: it navigates, and the centre is undisturbed ──────────────
  await child.click();
  await expect(page.locator("#record-body")).toContainText("Split out to prove the parent edge");
  await expect(row(page, "Fixture dormant project")).toHaveCount(1);

  // ── a filter that forgets itself is not a mode ──────────────────────────────
  // Reloading INSIDE the child: its context has no sessions yet, so the rail's status says so
  // rather than "live" — the tree coming back is what this step is waiting for.
  await page.reload();
  await expect(child, "the tree came back").toHaveCount(1, { timeout: 20_000 });
  await expect(row(page, "Fixture train project")).toHaveCount(0);
  await expect(page.locator(".tree-more.focused")).toBeVisible();

  // ── one gesture back to everything ──────────────────────────────────────────
  await page.locator(".tree-more.focused").click();
  await expect(page.locator(".tree-item")).toHaveCount(6); // + the restore spec's record
  await expect(page.locator(".tree-more.focused")).toHaveCount(0);
  await expect(page.locator(".tree-more.older")).toHaveText("+ 1 older");

  expect(errors, "no page errors across the panel flow").toEqual([]);
});

/**
 * The control is hover-revealed, and a touch rail has no hover — so on a phone it would be a
 * feature that exists and cannot be reached. Driven under real touch emulation rather than asserted
 * from the stylesheet, because `@media (hover: none)` is precisely the claim a stylesheet cannot
 * prove about itself.
 */
test.describe("on a touch rail", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("panel: the focus control is reachable with no hover to reveal it", async ({ page }) => {
    const errors = watchErrors(page);

    await page.goto("/");
    // The rail is off-canvas on a phone; this button is the only way to the tree.
    await page.locator("#rail-toggle").tap();
    const child = row(page, "Fixture child project");
    await expect(child).toHaveCount(1, { timeout: 20_000 });

    const crosshair = child.locator(".tree-focus");
    await expect(crosshair, "permanently on screen where nothing can hover").toHaveCSS("visibility", "visible");
    await crosshair.tap();
    // A tap anywhere in the tree closes the off-canvas rail, because normally a tap there means
    // "take me to that project". Filtering must not pay that price — you cannot see what you just
    // narrowed if the panel slides away as you narrow it.
    await expect(child, "the rail stayed open").toBeVisible();
    await expect(row(page, "Fixture train project")).toHaveCount(0);
    await expect(row(page, "Fixture dormant project")).toHaveCount(1);
    await expect(crosshair).toHaveClass(/on/);
    // Dimmed until chosen, full strength once in force — the touch translation of "appears when you
    // reach for it", and the assertion that the two states are still distinguishable.
    await expect(crosshair).toHaveCSS("opacity", "1");

    await page.locator(".tree-more.focused").tap();
    await expect(row(page, "Fixture train project")).toHaveCount(1);
    await expect(crosshair).toHaveCSS("opacity", "0.4");

    expect(errors, "no page errors on the touch rail").toEqual([]);
  });
});
