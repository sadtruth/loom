/**
 * The image viewer (projects/reading-surface/image-zoom · SPEC §117/§118).
 *
 * User, verbatim: "add image zoom in chat so i can zoom into image by clicking and then like in
 * regular image viewing apps i can zoom even further by scrolling, and pan by dragging" — and, asked
 * whether the phone counted: "phone too".
 *
 * What makes this pin worth its runtime is the ANCHOR assertion. A viewer that scales about the
 * middle of the screen looks perfectly correct in a screenshot and in any "did the scale grow?"
 * test; it is only wrong as a relationship — the thing you pointed at slid away. So the pin computes
 * the image coordinate under the cursor before and after the wheel and requires it unchanged, AND
 * requires the resulting offset to differ from what a centre-zoom would have produced. One-sided,
 * either half alone passes on the defect.
 *
 * Driven at both real sizes, because "phone too" was half the ask: 1440×900 with wheel and mouse
 * drag, 390×844 with genuine two-finger touch dispatched over CDP (`Input.dispatchTouchEvent`
 * produces TRUSTED events; `page.touchscreen` cannot express a pinch at all).
 */

import { expect, test } from "@playwright/test";
import { bring } from "../reveal.mjs";

const FIXTURE = "/?project=-fixture-project&session=00000000-fixture-0000-000000000001";

/** The fixture image's real dimensions — the pin is meaningless against something that fits anyway. */
const NAT_W = 2400;
const NAT_H = 1400;

/** The viewer's state, read off the attributes it writes from the view it actually applied. */
async function viewOf(page) {
  return page.evaluate(() => {
    const root = document.querySelector("#zoom");
    const img = document.querySelector("#zoom-img");
    return {
      open: root !== null && !root.hidden,
      s: Number(root?.dataset.scale),
      x: Number(root?.dataset.x),
      y: Number(root?.dataset.y),
      natW: img?.naturalWidth ?? 0,
      natH: img?.naturalHeight ?? 0,
      rect: img?.getBoundingClientRect().toJSON() ?? null,
    };
  });
}

/** Where a window point sits in the image's own pixels. The quantity an anchored zoom preserves. */
const toImage = (view, px, py) => ({ ix: (px - view.x) / view.s, iy: (py - view.y) / view.s });

