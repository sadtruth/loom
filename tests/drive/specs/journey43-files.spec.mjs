/**
 * The FILES tab, driven in a browser (SPEC 138–142).
 *
 * This spec exists because the tab shipped with no browser test at all. The property tests cover
 * `sections`/`visibleCount` and `mergeOrigins`, all of which were correct — both defects were in the
 * wiring around them: the endpoint assembled the wrong train, and the pin button had no CSS. A
 * pure-function test cannot see either, so the pins have to be driven against the rendered DOM.
 *
 * Two things are pinned here, and they are the two User reported on 2026-09-05:
 *
 *   1. The list is the RECORD's files, not every file every session in the core ever named. The
 *      failing version listed 1898, fed by 362 sessions.
 *   2. The pin star is an affordance, not information. It is invisible at rest, appears on hover,
 *      and stays lit once ON — because there the ★ IS the information.
 *
 * And the counter, which the frame calls out by name: the number in the tab and the number in each
 * heading are read off the SAME rows the panel rendered, so a count that disagrees with the list
 * fails here.
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

const opacityOf = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity);

test("the files tab lists the record's own files, and the pin only shows on hover", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });

  // ── the parent record, whose one session names a pile of real paths ──────
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await page.locator("#drawer-files").click();
  await expect(page.locator("#drawer-files")).toHaveClass(/on/);

  const rows = page.locator("#drawer-body .art");
  await expect(rows.first()).toBeVisible();

  // ── the tab's number is the rows it rendered ───────────────────────────
  const shown = await rows.count();
  await expect(page.locator("#drawer-count")).toHaveText(String(shown));

  // ── and so is every heading's ─────────────────────────────────────
  const groups = page.locator("#drawer-body .art-group");
  const groupCount = await groups.count();
  for (let i = 0; i < groupCount; i += 1) {
    const group = groups.nth(i);
    const heading = group.locator("h4");
    if ((await heading.count()) === 0) continue; // a folded band renders a "+ N code" button instead
    const text = await heading.textContent();
    const claimed = Number(/(\d+)\s*$/.exec(text)?.[1] ?? -1);
    expect(claimed, `heading "${text}" states a number`).toBeGreaterThanOrEqual(0);
    expect(await group.locator(".art").count(), `heading "${text}" agrees with its rows`).toBe(claimed);
  }

  // ── the list is THIS record's, and it is a list a person can read ──────────
  // The defect was a panel fed by every session in the core store. The fixture parent names a few
  // dozen paths; a four-figure list means the train collapsed to the whole core again.
  expect(shown, `the panel shows ${shown} files — that is a core dump, not a project`).toBeLessThan(300);

  // ── the pin is invisible until the pointer is on the row ─────────────────
  const first = rows.first();
  const pin = first.locator(".art-pin");
  await expect(pin).toHaveCount(1);
  expect(await opacityOf(pin), "a star is not sitting on every row at rest").toBe("0");

  await first.hover();
  await expect.poll(() => opacityOf(pin), { message: "hovering the row offers the pin" }).toBe("1");

  // ── pinning lights it, and it survives the pointer leaving ───────────────
  const pinnedPath = await first.getAttribute("data-path");
  await pin.click();

  const pinnedRow = page.locator("#drawer-body .art").filter({ has: page.locator(".art-pin.on") }).first();
  await expect(pinnedRow.locator(".art-pin")).toHaveText("★");
  expect(await pinnedRow.getAttribute("data-path"), "the row that lit is the row that was clicked").toBe(pinnedPath);

  // A pinned row is its own group, above the bands.
  await expect(page.locator("#drawer-body .art-group").first().locator("h4")).toContainText("Pinned");

  await page.locator("#drawer-body .art-group").first().locator("h4").hover(); // pointer off the row
  expect(
    await opacityOf(pinnedRow.locator(".art-pin")),
    "a pinned file still says so with nothing hovered",
  ).toBe("1");

  // ── and it comes back off ───────────────────────────────────────
  await pinnedRow.locator(".art-pin").click();
  await expect(page.locator("#drawer-body h4").first()).not.toContainText("Pinned");

  expect(errors, "no console errors driving the files tab").toEqual([]);
});
