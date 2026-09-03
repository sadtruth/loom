/**
 * P27 — a core is chosen per TAB, and two tabs do not fight (item 50).
 *
 * User: *"i should be able to have several tabs of loom in various cores and projects focused
 * without any problem running in parallel"*. The defect this pins is not "the selector does not
 * work" — it is a selector whose choice is stored per DEVICE, which looks perfect in one tab and
 * silently drags the other one with it.
 *
 * Driven in two independent CONTEXTS rather than two pages of one, because two pages of one share
 * a profile — and a shared profile is precisely where a per-device store would hide.
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

const live = async (page) => {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
};

test("the selector sits where the title was, and says how many it is showing", async ({ page }) => {
  const errors = watchErrors(page);
  await live(page);

  const select = page.locator("#core-select");
  await expect(select).toBeVisible();
  // It REPLACED the rail's heading rather than being added beside it. Scoped to the header that
  // holds the selector — the other panes keep their own titles, and asserting globally only
  // measured how many panes exist.
  const railHead = page.locator(".pane-head", { has: page.locator("#core-select") });
  await expect(railHead.locator(".pane-title")).toHaveCount(0);

  // "All projects" is always offered, and the count matches what the tree is actually drawing.
  await expect(select.locator("option", { hasText: "All projects" })).toHaveCount(1);
  const shown = Number(await page.locator("#core-count").textContent());
  expect(shown).toBe(await page.locator(".tree-item").count());

  expect(errors, errors.join("\n")).toEqual([]);
});

test("a core with no vault is listed and cannot be chosen", async ({ page }) => {
  await live(page);
  // Listed, because hiding it would say nothing about why it is missing; disabled, because choosing
  // it could only offer an empty tree and a session with no rules to load.
  const unusable = page.locator("#core-select option[disabled]");
  if ((await unusable.count()) > 0) {
    await expect(unusable.first()).toContainText("no vault yet");
  }
});

test("the chosen core rides in the address and survives a reload", async ({ page }) => {
  await live(page);
  const select = page.locator("#core-select");
  const values = await select.locator("option:not([disabled])").evaluateAll((os) =>
    os.map((o) => o.value).filter((v) => v.length > 0),
  );
  test.skip(values.length === 0, "no usable core in this fixture");
  const core = values[0];

  await select.selectOption(core);
  await expect(page).toHaveURL(new RegExp(`core=${core}`));

  await page.reload();
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(select).toHaveValue(core);
});

test("two tabs in two cores leave each other alone", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pageA = await a.newPage();
    const pageB = await b.newPage();
    const errorsA = watchErrors(pageA);
    const errorsB = watchErrors(pageB);
    await live(pageA);
    await live(pageB);

    const values = await pageA
      .locator("#core-select option:not([disabled])")
      .evaluateAll((os) => os.map((o) => o.value).filter((v) => v.length > 0));
    test.skip(values.length === 0, "no usable core in this fixture");
    const core = values[0];

    // What A looks like before B touches anything.
    const beforeRows = await pageA.locator(".tree-item").allTextContents();
    const beforeUrl = pageA.url();
    const beforeCount = await pageA.locator("#core-count").textContent();

    // B moves, and keeps its own address.
    await pageB.locator("#core-select").selectOption(core);
    await expect(pageB).toHaveURL(new RegExp(`core=${core}`));

    // A has not moved: not its rows, not its address, not its count. Reloading A proves the choice
    // was never written anywhere A would read on the way back up.
    expect(pageA.url()).toBe(beforeUrl);
    expect(await pageA.locator(".tree-item").allTextContents()).toEqual(beforeRows);
    expect(await pageA.locator("#core-count").textContent()).toBe(beforeCount);

    await pageA.reload();
    await expect(pageA.locator("#status")).toContainText("live", { timeout: 20_000 });
    expect(pageA.url()).toBe(beforeUrl);
    await expect(pageA.locator("#core-select")).toHaveValue("");

    expect(errorsA, errorsA.join("\n")).toEqual([]);
    expect(errorsB, errorsB.join("\n")).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});
