/**
 * A frame stops chasing its own height (SPEC 214).
 *
 * User, 2026-08-14, on a session that had been FINISHED for four hours: *"this session is still
 * constantly moving and shifting"*. Nothing was redrawing it. One embedded prototype was measuring
 * itself against the height loom had just given it: a document whose root is `height:100%` has no
 * height of its own, so `scrollHeight` returns the frame's height — and loom's own stylesheet
 * (`* { box-sizing: border-box }` plus the frame's 1px border) makes the document's viewport two
 * pixels shorter than whatever is written to it. Every adopted report produced the next one, 2px
 * smaller. Measured on the live build: 361 reports, 938 → 218, ~112px/s, and again on every load.
 *
 * Four frames in the fixture, four ways this can go wrong. The two-sided half is case 4: a page that
 * honestly grows must still be followed, or "it stopped moving" was bought by making prototypes dead.
 */

import { expect, test } from "@playwright/test";

/** The fences of the parent record's frame message, in the order `make-fixture.ts` writes them. */
const FILLS_DECLARED = 2;
const FILLS_BARE = 3;
const GROWS_FOREVER = 4;
const GROWS_ON_CLICK = 5;
const HONEST = 0;

function watchConsole(page) {
  const lines = [];
  page.on("console", (message) => lines.push(message.text()));
  page.on("pageerror", (error) => lines.push(`pageerror: ${error.message}`));
  return lines;
}

async function openTheFrames(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("live", { timeout: 20_000 });
  await page.locator(".tree-item", { hasText: "Fixture parent project" }).first().click();
  await expect(page.locator("#chat-area")).toBeVisible();
  await expect(page.locator(".rich-iframe iframe").first()).toBeVisible({ timeout: 20_000 });
}

/**
 * The frame of one fence, scrolled into view first: Chrome throttles rendering in an offscreen
 * iframe, so a runaway that is violent on screen only creeps when nobody is looking at it — and a
 * pin that never looks would time its own defect out of existence.
 */
async function frameAt(page, index) {
  const frame = page.locator(".rich-iframe").nth(index).locator("iframe");
  await frame.scrollIntoViewIfNeeded();
  await expect(frame).toBeVisible({ timeout: 20_000 });
  return frame;
}

/**
 * A frame's height, with the frame scrolled back into view FIRST. Scrolling it in once at the start
 * is not enough: the other eight frames in this record are still settling, and every one of them
 * that changes height scrolls this one out from under the test — at which point Chrome throttles the
 * offscreen iframe, its `ResizeObserver` stops firing, and a growth it should have reported never
 * arrives. That is one assertion reading a stalled number, not a slow one. It cost three separate
 * red runs here, always at exactly the pre-click height and always with NO freeze in the console,
 * which is what ruled the client out (2026-08-15).
 */
async function heightOf(frame) {
  await frame.scrollIntoViewIfNeeded();
  return frame.evaluate((el) => el.offsetHeight);
}

/** Its height once two readings 600ms apart agree — or the last one, if it never stops moving. */
async function settled(page, frame, tries = 12) {
  let last = -1;
  for (let n = 0; n < tries; n += 1) {
    const first = await heightOf(frame);
    await page.waitForTimeout(600);
    last = await heightOf(frame);
    if (first === last) return last;
  }
  return last;
}

test("a page that fills its window keeps the height its fence declared", async ({ page }) => {
  const console_ = watchConsole(page);
  await openTheFrames(page);
  const frame = await frameAt(page, FILLS_DECLARED);

  const height = await settled(page, frame);
  expect(height, "the fence said 620 and the document has no opinion of its own").toBe(620);

  // The collapse took six seconds on the real build. Three more, watching, after it settled.
  await page.waitForTimeout(3000);
  expect(await heightOf(frame), "and it is still there three seconds later").toBe(620);
  expect(console_.filter((line) => line.includes("pageerror"))).toEqual([]);
});

test("a page that fills its window and declares nothing gets a slab, not the placeholder", async ({ page }) => {
  await openTheFrames(page);
  const frame = await frameAt(page, FILLS_BARE);

  // 60% of the pane, 360–720. Computed from the live pane rather than hard-coded, because the slab
  // is a share of the window on purpose — the same prototype is read on a phone.
  const want = await page.evaluate(() => {
    const pane = document.querySelector("#transcript-body");
    const room = pane !== null && pane.clientHeight > 0 ? pane.clientHeight : window.innerHeight;
    return Math.min(720, Math.max(360, Math.round(room * 0.6)));
  });

  expect(await settled(page, frame), "a readable slab, not the 360px placeholder it starts at").toBe(want);
  expect(want, "and the slab is not the placeholder by coincidence").toBeGreaterThan(360);
});

test("a page that reports more than it was given is stopped and named", async ({ page }) => {
  const console_ = watchConsole(page);
  await openTheFrames(page);
  const frame = await frameAt(page, GROWS_FOREVER);

  // 40px per round trip at ~18 round trips a second: unstopped, this is thousands of pixels by now.
  await page.waitForTimeout(4000);
  const height = await heightOf(frame);
  expect(height, "the frame is held near where it started, not walked to the 50 000px ceiling").toBeLessThan(900);

  expect(
    console_.filter((line) => line.includes("keeps resizing its own frame")).join(" | "),
    "and the framed page is named, because the fix is inside it",
  ).toContain("fixture-grows-forever-2026-08-14.html");
});

test("an honest page that grows when he clicks it is still followed", async ({ page }) => {
  await openTheFrames(page);
  const frame = await frameAt(page, GROWS_ON_CLICK);

  const before = await settled(page, frame);
  expect(before, "an honest short page gets its own height, well under the placeholder").toBeLessThan(360);

  await page.locator(".rich-iframe").nth(GROWS_ON_CLICK).frameLocator("iframe").locator("#go").click();

  await expect.poll(() => heightOf(frame), { timeout: 10_000 }).toBeGreaterThan(before + 250);
});

test("a normal prototype still gets its own document's height", async ({ page }) => {
  await openTheFrames(page);
  const frame = await frameAt(page, HONEST);

  const height = await settled(page, frame);
  expect(height, "one paragraph is nowhere near the 200 its fence starts it at").toBeLessThan(200);
  expect(height, "but it is a real height, measured from the document").toBeGreaterThan(0);
});