async function openSession(page) {
  await page.goto(FIXTURE);
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("the image viewer at 1440×900", () => {
  test("click opens it at fit, the wheel zooms where the cursor is, and a drag pans", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openSession(page);

    // ── open ────────────────────────────────────────────────────────────
    // The transcript is windowed (SPEC 228), so the pasted image is not a node until the reader
    // reaches it. Scrolling to it is what a reader does; `scrollIntoViewIfNeeded` cannot scroll to
    // something that has not been built.
    const inlineAt = await bring(page, ".msg-image.zoomable");
    expect(inlineAt, "the fixture's pasted image is reachable").not.toBeNull();
    const inline = page.locator(".msg-image.zoomable").first();
    await expect(inline).toBeVisible();
    // The inline cap is exactly the problem this project exists for: 560px of an 800px screenshot.
    const inlineBox = await inline.boundingBox();
    expect(inlineBox.width).toBeLessThanOrEqual(561);

    await page.mouse.click(inlineAt.x, inlineAt.y);
    const overlay = page.locator("#zoom");
    await expect(overlay).toBeVisible();

    const rest = await viewOf(page);
    expect(rest.natW, "the fixture image must have real dimensions or this pin proves nothing").toBe(NAT_W);
    expect(rest.natH).toBe(NAT_H);
    expect(rest.s).toBeCloseTo(1, 3);
    // Fit means bigger than the inline cap, and inside the window.
    expect(rest.rect.width).toBeGreaterThan(inlineBox.width);
    expect(rest.rect.width).toBeLessThanOrEqual(1441);
    expect(rest.rect.height).toBeLessThanOrEqual(901);

    // ── the wheel zooms about the pointer, not the middle ────────────────
    // Deliberately far from centre on both axes; against the window centre (720, 450) a centre-zoom
    // and an anchored zoom give visibly different offsets, which is what makes the check two-sided.
    const AX = 380;
    const AY = 280;
    const under = toImage(rest, AX, AY);

    await page.mouse.move(AX, AY);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await viewOf(page)).s).toBeGreaterThan(1.5);

    const zoomed = await viewOf(page);
    const after = toImage(zoomed, AX, AY);
    expect(after.ix, "the image point under the cursor moved — the zoom is not anchored").toBeCloseTo(under.ix, 0);
    expect(after.iy).toBeCloseTo(under.iy, 0);

    // …and it is genuinely not the centre-zoom answer. If it were, this offset would match.
    const k = zoomed.s / rest.s;
    const centreX = 720 - (720 - rest.x) * k;
    expect(
      Math.abs(zoomed.x - centreX),
      "anchored and centre-zoom agree here, so the assertion above proves nothing",
    ).toBeGreaterThan(20);

    // ── drag pans ────────────────────────────────────────────────────────
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(560, 380, { steps: 8 });
    await page.mouse.up();
    const panned = await viewOf(page);
    expect(panned.s, "a drag must not change the scale").toBeCloseTo(zoomed.s, 3);
    expect(panned.x).toBeLessThan(zoomed.x);
    expect(panned.y).toBeLessThan(zoomed.y);

    // Bounded: however hard it is dragged, the image still covers the window it is bigger than.
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(60, 40, { steps: 4 });
    await page.mouse.move(20, 20, { steps: 4 });
    await page.mouse.up();
    const shoved = await viewOf(page);
    expect(shoved.rect.x).toBeLessThanOrEqual(1);
    expect(shoved.rect.x + shoved.rect.width).toBeGreaterThanOrEqual(1439);

    // ── back to fit, and locked there ────────────────────────────────────
    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, 3000);
    await expect.poll(async () => (await viewOf(page)).s).toBeCloseTo(1, 2);
    const fit = await viewOf(page);
    await page.mouse.move(700, 450);
    await page.mouse.down();
    await page.mouse.move(300, 200, { steps: 6 });
    await page.mouse.up();
    const stillFit = await viewOf(page);
    expect(stillFit.x, "at fit there is nothing to pan to").toBeCloseTo(fit.x, 1);
    expect(stillFit.y).toBeCloseTo(fit.y, 1);

    // ── Escape closes, and the transcript underneath is still usable ─────
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    await page.locator("#transcript-body").evaluate((node) => node.scrollBy(0, -300));
    await expect(page.locator(".msg").first()).toBeVisible();
    // 300px of scrolling can take the image out of the window (SPEC 228) — the reader would scroll
    // back to it, and so does this.
    const inlineAgain = await bring(page, ".msg-image.zoomable");
    expect(inlineAgain, "the image is reachable again").not.toBeNull();
    await page.mouse.click(inlineAgain.x, inlineAgain.y);
    await expect(overlay).toBeVisible();
    await page.locator("#zoom-close").click();
    await expect(overlay).toBeHidden();

    expect(errors, "the viewer must not raise page errors").toEqual([]);
  });

  test("all three render sites open the same viewer", async ({ page }) => {
    await openSession(page);
    const overlay = page.locator("#zoom");

    // 1 · a pasted image in the transcript
    const inlineAt = await bring(page, ".msg-image.zoomable");
    expect(inlineAt, "the fixture's pasted image is reachable").not.toBeNull();
    await page.mouse.click(inlineAt.x, inlineAt.y);
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();

    // 2 · a tile in a grid block
    // The TILE, not the block around it: the centre of a two-figure grid is the gap between the
    // figures, and a click there lands on nothing. It used to reach the block and click the tile by
    // locator, which scrolled first — and under a windowed transcript (SPEC 228) a scroll is a
    // redraw, so the node the locator resolved was gone before the click.
    const tileAt = await bring(page, ".rich-grid img.zoomable");
    expect(tileAt, "the fixture's image grid is reachable").not.toBeNull();
    await page.mouse.click(tileAt.x, tileAt.y);
    await expect(overlay).toBeVisible();
    expect((await viewOf(page)).natW).toBe(NAT_W);
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();

    // 3 · the file pane, reached through a path chip pointing at the same png
    const chipAt = await bring(page, '.chip[data-path$="/shot-a.png"]');
    expect(chipAt, "the file chip is reachable").not.toBeNull();
    const chip = page.locator('.chip[data-path$="/shot-a.png"]').first();
    await page.mouse.click(chipAt.x, chipAt.y);
    const paneImage = page.locator(".file-image.zoomable");
    await expect(paneImage).toBeVisible({ timeout: 10_000 });
    await paneImage.click();
    await expect(overlay).toBeVisible();
    expect((await viewOf(page)).natW).toBe(NAT_W);
    await page.keyboard.press("Escape");
    await expect(overlay).toBeHidden();
    // Escape was swallowed by the viewer, so the pane it was opened from is still there.
    await expect(paneImage).toBeVisible();
  });
});

