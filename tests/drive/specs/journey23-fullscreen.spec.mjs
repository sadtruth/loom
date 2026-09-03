/**
 * `f` takes the whole window, and the record's rows use the column they are given (SPEC 193–195).
 *
 * Two things on the same screen, both from him looking at the built layout: *"not all things used
 * the full horizontal space, for instance tasks and hypothesis"*, and *"pressing f to toggle
 * fullscreen ... And also when pressed again - the panels return."*
 *
 * Driven at 1600px, because both requirements are about a WIDE window: at 1000px a 76ch cap and the
 * column are nearly the same number and the width check could not tell them apart.
 *
 * Everything here asserts MEASURED width, never the presence of a class. A class that styles
 * nothing would pass a class assertion, and the CSS it depends on sits at the foot of the file
 * where source order is the only thing beating the narrow-window overlays.
 */

import { expect, test } from "@playwright/test";

const WIDE = { width: 1600, height: 900 };

/** Open the parent record — the one fixture record carrying BOTH a task list and a hypothesis list. */
async function openParentRecord(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  const row = page.locator('.open-row[data-kind="record"]', { hasText: "Fixture parent project" });
  await row.click();
  await expect(page.locator("#record-body")).toBeVisible();
}

const widthOf = (page, selector) =>
  page.locator(selector).first().evaluate((node) => node.getBoundingClientRect().width);

test("the record's tasks and hypotheses run the full column, not 76ch", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await openParentRecord(page);

  // The column the record is drawn in. At 1600px this is ~1030px; 76ch is ~609px, so the two are
  // 400px apart and no rounding can confuse them.
  const column = await page.locator("#record-body").evaluate((node) => {
    const style = getComputedStyle(node);
    return node.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  });
  expect(column, "the fixture window must give the record a wide column, or there is nothing to measure").toBeGreaterThan(
    900,
  );

  for (const selector of ["#record-body .tasks", "#record-body .hypos"]) {
    const width = await widthOf(page, selector);
    expect(width, `${selector} is ${Math.round(width)}px inside a ${Math.round(column)}px column`).toBeGreaterThan(
      column - 4,
    );
  }

  // The DRAWER's copies of the same component must be untouched — otherwise this test cannot tell
  // "the cap came off the centre" from "everything got wider", which is a regression wearing the
  // fix's clothes. The right column is 300px, so its rows are far from the centre's number.
  const drawerTasks = page.locator("#drawer .tasks");
  if ((await drawerTasks.count()) > 0) {
    const width = await drawerTasks.first().evaluate((node) => node.getBoundingClientRect().width);
    expect(width, "the drawer's task rows must stay in the 300px column").toBeLessThan(320);
  }
});

test("f hides both side columns; f again brings them back", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  const railBefore = await widthOf(page, "#side");
  const drawerBefore = await widthOf(page, "#drawer");
  const centreBefore = await widthOf(page, "#transcript");
  expect(railBefore, "the rail must be on screen first, or the toggle proves nothing").toBeGreaterThan(100);
  expect(drawerBefore, "the right column must be on screen first").toBeGreaterThan(100);

  await page.locator("body").press("f");

  expect(await widthOf(page, "#side"), "the rail is still taking width").toBe(0);
  expect(await widthOf(page, "#drawer"), "the right column is still taking width").toBe(0);
  const centreFull = await widthOf(page, "#transcript");
  expect(centreFull, "the centre did not grow into the space the columns left").toBeGreaterThan(
    centreBefore + railBefore + drawerBefore - 4,
  );
  // The handles go with the columns: a strip offering to reopen a panel a mode has taken away lies.
  await expect(page.locator("#drawer-reopen")).toBeHidden();

  await page.locator("body").press("f");

  expect(await widthOf(page, "#side"), "the rail did not come back").toBeCloseTo(railBefore, 0);
  expect(await widthOf(page, "#drawer"), "the right column did not come back").toBeCloseTo(drawerBefore, 0);
  expect(await widthOf(page, "#transcript"), "the centre did not give the width back").toBeCloseTo(centreBefore, 0);
});

test("f typed into a task title types the letter and does not toggle", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await openParentRecord(page);

  const title = page.locator("#record-body .task").first().locator(".task-title");
  await title.click();
  const field = page.locator("#record-body .task").first().locator(".task-title-edit");
  await expect(field).toBeVisible();
  const before = await field.inputValue();
  await field.press("End");
  await field.press("f");

  expect(await field.inputValue(), "the letter did not reach the field").toBe(`${before}f`);
  expect(
    await widthOf(page, "#side"),
    "a letter typed into a field reorganised the screen — this is the trap the guard exists for",
  ).toBeGreaterThan(100);

  await field.press("Escape"); // leave the fixture record as it was found
});

test("Ctrl+F is left to the browser", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  const railBefore = await widthOf(page, "#side");

  await page.locator("body").press("Control+f");

  expect(await widthOf(page, "#side"), "Ctrl+F toggled fullscreen instead of reaching find").toBeCloseTo(railBefore, 0);
});

