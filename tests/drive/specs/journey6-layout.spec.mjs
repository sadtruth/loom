/**
 * The layout fits the window (projects/layout-holds): no pane scrolls sideways, and no pane scrolls
 * further than the thing it is showing. Both defects that opened that project shipped green because
 * every other pin asserts what is ON the screen and never what runs off it.
 *
 * Driven at three real sizes, because a break at 1440×900 is not the same break at 390×844.
 */

import { expect, test } from "@playwright/test";

const SIZES = [
  { name: "laptop", width: 1440, height: 900 },
  { name: "small window", width: 900, height: 700 },
  { name: "phone", width: 390, height: 844 },
];

// Every box that owns a scroll region, plus the strips that must never grow one.
const PANES = ["#layout", "#side", "#opens", "#tree-body", "#transcript-body", "#chat-area", "#composer"];

async function sideways(page) {
  return page.evaluate((selectors) => {
    const over = [];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element || element.offsetParent === null) continue;
      // 1px of slack: sub-pixel layout rounds scrollWidth up on fractional widths.
      if (element.scrollWidth <= element.clientWidth + 1) continue;
      // Name the widest descendant, so the failure says WHICH element pushed the box open — a
      // selector alone sends the reader back into the CSS to guess.
      const edge = element.getBoundingClientRect().left;
      let worst = null;
      for (const node of element.querySelectorAll("*")) {
        const right = node.getBoundingClientRect().right - edge;
        if (worst === null || right > worst.right) {
          worst = { right: Math.round(right), tag: node.tagName.toLowerCase(), cls: node.className || node.id };
        }
      }
      over.push(
        `${selector}: scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth}` +
          (worst ? ` — widest child ${worst.tag}.${worst.cls} ends at ${worst.right}` : ""),
      );
    }
    return over;
  }, PANES);
}

// What a reader sees as empty screen: how far the transcript can still scroll below the last thing
// in it. Some slack is right — the last element should clear the pane's floor — but not screenfuls.
//
// RE-DERIVED 2026-08-12: this measured below the last MESSAGE, and since SPEC 199 the composer is
// the last element of the scroller — so the space between the last message and the composer's own
// bottom is content, not emptiness, and the old bound broke by construction (256 against 88). It
// measures below the lowest element now, which is the number it always meant.
async function slackBelowLastMessage(page) {
  return page.evaluate(() => {
    const body = document.querySelector("#transcript-body");
    const messages = body.querySelectorAll(".msg");
    const last = messages[messages.length - 1];
    if (!last) return null;
    let bottom = 0;
    for (const node of body.children) {
      if (node.hasAttribute("hidden")) continue;
      bottom = Math.max(bottom, node.offsetTop + node.offsetHeight);
    }
    const tail = [...body.children].slice(-3).map((n) => `${n.tagName.toLowerCase()}.${n.className}@${n.offsetTop}+${n.offsetHeight}`);
    return {
      // Measured against the VIEWPORT floor, not the last message: a transcript shorter than the
      // pane leaves empty space no padding caused, and counting that would fail on any short
      // session. What this pins is scrollable emptiness — screen you can travel to and find nothing.
      slack: Math.round(body.scrollHeight - Math.max(bottom, body.clientHeight)),
      viewport: body.clientHeight,
      scrollHeight: body.scrollHeight,
      lastBottom: Math.round(bottom),
      tail,
    };
  });
}

for (const size of SIZES) {
  test(`layout: nothing scrolls sideways at ${size.name} ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/");
    await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
    await expect(page.locator(".msg").first()).toBeVisible();

    // general: the chat row and its session pick, alone in the open list.
    expect(await sideways(page), `general at ${size.width}`).toEqual([]);

    // A record ROW is the hard case — its label is a whole project title, in a 300px column, with
    // the session select under it.
    if (size.width <= 700) await page.locator("#rail-toggle").click(); // the rail slides over the chat here
    // By NAME, not by index: journey5 splits a subproject into the same fixture, so the tree has a
    // different number of rows depending on what ran before this.
    await page.locator(".tree-item", { hasText: "Fixture child project" }).first().click();
    // Entering a project lands on its live session when it has one, so the record may be one click
    // away — the open list is what this test is about either way. Below 900px that list is inside
    // the column that now overlays instead of vanishing (SPEC 188), so it has to be opened first.
    if (size.width <= 900) await page.locator("#drawer-reopen").click();
    await page.locator('.open-row[data-kind="record"]', { hasText: "Fixture child project" }).click();
    await expect(page.locator("#record-body")).toBeVisible();
    expect(await sideways(page), `record tab at ${size.width}`).toEqual([]);
  });
}

// Both sizes, because the phone media query carries its OWN copy of this padding — and it kept the
// 60vh for a whole round after the desktop rule lost it (2026-08-06).
for (const size of [SIZES[0], SIZES[2]]) {
test(`layout: the transcript does not scroll past its last message at ${size.name}`, async ({ page }) => {
  await page.setViewportSize({ width: size.width, height: size.height });
  // The REAL fixture session by id, not whatever "/" lands on: an earlier spec's stub session can be
  // the newest, and a two-message transcript is shorter than the pane — which would make this
  // measurement pass by having nothing to measure.
  await page.goto("/?project=-fixture-project&session=00000000-fixture-0000-000000000001");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();

  const measured = await slackBelowLastMessage(page);
  expect(measured).not.toBeNull();
  expect(measured.scrollHeight, "the fixture must be taller than the pane, or there is nothing to measure").toBeGreaterThan(
    measured.viewport + 200,
  );
  // Was 140 — one composer's worth of clearance, on the reasoning that dead space must not grow with
  // the screen. Then 24, for the round when the clearance lived OUTSIDE the scroller. It is back
  // inside as 64px (56 on a phone), because outside it was a band no text could ever use
  // (2026-08-08) — so this ceiling is 64 + the 24 a seam row below the last `.msg` may add. What
  // this still catches is the thing it was written for: clearance sized as a share of the window.
  // The exact bottom edge — gap at rest, no travel below it, text filling it from up the page — is
  // journey12-scroll's, measured there rather than bounded here.
  expect(measured.slack, `dead space (viewport ${measured.viewport}px, scrollHeight ${measured.scrollHeight}, last ends ${measured.lastBottom}, tail ${JSON.stringify(measured.tail)})`).toBeLessThanOrEqual(88);
});
}