test.describe("the image viewer at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("tap opens it, two fingers zoom where they are, one finger pans, a tap outside closes", async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await openSession(page);

    // CDP, not `page.touchscreen`: a pinch is two simultaneous touch points, which the Playwright
    // API cannot express, and these events arrive TRUSTED rather than synthesised in the page.
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, points) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: points.map(([x, y], index) => ({ x, y, id: index + 1, radiusX: 6, radiusY: 6, force: 1 })),
      });

    // The transcript is windowed (SPEC 228), so the pasted image is not a node until the reader
    // reaches it. Scrolling to it is what a reader does; `scrollIntoViewIfNeeded` cannot scroll to
    // something that has not been built.
    const inlineAt = await bring(page, ".msg-image.zoomable");
    expect(inlineAt, "the fixture's pasted image is reachable").not.toBeNull();
    const inline = page.locator(".msg-image.zoomable").first();
    await page.touchscreen.tap(inlineAt.x, inlineAt.y);
    const overlay = page.locator("#zoom");
    await expect(overlay).toBeVisible();

    const rest = await viewOf(page);
    expect(rest.s).toBeCloseTo(1, 3);
    // 2400×1400 into a 390-wide window: fit is a real reduction, so there is something to zoom into.
    expect(rest.rect.width).toBeLessThanOrEqual(391);

    // ── pinch out, off-centre, and check the anchor the same way ─────────
    // Off-centre horizontally, but vertically near the middle of the PICTURE (which rests at
    // y 308–536 in a 844-tall window). Anchor close to an edge instead and the bound correctly
    // wins over the anchor — there is nothing above the top of an image to pan to — so the
    // assertion below would be measuring the clamp rather than the anchoring.
    const AX = 150;
    const AY = 422;
    const under = toImage(rest, AX, AY);
    // Fingers 80px apart, opened to 420: a factor of 5.25, enough that the image is taller than the
    // window too, so BOTH axes are free and the anchor — not the centring clamp — decides them.
    await touch("touchStart", [
      [AX - 40, AY],
      [AX + 40, AY],
    ]);
    for (const spread of [70, 110, 160, 210]) {
      await touch("touchMove", [
        [AX - spread, AY],
        [AX + spread, AY],
      ]);
    }
    await touch("touchEnd", []);

    // The FULL factor, not merely "bigger". Polling for a low bar returns mid-gesture, while touch
    // events are still arriving, and then reads a view that is nobody's final answer (2026-08-08).
    await expect.poll(async () => (await viewOf(page)).s).toBeGreaterThan(5);
    const zoomed = await viewOf(page);
    expect(zoomed.rect.height, "the image must be taller than the window or the y anchor is moot").toBeGreaterThan(844);
    const after = toImage(zoomed, AX, AY);
    expect(after.ix, "the pinch is not anchored to the fingers").toBeCloseTo(under.ix, 0);
    expect(after.iy).toBeCloseTo(under.iy, 0);

    // ── one finger pans ──────────────────────────────────────────────────
    await touch("touchStart", [[200, 500]]);
    await touch("touchMove", [[170, 430]]);
    await touch("touchMove", [[120, 380]]);
    await touch("touchEnd", []);
    const panned = await viewOf(page);
    expect(panned.s, "a drag must not change the scale").toBeCloseTo(zoomed.s, 2);
    expect(panned.x).toBeLessThan(zoomed.x);

    // The image still covers the phone window it is wider than — nothing dragged off into space.
    expect(panned.rect.x).toBeLessThanOrEqual(1);
    expect(panned.rect.x + panned.rect.width).toBeGreaterThanOrEqual(389);

    // The close button is a real target at this size, not a 20px dot.
    const closeBox = await page.locator("#zoom-close").boundingBox();
    expect(Math.min(closeBox.width, closeBox.height)).toBeGreaterThanOrEqual(40);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(390);

    // ── the way out while zoomed in is the button ────────────────────────
    // Zoomed this far the picture covers the whole window, so there is no backdrop left to tap —
    // and a tap on the image must NOT close, or every pan would end by dismissing the thing being
    // panned. The × is why that is safe rather than a trap.
    await touch("touchStart", [[195, 500]]);
    await touch("touchEnd", []);
    await expect(overlay, "a tap on the zoomed image closed the viewer").toBeVisible();
    await page.locator("#zoom-close").tap();
    await expect(overlay).toBeHidden();

    // ── the tap that closed it must not re-open it (zoom.ts, the tap guard) ──
    // A tap closes on `pointerup`, and Chromium sends the synthesised CLICK afterwards — by which
    // time the overlay is gone, so that click lands on whatever is under the point in the page.
    // With the composer inside the scroller (SPEC 199) the transcript's own image can sit under the
    // ×, and the opener then re-opens the viewer the tap just closed. Waited out rather than
    // asserted in the same tick: the click arrives after the touch, so an immediate check passes on
    // a build with no guard at all.
    await page.waitForTimeout(400);
    await expect(overlay, "the click synthesised from the closing tap must not re-open it").toBeHidden();

    // ── at fit, a tap that goes nowhere beside the picture gives the page back ─
    // Straight after a close, which is the guard's other half: it matches the closing POINT as well
    // as the moment, so a deliberate tap on the image still opens the viewer. A guard on time alone
    // would make this line fail, which is why it is not one.
    // FOUND WHERE IT IS NOW, not where it was at the top of this test. A tap that closes the viewer
    // sends its synthesised click to whatever is under the point once the overlay has gone — and
    // 800px down a 844px window is where the write pill sits when the reader is a long way from the
    // composer, which under a windowed transcript (SPEC 228) is exactly where `bring` has left them.
    // The pill scrolls the composer into view and the picture is 3,200px away by the next tap
    // (measured 2026-08-23). A reader looks at where the image IS; so does this.
    const openAgainAt = await bring(page, ".msg-image.zoomable");
    expect(openAgainAt, "the picture is reachable again").not.toBeNull();
    await page.touchscreen.tap(openAgainAt.x, openAgainAt.y);
    await expect(overlay).toBeVisible();
    const reopened = await viewOf(page);
    expect(reopened.s, "reopening must start at fit, not where the last view was left").toBeCloseTo(1, 3);
    // 800 is below the picture, which rests at y 308–536 in this window.
    await touch("touchStart", [[195, 800]]);
    await touch("touchEnd", []);
    await expect(overlay).toBeHidden();

    // …and a DRAG must not be mistaken for that tap: reopen, drag, release on the backdrop.
    // FOUND WHERE IT IS NOW, not where it was at the top of this test. A tap that closes the viewer
    // sends its synthesised click to whatever is under the point once the overlay has gone — and
    // 800px down a 844px window is where the write pill sits when the reader is a long way from the
    // composer, which under a windowed transcript (SPEC 228) is exactly where `bring` has left them.
    // The pill scrolls the composer into view and the picture is 3,200px away by the next tap
    // (measured 2026-08-23). A reader looks at where the image IS; so does this.
    const dragFromAt = await bring(page, ".msg-image.zoomable");
    expect(dragFromAt, "the picture is reachable a third time").not.toBeNull();
    await page.touchscreen.tap(dragFromAt.x, dragFromAt.y);
    await expect(overlay).toBeVisible();
    await touch("touchStart", [[195, 700]]);
    await touch("touchMove", [[195, 640]]);
    await touch("touchMove", [[195, 800]]);
    await touch("touchEnd", []);
    await expect(overlay, "a drag ending on the backdrop closed the viewer").toBeVisible();

    expect(errors).toEqual([]);
  });
});