test("fullscreen survives a reload", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  await page.locator("body").press("f");
  expect(await widthOf(page, "#side")).toBe(0);

  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  expect(await widthOf(page, "#side"), "the reload put the panels back — 195 says it must not").toBe(0);
  expect(await widthOf(page, "#drawer")).toBe(0);

  // Leave the browser profile as it was found: this key is device-local and persists across specs.
  await page.locator("body").press("f");
  expect(await widthOf(page, "#side")).toBeGreaterThan(100);
});

/**
 * ⚠ Read this before trusting it. This case pins that the toggle does not move the reader, and it is
 * real in that direction — but it did NOT redden when `resyncDock()` was removed from
 * `setFullscreen` (mutation run, 2026-08-13). A relayout that clamps `scrollTop` fires a scroll
 * event, and the scroll listener re-takes the dock decision by itself, so the explicit resync is
 * unobservable from here. The resync stays for the reason in DECISIONS 6; it is NOT what this case
 * proves. Do not cite it as the evidence for that line.
 */
test("toggling fullscreen does not move the reader", async ({ page }) => {
  await page.setViewportSize(WIDE);
  // The real fixture session by id: a two-message stub is shorter than the pane and cannot scroll,
  // which would make this measurement pass by having nothing to measure.
  await page.goto("/?project=-fixture-project&session=00000000-fixture-0000-000000000001");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  // A draft, and a reader well up the page: this is the state SPEC 199–182 govern, and the state
  // three of this build's defects were found in.
  await page.locator("#composer-text").fill("a draft that must not move under him");
  // `#transcript-body`, not `#transcript`: the outer section is the column, the body is the
  // scroller — `ui.transcript` in app.ts is this element, and it is the one 182 is written about.
  await page.locator("#transcript-body").evaluate((node) => {
    node.scrollTop = Math.round(node.scrollHeight / 3);
  });
  await page.waitForTimeout(120);
  const before = await page.locator("#transcript-body").evaluate((node) => node.scrollTop);
  expect(before, "the transcript must be scrollable, or there is nothing to hold still").toBeGreaterThan(50);

  await page.locator("#transcript-body").press("f");
  await page.waitForTimeout(200);
  await page.locator("#transcript-body").press("f");
  await page.waitForTimeout(200);

  const after = await page.locator("#transcript-body").evaluate((node) => node.scrollTop);
  // A rewrap at a different width changes what "the same place" means, so this is a band, not an
  // equality — what it catches is the lurch: the composer leaving or entering the flow without its
  // spacer, which moved the reader 1865px when it was last measured.
  expect(Math.abs(after - before), `reader moved from ${before} to ${after}`).toBeLessThan(120);

  await page.locator("#composer-text").fill("");
});

/**
 * The layout must not be able to break the key (SPEC 194).
 *
 * Playwright's `press()` derives `key` from `code`, so it can never produce the mismatch this bug is
 * made of: under ЙЦУКЕН the physical F key arrives as `key: "а"` with `code: "KeyF"`, and a handler
 * reading `key` sees a Cyrillic letter and does nothing. These two cases go through CDP so the
 * browser dispatches exactly what a real Russian layout dispatches.
 *
 * Both fail on the pre-fix client, in opposite directions — the first because nothing happens, and
 * the second because it is the one that has to keep NOT happening.
 */

/** One physical F keypress reported as the Cyrillic letter that layout puts on that key. */
async function pressCyrillicF(page, { text = "а" } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const key = { key: "а", code: "KeyF", windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text, ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await cdp.detach();
}

test("the physical F key toggles fullscreen under a Cyrillic layout", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  const railBefore = await widthOf(page, "#side");
  const drawerBefore = await widthOf(page, "#drawer");
  expect(railBefore, "the rail must be on screen first, or the toggle proves nothing").toBeGreaterThan(100);
  expect(drawerBefore, "the right column must be on screen first").toBeGreaterThan(100);

  await pressCyrillicF(page);

  expect(await widthOf(page, "#side"), "the rail is still taking width — the key was read as a letter").toBe(0);
  expect(await widthOf(page, "#drawer"), "the right column is still taking width").toBe(0);

  await pressCyrillicF(page);

  expect(await widthOf(page, "#side"), "the rail did not come back").toBeCloseTo(railBefore, 0);
  expect(await widthOf(page, "#drawer"), "the right column did not come back").toBeCloseTo(drawerBefore, 0);
});

test("а typed into a task title types the letter and does not toggle", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await openParentRecord(page);

  const title = page.locator("#record-body .task").first().locator(".task-title");
  await title.click();
  const field = page.locator("#record-body .task").first().locator(".task-title-edit");
  await expect(field).toBeVisible();
  const before = await field.inputValue();
  await field.press("End");
  await pressCyrillicF(page);

  expect(await field.inputValue(), "the Cyrillic letter did not reach the field").toBe(`${before}а`);
  expect(
    await widthOf(page, "#side"),
    "a Russian letter typed into a field reorganised the screen — reading the physical key widened the trap",
  ).toBeGreaterThan(100);

  await field.press("Escape"); // leave the fixture record as it was found
});
