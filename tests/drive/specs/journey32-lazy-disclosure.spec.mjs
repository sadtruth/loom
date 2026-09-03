/**
 * A closed disclosure costs its summary and nothing else (SPEC 229).
 *
 * The measurement this is written against, 2026-08-20, on a real 179-turn session: the page held
 * 1,100 tool disclosures, NONE of them open, and 2.0MB of the 2.7MB of text on it was inside them.
 * Three quarters of what it cost to draw a session was content nobody had asked to see.
 *
 * The rule is about what is ABSENT, so it is driven rather than asserted in a property: only a real
 * page can say whether a `<details>` the reader has not touched has a body in it. Two-sided, because
 * "nothing is there" is also what a broken renderer produces — the same disclosure must fill the
 * moment it is clicked, and fill exactly once however many times it is toggled.
 *
 * It SWEEPS the transcript rather than reading the first screen, for a reason that is itself a
 * finding: the transcript is windowed now (SPEC 228), so the first screen of a long fixture holds
 * only the handful of disclosures the last turns happen to carry. Sweeping also buys the stronger
 * claim — the rule holds for rows mounted long after the page loaded, not only for the ones the
 * first paint built.
 */

import { expect, test } from "@playwright/test";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

async function live(page) {
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await expect(page.locator(".msg").first()).toBeVisible();
}

/** Both kinds of disclosure on the page right now, and whether any CLOSED one has a body. */
function census() {
  const closed = (sel) => [...document.querySelectorAll(sel)].filter((d) => !d.open);
  return {
    strips: closed("details.steps").length,
    tools: closed("details.tool").length,
    // A run of three or more consecutive calls folds into ONE strip (SPEC 212), and the strip is
    // where most of the weight sits — counting only `details.tool` would report the saving of the
    // few calls that never folded.
    stripBodies: closed("details.steps").filter((d) => d.querySelector(".inner") !== null).length,
    toolBodies: closed("details.tool").filter((d) => d.querySelector("pre") !== null).length,
  };
}

test("disclosures: a closed tool call has no body, wherever in the session it is", async ({ page }) => {
  await page.goto(FIXTURE);
  await live(page);

  let seen = 0;
  let bodies = 0;
  for (let step = 20; step >= 0; step -= 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * (fraction / 20));
    }, step);
    await page.waitForTimeout(120);
    const now = await page.evaluate(census);
    seen += now.strips + now.tools;
    bodies += now.stripBodies + now.toolBodies;
  }

  // The coverage witness. Without it a sweep that found no tool calls at all would report "no
  // bodies" and read as a pass.
  expect(seen, "the sweep must have met closed disclosures, or this proves nothing").toBeGreaterThan(20);
  // THE RULE. Against the build this was written for, every closed disclosure carried its input and
  // its result already built, so `bodies` reads `seen` and this fails on the first sweep step.
  expect(bodies, "not one closed disclosure holds a body").toBe(0);
  console.log(`[lazy] ${String(seen)} closed disclosures met over a full sweep, ${String(bodies)} with a body`);
});

test("disclosures: one fills when it is opened, and only once", async ({ page }) => {
  await page.goto(FIXTURE);
  await live(page);

  // Find a screen that actually has a folded strip ON it — visible, not merely mounted. The
  // transcript is windowed (SPEC 228), so which turns exist at all depends on where the reader is,
  // and the spec asks rather than assumes.
  let box = null;
  for (let step = 20; step >= 0 && box === null; step -= 1) {
    await page.evaluate((fraction) => {
      const body = document.querySelector("#transcript-body");
      body.scrollTop = Math.round(body.scrollHeight * (fraction / 20));
    }, step);
    await page.waitForTimeout(150);
    box = await page.evaluate(() => {
      const view = document.querySelector("#transcript-body").getBoundingClientRect();
      for (const strip of document.querySelectorAll("details.steps")) {
        const summary = strip.querySelector("summary");
        if (summary === null) continue;
        const r = summary.getBoundingClientRect();
        if (r.top >= view.top + 4 && r.bottom <= view.bottom - 4 && r.height > 4) {
          strip.dataset.pinTarget = "1";
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    });
  }
  expect(box, "the fixture must show a folded strip on screen, or this proves nothing").not.toBeNull();
  console.log(`[lazy] clicking a strip summary at ${String(box.x)},${String(box.y)}`);

  const strip = page.locator("details.steps[data-pin-target='1']");
  // Dispatched rather than driven through `locator.click()`, and that is not a detail. A locator
  // click scrolls the element into view first, and a scroll is now a redraw (SPEC 228) — so
  // Playwright scrolls, the window remounts, the node it resolved is replaced, and it starts over
  // until the test times out. The spec has already put the summary on screen itself, above; what is
  // left to drive is the toggle, which is what this dispatches.
  const summary = strip.locator("summary").first();
  await summary.dispatchEvent("click");
  await expect(strip.locator(".inner").first()).toBeVisible();
  const once = await strip.evaluate((node) => node.querySelectorAll(":scope > .inner").length);
  expect(once, "an opened strip has a body").toBe(1);

  // `toggle` fires on every open, so a fill without a latch appends the body again each time —
  // which is nearly invisible on screen (the second copy is below the first) and doubles the text.
  for (let i = 0; i < 4; i += 1) {
    await summary.dispatchEvent("click");
    await page.waitForTimeout(80);
  }
  const after = await strip.evaluate((node) => node.querySelectorAll(":scope > .inner").length);
  expect(after, "the body is built once, however many times it is toggled").toBe(once);
});
